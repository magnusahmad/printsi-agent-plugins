import { Buffer } from "node:buffer";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { AppError, BRAND, type Envelope, type NextAction } from "@internal/core";
import { isFileId, uploadBytes } from "./check.js";
import { COMMANDS, type Command, type FlagSpec } from "./commands.js";
import { request } from "./http.js";
import { run, runCommand } from "./main.js";
import { CLI_VERSION, resolveSettings, type Settings } from "./settings.js";

/**
 * `printsi mcp`: the CLI's commands as Model Context Protocol tools over stdio (spec 01 §7.21), for agent hosts such
 * as Hermes. Each tool call is turned into the same arguments the CLI takes and run through the same code, so a tool
 * behaves exactly like its command and returns the same envelope. No runtime dependencies: newline-delimited JSON-RPC.
 *
 * - A tool is annotated read-only only when it sends nothing of the user's off the machine and writes nothing a
 *   caller chose: hosts run read-only tools without asking. `check` (uploads the PDF), `address_validate` and
 *   `pickup_points` (send the address) are therefore not read-only. `order_purchase` and `order_cancel` are
 *   destructive. Buying never spends money by itself: it returns a link the person pays on.
 * - A tool argument never names a file to read or a folder to write, except the PDF to check or print: `ship_to`
 *   is an address object (the CLI's file and stdin forms are refused here), and `check` saves its previews to a
 *   temp folder of its own (`preview_dir` is not a tool argument).
 * - Nothing blocks on a person: `order_wait` is capped at 120 s and returns the current status.
 * - Every tool has an input schema (required arguments from the CLI's own flag specs) and an output schema (the
 *   envelope). Results carry the envelope as `structuredContent` and a readable summary as text.
 * - Next actions are returned only when a tool can run them, with arguments already in that tool's names.
 * - Credentials live in PRINTSI_CONFIG_DIR (a host should give each profile its own). No update notices.
 *
 * The API serves the same tools at POST /mcp (apps/api/src/routes/mcp.ts) by passing a RemoteHost. There the commands
 * run inside the API, with no disk and no machine of the user's, so three things differ:
 * - A PDF is an https URL the API downloads (or the id of a file it already holds), never a path.
 * - The caller's key comes with each request. Nothing is saved, and no guest is made on the caller's behalf: only
 *   the catalogue tools work without a key.
 * - Check previews are attached as images straight from the API; nothing is written anywhere.
 */

/** What the hosted endpoint supplies. */
export interface RemoteHost {
  /** Reaches the API in-process. */
  fetch: typeof fetch;
  /** Fetches a PDF from a URL the caller gave. */
  download: (url: string) => Promise<Response>;
  /** Client header on the API calls made for the caller. */
  client: string;
  /** Version reported as the server's. */
  version: string;
}

export interface McpOptions {
  sandbox: boolean;
  vars: Record<string, string | undefined>;
  remote?: RemoteHost;
}

/** Tools the hosted endpoint runs without a key: they read the catalogue and nothing else. */
const PUBLIC_TOOLS = new Set(["capabilities", "products_list", "products_show"]);
/** Largest PDF the hosted endpoint downloads from a URL; it is held in memory while it is checked and stored. */
export const MAX_REMOTE_PDF_BYTES = 32 * 1024 * 1024;

/** A next action as a host sees it: `tool` names the MCP tool to call with `args`. */
type McpNextAction = NextAction & { tool?: string };

/** Protocol versions this server speaks, newest first. 2026-07-28 is stateless: no initialize, `server/discover`. */
const PROTOCOLS = ["2026-07-28", "2025-11-25", "2025-06-18"] as const;
const MAX_WAIT_S = 120;
const TOOLS_TTL_MS = 3_600_000;

interface ToolDef {
  name: string;
  command: Command;
  readOnly: boolean;
  destructive: boolean;
}

