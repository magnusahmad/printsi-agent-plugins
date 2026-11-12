import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { AppError, BRAND, type Envelope, type NextAction, type Warning } from "@internal/core";
import { parseUsd } from "@internal/core/pricing";
import { waitReached } from "@internal/core/progress";
import { expectOk, inspectLocalFile, uploadFile } from "./check.js";
import { configDir, loadGuest, loadOrderTokens, orderTokensFromEnv, saveOrderToken } from "./credentials.js";
import { apiRequest } from "./http.js";
import { withCredential } from "./session.js";
import type { Settings } from "./settings.js";

/** `order …` commands (spec 01 §7.5–7.13). Purchasing arrives in M3. */

type Vars = Record<string, string | undefined>;
type Flags = Record<string, string | boolean | string[] | undefined>;

interface OrderView {
  id: string;
  status: string;
  version: number;
  access_token?: string;
}

const LONG_POLL_S = 25;
const IN_PROGRESS = new Set(["checking", "quoting"]);
export const WAIT_TARGETS = [
  "quoted",
  "change",
  "paid",
  "accepted",
  "shipped",
  "ready_for_pickup",
  "delivered",
] as const;

export async function orderCreate(
  settings: Settings,
  vars: Vars,
  flags: Flags,
  options: Record<string, string>,
): Promise<Envelope> {
  const deadline = Date.now() + settings.timeoutMs;
  const file = requireString(flags, "file", "--file <pdf> is required.");
  const product = requireString(flags, "product", "--product is required, e.g. --product flyer.");
  const quantity = requireQuantity(flags.qty);
  const shipTo = await parseShipTo(
    requireString(flags, "ship-to", "--ship-to is required: a JSON file, inline JSON, or - for stdin."),
  );
  const path = resolve(file);
  const local = await inspectLocalFile(path);

  return withCredential(settings, vars, async (warnings) => {
    const fileId = await uploadFile(settings, path, local, deadline);
    const created = await expectOk(
      await apiRequest(settings, {
        method: "POST",
        path: "/v1/orders",
        json: {
          file_id: fileId,
          spec: { product, options },
          quantity,
          ship_to: shipTo,
          ...optionalFields(flags),
          ...(typeof flags["client-ref"] === "string" && { client_ref: flags["client-ref"] }),
        },
        deadline,
      }),
    );
    const order = (created.data as { order: OrderView }).order;
    const token = order.access_token;
    const extra: Warning[] = [...warnings];
    if (token && !settings.noSave) {
      const saved = await saveOrderToken(configDir(settings, vars), settings.env, order.id, {
        token,
        created_at: new Date().toISOString(),
        summary: created.summary,
      });
      if (saved) extra.push(saved);
    }
    const settled = await waitFor(settings, order.id, "quoted", deadline, order.version);
    const result = settled.envelope.ok ? settled.envelope : created;
    if (result.ok && token) (result.data as { order: OrderView }).order.access_token = token;
    return withWarnings(result, [
      ...(created.warnings ?? []).filter((w) => w.code === "SAVE_ORDER_TOKEN"),
      ...extra,
      ...(settled.reached ? [] : [stillWorking(order.id)]),
    ]);
  });
}

export async function orderUpdate(
  settings: Settings,
  vars: Vars,
  id: string,
  flags: Flags,
  options: Record<string, string>,
): Promise<Envelope> {
  const deadline = Date.now() + settings.timeoutMs;
  const body: Record<string, unknown> = { ...optionalFields(flags) };
  if (flags.qty !== undefined) body.quantity = requireQuantity(flags.qty);
  if (typeof flags["ship-to"] === "string") body.ship_to = await parseShipTo(flags["ship-to"]);
  if (typeof flags.product === "string" || Object.keys(options).length > 0) {
    body.spec = { ...(typeof flags.product === "string" && { product: flags.product }), options };
  }
  const filePath = typeof flags.file === "string" ? resolve(flags.file) : null;
  const local = filePath ? await inspectLocalFile(filePath) : null;
  if (Object.keys(body).length === 0 && !filePath) {
    throw new AppError(
      "usage",
      "NOTHING_TO_UPDATE",
      "Pass at least one change, e.g. --file, --qty, --ship-to or --deliver-by.",
    );
  }
  return withOrderCredential(settings, vars, id, async () => {
    if (filePath && local) body.file_id = await uploadFile(settings, filePath, local, deadline);
    const updated = await expectOk(
      await apiRequest(settings, { method: "PATCH", path: `/v1/orders/${id}`, json: body, deadline }),
    );
    return settle(settings, updated, deadline);
  });
}

