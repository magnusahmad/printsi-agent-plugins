import { API_VERSION, AppError, BRAND, type Envelope, HEADERS, type Warning } from "@internal/core";
import { CLI_VERSION, type Settings } from "./settings.js";

const RETRY_STATUSES = new Set([429, 503]);
const MAX_ATTEMPTS = 3;

export interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH";
  /** Path on the API base, or an absolute URL the API handed out (e.g. an upload or preview URL). */
  path: string;
  query?: Record<string, string>;
  json?: unknown;
  /** Called per attempt, so stream bodies can be recreated on retry. */
  body?: () => RequestInit["body"];
  headers?: Record<string, string>;
  /** Absolute deadline (ms since epoch). Defaults to now + the command timeout. */
  deadline?: number;
  deps?: { fetch?: typeof fetch; sleep?: (ms: number) => Promise<void> };
}

/**
 * One API call with bounded retries on network errors, 429 and 503 (spec 01 §9). Mutating calls carry one
 * Idempotency-Key for all their attempts, so retrying them is safe; if every attempt fails after the request may
 * have been sent, the outcome is reported as unknown rather than failed.
 */
export async function request(settings: Settings, opts: RequestOptions): Promise<Response> {
  const method = opts.method ?? "GET";
  const doFetch = opts.deps?.fetch ?? fetch;
  const sleep = opts.deps?.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const url = new URL(/^https?:\/\//.test(opts.path) ? opts.path : `${settings.apiBase}${opts.path}`);
  for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, v);
  const deadline = opts.deadline ?? Date.now() + settings.timeoutMs;
  const headers: Record<string, string> = {
    Accept: "application/json",
    [HEADERS.version]: API_VERSION,
    [HEADERS.client]: clientHeader(settings),
    ...opts.headers,
  };
  if (settings.token) headers.Authorization = `Bearer ${settings.token}`;
  if (opts.json !== undefined) headers["Content-Type"] = "application/json";
  if (method === "POST" || method === "PATCH") headers["Idempotency-Key"] = crypto.randomUUID();

  let lastError: AppError | undefined;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    const body = opts.json !== undefined ? JSON.stringify(opts.json) : opts.body?.();
    let res: Response;
    try {
      trace(settings, `${method} ${url} (attempt ${attempt})`);
      res = await doFetch(url, {
        method,
        headers,
        body,
        signal: AbortSignal.timeout(remaining),
        ...(body instanceof ReadableStream && { duplex: "half" }),
      } as RequestInit);
    } catch (err) {
      lastError =
        method === "GET"
          ? new AppError("unavailable", "SERVICE_UNAVAILABLE", `Could not reach ${url.host}: ${describe(err)}`)
          : new AppError(
              "unavailable",
              "OUTCOME_UNKNOWN",
              `Lost the connection to ${url.host} during ${method} ${url.pathname} (${describe(err)}); it may or may not have been applied. Re-running the same command is safe.`,
            );
      await backoff(attempt, deadline, sleep);
      continue;
    }
    trace(settings, `← ${res.status} ${res.headers.get(HEADERS.requestId) ?? ""}`);
    if (RETRY_STATUSES.has(res.status) && attempt < MAX_ATTEMPTS) {
      await backoff(attempt, deadline, sleep, Number(res.headers.get("Retry-After")) * 1000 || undefined);
      continue;
    }
    return res;
  }
  throw (
    lastError ??
    new AppError("timeout", "TIMEOUT", `No response from ${url.host} within ${settings.timeoutMs / 1000}s.`, {
      retryable: true,
    })
  );
}

/** request() and parse the JSON envelope, adding CLI-version warnings from the response headers. */
export async function apiRequest(settings: Settings, opts: RequestOptions): Promise<Envelope> {
  const res = await request(settings, opts);
  const envelope = await parseEnvelope(res, new URL(res.url || settings.apiBase));
  // MCP hosts pin an exact version (spec 01 §7.21), so update notices would only be noise there.
  const warnings = settings.updateNotices ? versionWarnings(res) : [];
  if (warnings.length > 0) envelope.warnings = [...(envelope.warnings ?? []), ...warnings];
  return envelope;
}

export function apiGet(settings: Settings, path: string, query: Record<string, string> = {}): Promise<Envelope> {
  return apiRequest(settings, { path, query });
}

function clientHeader(settings: Settings): string {
  const base = `${BRAND.name}-cli/${CLI_VERSION} node/${process.versions.node}`;
  return settings.telemetry ? `${base} harness=${settings.harness}` : base;
}

async function parseEnvelope(res: Response, url: URL): Promise<Envelope> {
  const text = await res.text();
  try {
    const body = JSON.parse(text) as Envelope;
    if (typeof body === "object" && body !== null && typeof body.ok === "boolean") return body;
  } catch {
    // fall through
  }
  if (res.status === 503 || res.status === 429) {
    throw new AppError(
      res.status === 429 ? "rate_limited" : "unavailable",
      "SERVICE_UNAVAILABLE",
      `${url.host} returned ${res.status}.`,
    );
  }
  throw new AppError(
    "internal",
    "UNEXPECTED_RESPONSE",
    `${url.host} returned ${res.status} without a valid response body.`,
  );
}

function versionWarnings(res: Response): Warning[] {
  const latest = res.headers.get(HEADERS.latestCli);
  if (latest && compareVersions(CLI_VERSION, latest) < 0) {
    return [
      {
        code: "CLI_UPDATE_AVAILABLE",
        message: `${BRAND.name} ${latest} is available (you have ${CLI_VERSION}). Use npx -y ${BRAND.name}@latest or update your install.`,
      },
    ];
  }
  return [];
}

async function backoff(attempt: number, deadline: number, sleep: (ms: number) => Promise<void>, hintMs?: number) {
  const base = hintMs ?? 250 * 2 ** (attempt - 1);
  const wait = Math.min(base + Math.random() * 100, Math.max(0, deadline - Date.now()));
  if (wait > 0) await sleep(wait);
}

export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.-]/).map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split(/[.-]/).map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

function trace(settings: Settings, line: string) {
  if (settings.verbose) process.stderr.write(`[${BRAND.name}] ${line}\n`);
}

function describe(err: unknown): string {
  if (err instanceof Error) return err.cause instanceof Error ? `${err.message} (${err.cause.message})` : err.message;
  return String(err);
}