/** Which commands become tools, and how they behave. */
const TOOLS: { path: string[]; readOnly: boolean; destructive?: boolean }[] = [
  { path: ["capabilities"], readOnly: true },
  { path: ["products", "list"], readOnly: true },
  { path: ["products", "show"], readOnly: true },
  { path: ["check"], readOnly: false },
  { path: ["address", "validate"], readOnly: false },
  { path: ["pickup-points"], readOnly: false },
  { path: ["order", "create"], readOnly: false },
  { path: ["order", "update"], readOnly: false },
  { path: ["order", "quote"], readOnly: false },
  { path: ["order", "purchase"], readOnly: false, destructive: true },
  { path: ["order", "show"], readOnly: true },
  { path: ["order", "list"], readOnly: true },
  { path: ["order", "wait"], readOnly: true },
  { path: ["order", "events"], readOnly: true },
  { path: ["order", "cancel"], readOnly: false, destructive: true },
  { path: ["ticket", "create"], readOnly: false },
  { path: ["ticket", "show"], readOnly: true },
  { path: ["ticket", "list"], readOnly: true },
  { path: ["feedback"], readOnly: false },
];

export function toolDefs(): ToolDef[] {
  return TOOLS.flatMap((t) => {
    const command = COMMANDS.find((c) => c.path.join(" ") === t.path.join(" "));
    return command
      ? [
          {
            name: t.path.join("_").replace(/-/g, "_"),
            command,
            readOnly: t.readOnly,
            destructive: t.destructive ?? false,
          },
        ]
      : [];
  });
}

/** CLI flags that are not tool arguments: they name a place on disk for the tool to write to. */
const CLI_ONLY_FLAGS = new Set(["preview-dir"]);
const toolFlags = (command: Command) => Object.entries(command.flags).filter(([name]) => !CLI_ONLY_FLAGS.has(name));

/** Argument name a flag takes as an MCP tool argument: snake_case. */
const mcpName = (name: string) => name.replace(/-/g, "_");

/** Input schema property for one flag. Paths are strings only; ship-to is an address object. */
function propertyFor(_name: string, f: FlagSpec): Record<string, unknown> {
  if (f.type === "boolean") return { type: "boolean", description: f.description };
  if (f.multiple) return { type: "array", items: { type: "string" }, description: f.description };
  if (f.valueName === "address")
    return {
      type: "object",
      description: `${f.description} As an object: US {name, line1, city, state, postal_code}; Hong Kong {name, line1, district, area, phone, email, country: "HK"}.`,
      additionalProperties: true,
    };
  if (f.valueName === "pdf" || f.valueName === "dir") return { type: "string", description: f.description };
  return { type: ["string", "number"], description: f.description };
}

/** The envelope as an output schema: every tool returns this shape, with the data's own shape left open. */
const ENVELOPE_SCHEMA = {
  type: "object",
  properties: {
    ok: { type: "boolean" },
    summary: { type: "string" },
    data: {},
    error: {
      type: "object",
      properties: {
        type: { type: "string" },
        code: { type: "string" },
        message: { type: "string" },
        retryable: { type: "boolean" },
        param: { type: "string" },
        details: { type: "object" },
      },
      required: ["type", "code", "message", "retryable"],
    },
    next_actions: { type: "array", items: { type: "object" } },
    warnings: { type: "array", items: { type: "object" } },
  },
  required: ["ok", "next_actions"],
};

/** How a PDF argument is described on the hosted endpoint, where there is no path to give. */
const remotePdf = (description: string) =>
  `${description.replace(/^Path to the /, "The ").replace(/\.$/, "")}, as an https URL it can be downloaded from (at most ${MAX_REMOTE_PDF_BYTES / 1024 / 1024} MB), or the id (fil_…) of a file sent before.`;

/** Arguments of a tool that name a PDF. */
const pdfArgs = (command: Command) => [
  ...command.positionals.filter((p) => p.name === "pdf").map((p) => p.name),
  ...toolFlags(command).flatMap(([name, f]) => (f.valueName === "pdf" ? [mcpName(name)] : [])),
];