export async function orderQuote(settings: Settings, vars: Vars, id: string): Promise<Envelope> {
  const deadline = Date.now() + settings.timeoutMs;
  return withOrderCredential(settings, vars, id, async () =>
    settle(
      settings,
      await expectOk(
        await apiRequest(settings, { method: "POST", path: `/v1/orders/${id}/quotes`, json: {}, deadline }),
      ),
      deadline,
    ),
  );
}

export async function orderShow(settings: Settings, vars: Vars, id: string, flags: Flags): Promise<Envelope> {
  const include = typeof flags.include === "string" ? { include: flags.include } : undefined;
  return withOrderCredential(settings, vars, id, () =>
    apiRequest(settings, { path: `/v1/orders/${id}`, query: include }),
  );
}

export async function orderWait(settings: Settings, vars: Vars, id: string, target: string): Promise<Envelope> {
  if (!(WAIT_TARGETS as readonly string[]).includes(target)) {
    throw new AppError("usage", "INVALID_FLAG_VALUE", `--for must be one of: ${WAIT_TARGETS.join(", ")}.`, {
      param: "--for",
    });
  }
  const deadline = Date.now() + settings.timeoutMs;
  return withOrderCredential(settings, vars, id, async () => {
    const first = await expectOk(await apiRequest(settings, { path: `/v1/orders/${id}`, deadline }));
    const since = (first.data as { order: OrderView }).order.version;
    if (target !== "change" && reached((first.data as { order: OrderView }).order, target, since)) return first;
    const result = await waitFor(settings, id, target, deadline, since);
    if (result.reached) return result.envelope;
    const order = result.envelope.ok ? (result.envelope.data as { order: OrderView }).order : null;
    throw new AppError(
      "timeout",
      "WAIT_TIMEOUT",
      `Order ${id} didn't reach "${target}" within ${settings.timeoutMs / 1000}s${order ? `; it is ${order.status}` : ""}.`,
      {
        details: { order_id: id, status: order?.status ?? null },
        nextActions: [cmd("wait", "Keep waiting.", "order.wait", { _: [id], for: target })],
        // args use the CLI's shape; the MCP adapter translates them to the tool's own argument names.
      },
    );
  });
}

export async function orderEvents(settings: Settings, vars: Vars, id: string): Promise<Envelope> {
  return withOrderCredential(settings, vars, id, () => apiRequest(settings, { path: `/v1/orders/${id}/events` }));
}

export async function orderPurchase(settings: Settings, vars: Vars, id: string, flags: Flags): Promise<Envelope> {
  const quote = requireString(flags, "quote", "--quote is required: the quote id to buy (qte_…).");
  const { max_total } = optionalFields(flags);
  return withOrderCredential(settings, vars, id, () =>
    apiRequest(settings, {
      method: "POST",
      path: `/v1/orders/${id}/purchase`,
      json: { quote_id: quote, authority: { mode: "browser_approval" }, ...(max_total !== undefined && { max_total }) },
    }),
  );
}

export async function orderReportProblem(settings: Settings, vars: Vars, id: string, flags: Flags): Promise<Envelope> {
  const kind = requireString(flags, "kind", "--kind is required.");
  const description = requireString(flags, "description", "--description is required.");
  const quantity = Number(requireString(flags, "quantity", "--quantity is required."));
  if (!Number.isInteger(quantity) || quantity < 1)
    throw new AppError("invalid_request", "INVALID_QUANTITY", "--quantity must be a positive integer.");
  return withOrderCredential(settings, vars, id, () =>
    apiRequest(settings, {
      method: "POST",
      path: `/v1/orders/${id}/report-problem`,
      json: { kind, description, affected_quantity: quantity },
    }),
  );
}

export async function orderCancel(
  settings: Settings,
  vars: Vars,
  id: string,
  reason: string | undefined,
): Promise<Envelope> {
  return withOrderCredential(settings, vars, id, () =>
    apiRequest(settings, { method: "POST", path: `/v1/orders/${id}/cancel`, json: reason ? { reason } : {} }),
  );
}

