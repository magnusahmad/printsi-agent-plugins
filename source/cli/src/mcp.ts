import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { BRAND, type Envelope, type NextAction } from "@internal/core";
import { COMMANDS, type Command, type FlagSpec } from "./commands.js";
import { run } from "./main.js";
import { CLI_VERSION } from "./settings.js";

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
 */

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

/** The MCP tool listing: one input property per positional and flag, all described from the CLI's own help. */
export function listTools() {
  return toolDefs().map((t) => {
    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    for (const p of t.command.positionals) {
      properties[p.name] = { type: "string", description: p.description };
      if (p.required) required.push(p.name);
    }
    for (const [name, f] of toolFlags(t.command)) {
      properties[mcpName(name)] = propertyFor(name, f);
      if (f.required) required.push(mcpName(name));
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

/** Turns tool arguments into CLI arguments for the same command. */
export function toArgv(tool: ToolDef, args: Record<string, unknown>, sandbox: boolean): string[] {
  const argv = [...tool.command.path];
  for (const [name, f] of toolFlags(tool.command)) {
    const v = args[mcpName(name)] ?? args[name];
    if (v === undefined || v === null || v === false) continue;
    if (f.type === "boolean") argv.push(`--${name}`);
    else if (Array.isArray(v)) for (const item of v) argv.push(`--${name}`, String(item));
    else argv.push(`--${name}`, typeof v === "object" ? JSON.stringify(v) : String(v));
  }
  if (tool.name === "order_wait") {
    const want = Number(args.timeout ?? 25);
    argv.push("--timeout", String(Math.min(Math.max(Number.isFinite(want) ? want : 25, 1), MAX_WAIT_S)));
  }
  if (sandbox) argv.push("--sandbox");
  argv.push("--format", "json");
  // Positionals last, after "--": a value that starts with "-" can never be read as a flag.
  const positionals = tool.command.positionals.flatMap((p) => {
    const v = args[p.name];
    return v !== undefined && v !== null ? [String(v)] : [];
  });
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

export async function callTool(
  name: string,
  args: Record<string, unknown>,
  opts: { sandbox: boolean; vars: Record<string, string | undefined> },
) {
  const tool = toolDefs().find((t) => t.name === name);
  // An unknown tool is a protocol error (the host's request is wrong), not a tool execution error.
  if (!tool) throw new UnknownToolError(name);
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
  const argv = toArgv(tool, args, opts.sandbox);
  // A check always saves its page previews, to a temp folder of its own, so the result can carry them as images.
  if (tool.name === "check") {
    const at = argv.indexOf("--");
    argv.splice(
      at < 0 ? argv.length : at,
      0,
      "--preview-dir",
      await mkdtemp(join(tmpdir(), `${BRAND.name}-previews-`)),
    );
  }
  const result = await run(argv, {
    ...opts.vars,
    [`${BRAND.envPrefix}NO_UPDATE_NOTICE`]: "1",
  });
  const envelope = localPreviews(withTools(result.envelope));
  const images = tool.name === "check" ? await previewImages(envelope) : [];
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
export async function handleMessage(
  msg: JsonRpc,
  opts: { sandbox: boolean; vars: Record<string, string | undefined> },
): Promise<Record<string, unknown> | null> {
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
  const serverInfo = { name: BRAND.name, version: CLI_VERSION };
  const instructions = `${BRAND.name} checks print-ready PDFs for free and orders professional printing from them. Check the file, get a quote, and buy only with the user's go-ahead: buying returns a link they pay on.${opts.sandbox ? " (sandbox: nothing is printed or charged)" : ""}`;
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
      return reply({ tools: listTools(), ttlMs: TOOLS_TTL_MS, cacheScope: "public", resultType: "complete" });
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