/** The MCP tool listing: one input property per positional and flag, all described from the CLI's own help. */
export function listTools(remote = false) {
  return toolDefs().map((t) => {
    const properties: Record<string, { description?: string } & Record<string, unknown>> = {};
    const required: string[] = [];
    for (const p of t.command.positionals) {
      properties[p.name] = { type: "string", description: p.description };
      if (p.required) required.push(p.name);
    }
    for (const [name, f] of toolFlags(t.command)) {
      properties[mcpName(name)] = propertyFor(name, f);
      if (f.required) required.push(mcpName(name));
    }
    if (remote) {
      for (const name of pdfArgs(t.command)) {
        const property = properties[name];
        if (property) property.description = remotePdf(property.description ?? "PDF.");
      }
    }
    if (t.name === "order_wait") {
      properties.timeout = { type: "number", description: `Seconds to wait, at most ${MAX_WAIT_S} (default 25).` };
    }
    return {
      name: t.name,
      description: t.command.summary,
      inputSchema: { type: "object", properties, required, additionalProperties: false },
      outputSchema: ENVELOPE_SCHEMA,
      annotations: {
        readOnlyHint: t.readOnly,
        destructiveHint: t.destructive,
        idempotentHint: t.readOnly,
        openWorldHint: true,
      },
    };
  });
}

/** Turns tool arguments into the same command's flags and positionals, with the values the CLI's parser would give. */
export function toInput(tool: ToolDef, args: Record<string, unknown>, sandbox: boolean) {
  const flags: Record<string, string | boolean | string[]> = {};
  for (const [name, f] of toolFlags(tool.command)) {
    const v = args[mcpName(name)] ?? args[name];
    if (v === undefined || v === null || v === false) continue;
    if (f.type === "boolean") flags[name] = true;
    else if (Array.isArray(v)) flags[name] = v.map(String);
    else flags[name] = typeof v === "object" ? JSON.stringify(v) : String(v);
  }
  if (tool.name === "order_wait") {
    const want = Number(args.timeout ?? 25);
    flags.timeout = String(Math.min(Math.max(Number.isFinite(want) ? want : 25, 1), MAX_WAIT_S));
  }
  if (sandbox) flags.sandbox = true;
  flags.format = "json";
  const positionals = tool.command.positionals.flatMap((p) => {
    const v = args[p.name];
    return v !== undefined && v !== null ? [String(v)] : [];
  });
  return { flags, positionals };
}

/** Turns tool arguments into CLI arguments for the same command. */
export function toArgv(tool: ToolDef, args: Record<string, unknown>, sandbox: boolean): string[] {
  const { flags, positionals } = toInput(tool, args, sandbox);
  const argv = [...tool.command.path];
  for (const [name, v] of Object.entries(flags)) {
    if (v === true) argv.push(`--${name}`);
    else if (Array.isArray(v)) for (const item of v) argv.push(`--${name}`, item);
    else argv.push(`--${name}`, String(v));
  }
  // Positionals last, after "--": a value that starts with "-" can never be read as a flag.
  if (positionals.length > 0) argv.push("--", ...positionals);
  return argv;
}

/** camelCase or kebab-case key → the snake_case name a tool takes. */
const snake = (key: string) =>
  key
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/-/g, "_")
    .toLowerCase();

/**
 * Rewrites one CLI-shaped next action (`op` + `args`, with `_` for positionals) into a call of an MCP tool. Returns
 * null when no tool runs it, or its arguments don't fit the tool's schema, so the agent is never handed a call that
 * fails. Help actions have no tool: the input schemas already say what a tool takes.
 */
function callableAction(action: NextAction): McpNextAction | null {
  if (!action.op) return action;
  const tool = toolDefs().find((t) => t.name === action.op?.replace(/[.-]/g, "_"));
  if (!tool) return null;
  const schema = listTools().find((t) => t.name === tool.name)?.inputSchema;
  if (!schema) return null;
  const properties = schema.properties as Record<string, { type?: string | string[] }>;
  const args: Record<string, unknown> = {};
  const positionals = Array.isArray(action.args?._) ? (action.args?._ as unknown[]) : [];
  tool.command.positionals.forEach((p, i) => {
    if (positionals[i] !== undefined) args[p.name] = String(positionals[i]);
  });
  for (const [key, value] of Object.entries(action.args ?? {})) {
    if (key === "_" || key === "sandbox" || value === undefined || value === null) continue;
    args[snake(key)] = value;
  }
  for (const key of Object.keys(args)) if (!(key in properties)) return null;
  for (const key of schema.required) if (!(key in args)) return null;
  for (const [key, value] of Object.entries(args)) {
    const types = [properties[key]?.type].flat();
    const ok =
      (types.includes("object") && typeof value === "object" && !Array.isArray(value)) ||
      (types.includes("string") && typeof value === "string") ||
      (types.includes("number") && typeof value === "number") ||
      (types.includes("boolean") && typeof value === "boolean") ||
      types.includes("array") ||
      types.length === 0;
    const placeholder = typeof value === "string" && /^<.*>$/.test(value);
    if (!ok || (placeholder && types.includes("object"))) return null;
  }
  return { ...action, tool: tool.name, args, command: undefined };
}