/** Orders the stored guest owns, plus orders this machine only holds tokens for. */
export async function orderList(settings: Settings, vars: Vars, flags: Flags): Promise<Envelope> {
  const dir = configDir(settings, vars);
  const query: Record<string, string> = {};
  if (typeof flags.status === "string") query.status = flags.status;
  if (typeof flags.limit === "string") query.limit = flags.limit;
  const items: Record<string, unknown>[] = [];
  const warnings: Warning[] = [];
  const explicit = settings.token;
  const guest = explicit ? null : await loadGuest(dir, settings.env);
  if (explicit || guest) {
    if (guest) settings.token = guest.key;
    const owned = await expectOk(await apiRequest(settings, { path: "/v1/orders", query }));
    items.push(...(owned.data as { orders: Record<string, unknown>[] }).orders.map((o) => ({ ...o, access: "owner" })));
  }
  const known = new Set(items.map((o) => o.id));
  const tokens = {
    ...Object.fromEntries(Object.entries(await loadOrderTokens(dir, settings.env)).map(([id, e]) => [id, e.token])),
    ...orderTokensFromEnv(vars[`${BRAND.envPrefix}ORDER_TOKENS`]),
  };
  for (const [id, token] of Object.entries(tokens)) {
    if (known.has(id)) continue;
    const res = await apiRequest({ ...settings, token }, { path: `/v1/orders/${id}` });
    if (!res.ok) {
      warnings.push({
        code: "ORDER_TOKEN_UNUSABLE",
        message: `Saved token for ${id} didn't work (${res.error.code}).`,
      });
      continue;
    }
    const o = (res.data as { order: OrderView & { created_at: string; updated_at: string } }).order;
    items.push({
      id: o.id,
      status: o.status,
      summary: res.summary,
      created_at: o.created_at,
      updated_at: o.updated_at,
      access: "order_token",
    });
  }
  return {
    ok: true,
    summary: `${items.length} order${items.length === 1 ? "" : "s"}.`,
    data: { orders: items },
    next_actions: [],
    warnings,
  };
}

export async function addressValidate(settings: Settings, vars: Vars, flags: Flags): Promise<Envelope> {
  const shipTo = await parseShipTo(
    requireString(flags, "ship-to", "--ship-to is required: a JSON file, inline JSON, or - for stdin."),
  );
  return withCredential(settings, vars, async (warnings) =>
    withWarnings(
      await apiRequest(settings, { method: "POST", path: "/v1/addresses/validate", json: shipTo }),
      warnings,
    ),
  );
}

export async function pickupPoints(settings: Settings, vars: Vars, flags: Flags): Promise<Envelope> {
  const shipTo = await parseShipTo(
    requireString(flags, "ship-to", "--ship-to is required: a JSON file, inline JSON, or - for stdin."),
  );
  const limit = typeof flags.limit === "string" ? Number(flags.limit) : undefined;
  return withCredential(settings, vars, async (warnings) =>
    withWarnings(
      await apiRequest(settings, {
        method: "POST",
        path: "/v1/pickup-points/search",
        json: { ship_to: shipTo, ...(limit !== undefined && { limit }) },
      }),
      warnings,
    ),
  );
}

// --- helpers --------------------------------------------------------------------------------------------------------

/**
 * Uses --token if given; otherwise the stored guest key, falling back to a saved or PRINTSI_ORDER_TOKENS token for
 * this order (spec 01 §6.2). Without a guest key it never creates one just to read an order it holds a token for.
 */
export async function withOrderCredential(
  settings: Settings,
  vars: Vars,
  id: string,
  fn: () => Promise<Envelope>,
): Promise<Envelope> {
  if (settings.token) return fn();
  const dir = configDir(settings, vars);
  const orderToken =
    orderTokensFromEnv(vars[`${BRAND.envPrefix}ORDER_TOKENS`])[id] ??
    (await loadOrderTokens(dir, settings.env))[id]?.token;
  const guest = await loadGuest(dir, settings.env);
  if (!guest && orderToken) {
    settings.token = orderToken;
    return fn();
  }
  return withCredential(settings, vars, async (warnings) => {
    try {
      const result = await fn();
      if (!result.ok && result.error.code === "ORDER_NOT_FOUND" && orderToken) {
        settings.token = orderToken;
        return withWarnings(await fn(), warnings);
      }
      return withWarnings(result, warnings);
    } catch (err) {
      if (err instanceof AppError && err.code === "ORDER_NOT_FOUND" && orderToken) {
        settings.token = orderToken;
        return withWarnings(await fn(), warnings);
      }
      throw err;
    }
  });
}

async function settle(settings: Settings, envelope: Envelope & { ok: true }, deadline: number): Promise<Envelope> {
  const order = (envelope.data as { order: OrderView }).order;
  if (!IN_PROGRESS.has(order.status)) return envelope;
  const result = await waitFor(settings, order.id, "quoted", deadline, order.version);
  return result.reached ? result.envelope : withWarnings(envelope, [stillWorking(order.id)]);
}

async function waitFor(
  settings: Settings,
  id: string,
  target: string,
  deadline: number,
  sinceVersion: number,
): Promise<{ envelope: Envelope; reached: boolean }> {
  let envelope: Envelope | undefined;
  while (Date.now() < deadline - 1000) {
    const wait = Math.max(0, Math.min(LONG_POLL_S, Math.floor((deadline - Date.now()) / 1000) - 1));
    envelope = await apiRequest(settings, {
      path: `/v1/orders/${id}`,
      query: { wait_for: target, wait_seconds: String(wait), since_version: String(sinceVersion) },
      deadline,
    });
    if (!envelope.ok) return { envelope, reached: false };
    if (reached((envelope.data as { order: OrderView }).order, target, sinceVersion))
      return { envelope, reached: true };
  }
  return { envelope: envelope ?? (await apiRequest(settings, { path: `/v1/orders/${id}` })), reached: false };
}

