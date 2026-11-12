import { BRAND, type Env } from "@internal/core";

declare const __CLI_VERSION__: string | undefined;

export const CLI_VERSION: string = typeof __CLI_VERSION__ === "string" ? __CLI_VERSION__ : "0.0.0-dev";

export type Format = "json" | "text";

/** Global flags shared by every command (spec 01 §3). */
export const GLOBAL_FLAGS = {
  format: { type: "string", description: "Output format: json (default) or text.", valueName: "json|text" },
  sandbox: {
    type: "boolean",
    description: "Use the sandbox: Stripe test mode and the mock supplier. Nothing is printed or charged.",
  },
  token: {
    type: "string",
    description: "Credential for this call (guest key, account key or order token).",
    valueName: "tok",
  },
  "config-dir": { type: "string", description: "Where credentials and the local order index live.", valueName: "dir" },
  "no-save": { type: "boolean", description: "Never write to the config dir." },
  timeout: { type: "string", description: "Overall time limit for this command, in seconds.", valueName: "sec" },
  verbose: { type: "boolean", description: "Request and response trace on stderr (secrets redacted)." },
  "api-base": { type: "string", description: "Override the API host. For development only.", valueName: "url" },
} as const;

export interface Settings {
  env: Env;
  format: Format;
  apiBase: string;
  timeoutMs: number;
  verbose: boolean;
  token: string | undefined;
  configDir: string | undefined;
  noSave: boolean;
  telemetry: boolean;
  harness: string;
  /** Whether to pass on "a newer CLI is available" notices; off in MCP mode. */
  updateNotices: boolean;
}

type Flags = Record<string, string | boolean | string[] | undefined>;
type EnvVars = Record<string, string | undefined>;

export function resolveSettings(flags: Flags, vars: EnvVars, defaultTimeoutS: number): Settings {
  const v = (name: string) => vars[`${BRAND.envPrefix}${name}`];
  const env: Env = flags.sandbox === true || v("ENV") === "sandbox" ? "sandbox" : "live";
  const format = (str(flags.format) ?? v("FORMAT") ?? "json") as Format;
  const timeoutS = Number(str(flags.timeout) ?? v("TIMEOUT") ?? defaultTimeoutS);
  return {
    env,
    format: format === "text" ? "text" : "json",
    apiBase: (str(flags["api-base"]) ?? v("API_BASE") ?? BRAND.domains[env].api).replace(/\/+$/, ""),
    timeoutMs: Number.isFinite(timeoutS) && timeoutS > 0 ? timeoutS * 1000 : defaultTimeoutS * 1000,
    verbose: flags.verbose === true || v("VERBOSE") === "1",
    token: str(flags.token) ?? v("TOKEN"),
    configDir: str(flags["config-dir"]) ?? v("CONFIG_DIR"),
    noSave: flags["no-save"] === true || v("NO_SAVE") === "1",
    telemetry: v("TELEMETRY") !== "0",
    harness: detectHarness(vars),
    updateNotices: v("NO_UPDATE_NOTICE") !== "1",
  };
}

/** Best-effort harness detection for discovery metrics (spec 01 §12). */
export function detectHarness(vars: EnvVars): string {
  const keys = Object.keys(vars);
  if (vars.CLAUDECODE) return "claude-code";
  if (keys.some((k) => k.startsWith("CODEX_"))) return "codex";
  if (keys.some((k) => k.startsWith("CURSOR_"))) return "cursor";
  return "unknown";
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