export async function callTool(name: string, input: Record<string, unknown>, opts: McpOptions) {
  let args = input;
  const tool = toolDefs().find((t) => t.name === name);
  // An unknown tool is a protocol error (the host's request is wrong), not a tool execution error.
  if (!tool) throw new UnknownToolError(name);
  const vars = { ...opts.vars, [`${BRAND.envPrefix}NO_UPDATE_NOTICE`]: "1" };
  const remote = opts.remote;
  const host = remote && { fetch: remote.fetch, client: remote.client };
  if (remote && !PUBLIC_TOOLS.has(name) && !vars[`${BRAND.envPrefix}TOKEN`]) {
    const base = resolveSettings({ sandbox: opts.sandbox }, vars, 30).apiBase;
    return failed(
      new AppError(
        "authentication",
        "MISSING_CREDENTIALS",
        `${name} needs a ${BRAND.name} key. Create a guest key once (POST ${base}/v1/guests returns it, free and without signing up), then send it with every request as the header "Authorization: Bearer <key>". Orders and files belong to that key.`,
      ),
    );
  }
  const known = new Set([
    ...tool.command.positionals.map((p) => p.name),
    ...toolFlags(tool.command).flatMap(([f]) => [f, mcpName(f)]),
    ...(tool.name === "order_wait" ? ["timeout"] : []),
  ]);
  const required = listTools().find((t) => t.name === name)?.inputSchema.required ?? [];
  const missing = required.filter((k) => !(k in args) || args[k] === undefined || args[k] === null);
  if (missing.length > 0) {
    return {
      content: [{ type: "text", text: `Missing required argument(s) for ${name}: ${missing.join(", ")}.` }],
      isError: true,
    };
  }
  const unknown = Object.keys(args).filter((k) => !known.has(k));
  if (unknown.length > 0) {
    return {
      content: [{ type: "text", text: `Unknown argument(s) for ${name}: ${unknown.join(", ")}.` }],
      isError: true,
    };
  }
  // An address is an object (or its JSON). The CLI also takes a file path or "-" for stdin there; a tool call
  // must not, or a caller could have any local file read and sent to the API.
  for (const [flag, spec] of toolFlags(tool.command)) {
    if (spec.valueName !== "address") continue;
    const value = args[mcpName(flag)] ?? args[flag];
    if (value === undefined || value === null) continue;
    const inline =
      (typeof value === "object" && !Array.isArray(value)) ||
      (typeof value === "string" && value.trimStart().startsWith("{"));
    if (!inline) {
      return {
        content: [{ type: "text", text: `${mcpName(flag)} must be an address object, not a file path or "-".` }],
        isError: true,
      };
    }
  }
  // On the hosted endpoint a PDF is a URL: fetch it and store it, and hand the command the stored file's id.
  const settings: Settings = { ...resolveSettings({ sandbox: opts.sandbox }, vars, tool.command.timeoutS), ...host };
  if (remote) {
    try {
      args = { ...args };
      for (const key of pdfArgs(tool.command)) {
        if (typeof args[key] === "string") args[key] = await remoteFile(args[key] as string, key, settings, remote);
      }
    } catch (err) {
      if (err instanceof AppError) return failed(err);
      throw err;
    }
  }
  const argv = toArgv(tool, args, opts.sandbox);
  // A check always saves its page previews, to a temp folder of its own, so the result can carry them as images.
  if (tool.name === "check" && !remote) {
    const at = argv.indexOf("--");
    argv.splice(
      at < 0 ? argv.length : at,
      0,
      "--preview-dir",
      await mkdtemp(join(tmpdir(), `${BRAND.name}-previews-`)),
    );
  }
  // The Workers runtime has no argument parser, and needs none: the arguments are already apart.
  const result = remote
    ? await runCommand(tool.command, toInput(tool, args, opts.sandbox), vars, host)
    : await run(argv, vars, host);
  const envelope = localPreviews(withTools(result.envelope));
  const images =
    tool.name !== "check" ? [] : remote ? await fetchedPreviews(envelope, settings) : await previewImages(envelope);
  const note =
    images.length > 0
      ? "\nThe page preview is attached as an image (trim, safe area and each issue are marked on it). Look at the attached image; there is no URL to open."
      : "";
  return {
    content: [{ type: "text", text: modelText(envelope) + note }, ...images],
    structuredContent: envelope,
    isError: !envelope.ok,
    resultType: "complete",
  };
}