function reached(order: OrderView, target: string, sinceVersion: number): boolean {
  if (target === "change") return order.version > sinceVersion;
  return waitReached(order.status, target);
}

function optionalFields(flags: Flags): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (typeof flags["deliver-by"] === "string") out.deliver_by = flags["deliver-by"];
  if (typeof flags["max-total"] === "string") {
    // The budget is in the order's currency (USD in both regions today). "HK$" or "US$" pins the currency, and
    // the server refuses a mismatch rather than converting.
    const raw = flags["max-total"].trim();
    const tagged = /^(HK|US)\$/i.exec(raw);
    const cents = parseUsd(tagged ? raw.slice(tagged[1]?.length ?? 0) : raw);
    if (cents === null || cents <= 0) {
      throw new AppError(
        "usage",
        "INVALID_FLAG_VALUE",
        `--max-total must be an amount in the order's currency, e.g. 450 or 450.00, not "${flags["max-total"]}".`,
        {
          param: "--max-total",
        },
      );
    }
    out.max_total = tagged
      ? { amount: cents, currency: tagged[1]?.toUpperCase() === "HK" ? "HKD" : "USD" }
      : { amount: cents };
  }
  if (typeof flags.note === "string") out.note = flags.note;
  if (typeof flags.pickup === "string") {
    out.delivery = flags.pickup === "door" ? { type: "door" } : { type: "pickup", point_id: flags.pickup };
  }
  return out;
}

/** --ship-to: a path to JSON, inline JSON (starts with "{"), or "-" for stdin (spec 01 §7.4). */
export async function parseShipTo(value: string): Promise<Record<string, unknown>> {
  let text: string;
  try {
    if (value === "-") {
      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
      text = Buffer.concat(chunks).toString("utf8");
    } else if (value.trimStart().startsWith("{")) {
      text = value;
    } else if (value.startsWith("adr_")) {
      throw new AppError(
        "unsupported",
        "SAVED_ADDRESSES_UNAVAILABLE",
        "Saved addresses (adr_…) need an account, which isn't available yet. Pass the address as JSON.",
      );
    } else {
      text = await readFile(resolve(value), "utf8");
    }
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError(
      "usage",
      "INVALID_SHIP_TO",
      `Couldn't read --ship-to ${value}: ${err instanceof Error ? err.message : String(err)}`,
      {
        param: "--ship-to",
      },
    );
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("expected a JSON object");
    return parsed as Record<string, unknown>;
  } catch (err) {
    throw new AppError(
      "usage",
      "INVALID_SHIP_TO",
      `--ship-to must be a JSON object like {"name":…,"line1":…,"city":…,"state":"TX","postal_code":…}, or in Hong Kong {"name":…,"line1":…,"district":…,"area":"Kowloon","phone":…,"email":…,"country":"HK"} (${err instanceof Error ? err.message : String(err)}).`,
      { param: "--ship-to" },
    );
  }
}

function requireString(flags: Flags, name: string, message: string): string {
  const v = flags[name];
  if (typeof v !== "string" || !v) throw new AppError("usage", "MISSING_ARGUMENT", message, { param: `--${name}` });
  return v;
}

function requireQuantity(value: unknown): number {
  const n = Number(value);
  if (value === undefined || !Number.isInteger(n) || n <= 0) {
    throw new AppError(
      "usage",
      value === undefined ? "MISSING_ARGUMENT" : "INVALID_FLAG_VALUE",
      "--qty must be a whole number, e.g. --qty 500.",
      {
        param: "--qty",
      },
    );
  }
  return n;
}

function withWarnings(envelope: Envelope, warnings: Warning[]): Envelope {
  if (warnings.length === 0) return envelope;
  return { ...envelope, warnings: [...warnings, ...(envelope.warnings ?? [])] };
}

function stillWorking(id: string): Warning {
  return {
    code: "ORDER_STILL_PROCESSING",
    message: `The order is still being checked or priced. Wait for it to be quoted (order wait ${id} with for "quoted", or \`${BRAND.name} order wait ${id} --for quoted\`) to pick it up.`,
  };
}

function cmd(kind: NextAction["kind"], description: string, op: string, args: Record<string, unknown>): NextAction {
  return { kind, description, op, args, requires_human: false, spends_money: false };
}