/** A tool result for a failure found before the command ran, in the same shape as the command's own errors. */
function failed(err: AppError) {
  const envelope: Envelope = { ok: false, error: err.toBody(), next_actions: [] };
  return {
    content: [{ type: "text", text: modelText(envelope) }],
    structuredContent: envelope,
    isError: true,
    resultType: "complete",
  };
}

/**
 * A PDF argument on the hosted endpoint: a file id is kept; an https URL is downloaded and stored as the caller's
 * file. Only https, and never more than MAX_REMOTE_PDF_BYTES, whatever the far end says its length is.
 */
async function remoteFile(value: string, param: string, settings: Settings, remote: RemoteHost): Promise<string> {
  if (isFileId(value)) return value;
  const url = URL.canParse(value) ? new URL(value) : null;
  if (url?.protocol !== "https:" || url.username || url.password) {
    throw new AppError(
      "invalid_request",
      "FILE_URL_REQUIRED",
      `${param} must be an https URL the PDF can be downloaded from, or a file id (fil_…). This server runs remotely and can't read a path on your machine: put the PDF somewhere it can be fetched, or use the ${BRAND.name} CLI (npx -y ${BRAND.name}), which reads local files.`,
      { param },
    );
  }
  const unreachable = (why: string) =>
    new AppError("invalid_request", "FILE_DOWNLOAD_FAILED", `Couldn't download the PDF from ${url.host}: ${why}.`, {
      param,
    });
  const limitMb = MAX_REMOTE_PDF_BYTES / 1024 / 1024;
  const tooLarge = () =>
    new AppError("invalid_request", "FILE_TOO_LARGE", `The PDF at ${url.host} is over ${limitMb} MB.`, {
      param,
      details: { max_bytes: MAX_REMOTE_PDF_BYTES },
    });
  let res: Response;
  try {
    res = await remote.download(url.href);
  } catch (err) {
    throw unreachable(err instanceof Error ? err.message : String(err));
  }
  if (!res.ok || !res.body) {
    await res.body?.cancel();
    throw unreachable(`it answered ${res.status}`);
  }
  if (Number(res.headers.get("Content-Length")) > MAX_REMOTE_PDF_BYTES) {
    await res.body.cancel();
    throw tooLarge();
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value: chunk } = await reader.read();
    if (done) break;
    size += chunk.length;
    if (size > MAX_REMOTE_PDF_BYTES) {
      await reader.cancel();
      throw tooLarge();
    }
    chunks.push(chunk);
  }
  const pdf = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    pdf.set(chunk, at);
    at += chunk.length;
  }
  const name = decodeURIComponent(url.pathname.split("/").pop() ?? "") || "file.pdf";
  return uploadBytes(settings, name, pdf, Date.now() + settings.timeoutMs);
}

/** The first page previews of a finished check, fetched from the API with the caller's key. Best effort. */
async function fetchedPreviews(
  envelope: Envelope,
  settings: Settings,
): Promise<{ type: "image"; data: string; mimeType: string }[]> {
  const check = (envelope.ok ? (envelope.data as { check?: { previews?: { url?: string }[] } }) : null)?.check;
  const images: { type: "image"; data: string; mimeType: string }[] = [];
  for (const preview of (check?.previews ?? []).slice(0, MAX_PREVIEW_PAGES)) {
    if (!preview.url) continue;
    try {
      const res = await request(settings, { path: preview.url, headers: { Accept: "image/png" } });
      if (!res.ok) continue;
      const bytes = Buffer.from(await res.arrayBuffer());
      if (bytes.length <= MAX_PREVIEW_BYTES)
        images.push({ type: "image", data: bytes.toString("base64"), mimeType: "image/png" });
    } catch {
      // The preview is a convenience; the check result stands without it.
    }
  }
  return images;
}

/**
 * Check previews as the host should see them: the saved file, not the API url. The url needs the guest key, so a
 * model that opens it (to look at the page) only gets a 401; the file can be read, and is also attached as an image.
 */
function localPreviews(envelope: Envelope): Envelope {
  const data = envelope.ok
    ? (envelope.data as { check?: { previews?: Record<string, unknown>[] } } | undefined)
    : undefined;
  const previews = data?.check?.previews;
  if (!envelope.ok || !data?.check || !Array.isArray(previews) || !previews.some((p) => p.local_path)) return envelope;
  const local = previews.map(({ url: _url, ...rest }) => rest);
  return { ...envelope, data: { ...data, check: { ...data.check, previews: local } } };
}

const MAX_PREVIEW_PAGES = 2;
const MAX_PREVIEW_BYTES = 3 * 1024 * 1024;

/**
 * The first page previews of a finished check (the page with trim, safe-area and issue overlays) as MCP image
 * blocks, so a host can show them and a vision model can look at them. Best effort: a missing file is skipped.
 */
async function previewImages(envelope: Envelope): Promise<{ type: "image"; data: string; mimeType: string }[]> {
  const check = (envelope.ok ? (envelope.data as { check?: { previews?: { local_path?: string }[] } }) : null)?.check;
  const images: { type: "image"; data: string; mimeType: string }[] = [];
  for (const preview of (check?.previews ?? []).slice(0, MAX_PREVIEW_PAGES)) {
    if (!preview.local_path) continue;
    try {
      const bytes = await readFile(preview.local_path);
      if (bytes.length <= MAX_PREVIEW_BYTES)
        images.push({ type: "image", data: bytes.toString("base64"), mimeType: "image/png" });
    } catch {
      // The preview is a convenience; the check result stands without it.
    }
  }
  return images;
}

/** Only next actions a tool can run are returned, already in that tool's argument names. */
function withTools(envelope: Envelope): Envelope {
  return {
    ...envelope,
    next_actions: envelope.next_actions.flatMap((a): McpNextAction[] => {
      const callable = callableAction(a);
      return callable ? [callable] : a.url ? [a] : [];
    }),
  };
}

/**
 * The text a host shows the model: the summary, warnings, the calls that come next, and the data as compact JSON.
 * Errors carry their error body instead of data.
 */
function modelText(envelope: Envelope): string {
  const lines: string[] = [];
  if (envelope.ok) lines.push(envelope.summary ?? "Done.");
  else lines.push(`Error ${envelope.error.code}: ${envelope.error.message}`);
  for (const w of envelope.warnings ?? []) lines.push(`Warning: ${w.message}`);
  if (envelope.next_actions.length > 0) {
    lines.push("Next:");
    for (const a of envelope.next_actions as McpNextAction[]) {
      const call = a.tool ? ` → ${a.tool} ${JSON.stringify(a.args ?? {})}` : "";
      lines.push(`- ${a.description}${call}${a.url ? ` → ${a.url}` : ""}`);
    }
  }
  if (envelope.ok && envelope.data !== undefined) lines.push(JSON.stringify(envelope.data));
  if (!envelope.ok) lines.push(JSON.stringify(envelope.error));
  return lines.join("\n");
}

class UnknownToolError extends Error {
  constructor(name: string) {
    super(`Unknown tool: ${name}`);
  }
}

type JsonRpc = { jsonrpc: "2.0"; id?: string | number | null; method?: string; params?: Record<string, unknown> };

/** Handles one JSON-RPC message; returns the response, or null for notifications. */
export async function handleMessage(msg: JsonRpc, opts: McpOptions): Promise<Record<string, unknown> | null> {
  const reply = (result: unknown) => ({ jsonrpc: "2.0", id: msg.id ?? null, result });
  const error = (code: number, message: string) => ({ jsonrpc: "2.0", id: msg.id ?? null, error: { code, message } });
  if (msg.id === undefined) return null; // notifications (initialized, cancelled) need no answer
  // A modern request names the protocol version it uses; refuse versions this server doesn't speak.
  const requested = (msg.params?._meta as Record<string, unknown> | undefined)?.[
    "io.modelcontextprotocol/protocolVersion"
  ];
  if (typeof requested === "string" && !(PROTOCOLS as readonly string[]).includes(requested)) {
    return {
      jsonrpc: "2.0",
      id: msg.id ?? null,
      error: {
        code: -32022,
        message: "Unsupported protocol version",
        data: { supported: [...PROTOCOLS], requested },
      },
    };
  }
  const serverInfo = { name: BRAND.name, version: opts.remote?.version ?? CLI_VERSION };
  const hosted = opts.remote
    ? ` Give a PDF as an https URL. Everything except the catalogue tools needs a guest key, sent as "Authorization: Bearer <key>": POST ${resolveSettings({ sandbox: opts.sandbox }, opts.vars, 30).apiBase}/v1/guests returns one, free and without signing up.`
    : "";
  const instructions = `${BRAND.name} checks print-ready PDFs for free and orders professional printing from them. Check the file, get a quote, and buy only with the user's go-ahead: buying returns a link they pay on.${hosted}${opts.sandbox ? " (sandbox: nothing is printed or charged)" : ""}`;
  switch (msg.method) {
    case "server/discover":
      return reply({
        resultType: "complete",
        supportedVersions: [...PROTOCOLS],
        capabilities: { tools: {} },
        _meta: { "io.modelcontextprotocol/serverInfo": serverInfo },
        instructions,
        ttlMs: TOOLS_TTL_MS,
        cacheScope: "public",
      });
    case "initialize": {
      const requested = String(msg.params?.protocolVersion ?? "");
      return reply({
        protocolVersion: (PROTOCOLS as readonly string[]).includes(requested) ? requested : PROTOCOLS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo,
        instructions,
      });
    }
    case "ping":
      return reply({});
    case "tools/list":
      // The listing is the same for every caller, so it is cacheable publicly; ttlMs is a freshness hint.
      return reply({
        tools: listTools(Boolean(opts.remote)),
        ttlMs: TOOLS_TTL_MS,
        cacheScope: "public",
        resultType: "complete",
      });
    case "tools/call": {
      const name = String(msg.params?.name ?? "");
      const args = (msg.params?.arguments ?? {}) as Record<string, unknown>;
      try {
        return reply(await callTool(name, args, opts));
      } catch (err) {
        if (err instanceof UnknownToolError) return error(-32602, err.message);
        throw err;
      }
    }
    default:
      return error(-32601, `Method not found: ${msg.method}`);
  }
}

/** Runs the server on stdin/stdout until stdin closes. Logs go to stderr only. */
export async function serveMcp(sandbox: boolean, vars: Record<string, string | undefined>): Promise<void> {
  const lines = createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY });
  const pending = new Set<Promise<void>>();
  for await (const line of lines) {
    if (!line.trim()) continue;
    let msg: JsonRpc;
    try {
      msg = JSON.parse(line) as JsonRpc;
    } catch {
      process.stdout.write(
        `${JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } })}\n`,
      );
      continue;
    }
    const work = handleMessage(msg, { sandbox, vars })
      .then((res) => {
        if (res) process.stdout.write(`${JSON.stringify(res)}\n`);
      })
      .catch((err) => {
        process.stderr.write(`mcp: ${err instanceof Error ? err.message : String(err)}\n`);
        if (msg.id !== undefined)
          process.stdout.write(
            `${JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: "Internal error" } })}\n`,
          );
      })
      .finally(() => pending.delete(work));
    pending.add(work);
  }
  await Promise.all(pending);
}
