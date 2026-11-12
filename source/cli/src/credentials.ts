import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { BRAND, type Env, type Warning } from "@internal/core";
import type { Settings } from "./settings.js";

/** Local credential store (spec 01 §6): <config-dir>/credentials.json, mode 0600, keyed by env. */

interface StoredGuest {
  guest_id: string;
  key: string;
}

type CredentialsFile = Partial<Record<Env, StoredGuest>>;

export function configDir(settings: Pick<Settings, "configDir">, vars: Record<string, string | undefined>): string {
  if (settings.configDir) return settings.configDir;
  if (process.platform === "win32" && vars.APPDATA) return join(vars.APPDATA, BRAND.name);
  return join(vars.XDG_CONFIG_HOME || join(homedir(), ".config"), BRAND.name);
}

export async function loadGuest(dir: string, env: Env): Promise<StoredGuest | undefined> {
  try {
    const file = JSON.parse(await readFile(join(dir, "credentials.json"), "utf8")) as CredentialsFile;
    return file[env];
  } catch {
    return undefined;
  }
}

/** Saves atomically with owner-only permissions. Returns a warning instead of throwing when it can't. */
export async function saveGuest(dir: string, env: Env, guest: StoredGuest): Promise<Warning | undefined> {
  const path = join(dir, "credentials.json");
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    let existing: CredentialsFile = {};
    try {
      existing = JSON.parse(await readFile(path, "utf8")) as CredentialsFile;
    } catch {
      // first save
    }
    const tmp = `${path}.${process.pid}.tmp`;
    await writeFile(tmp, `${JSON.stringify({ ...existing, [env]: guest }, null, 2)}\n`, { mode: 0o600 });
    await rename(tmp, path);
    await chmod(path, 0o600);
    return undefined;
  } catch (err) {
    return notPersisted(`Couldn't save credentials to ${path} (${err instanceof Error ? err.message : String(err)}).`);
  }
}

/** Removes the stored guest for one env, leaving other envs untouched. Best effort. */
export async function forgetGuest(dir: string, env: Env): Promise<void> {
  const path = join(dir, "credentials.json");
  try {
    const file = JSON.parse(await readFile(path, "utf8")) as CredentialsFile;
    delete file[env];
    const tmp = `${path}.${process.pid}.tmp`;
    await writeFile(tmp, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
    await rename(tmp, path);
  } catch {
    // nothing stored, or unwritable: the caller replaces the key in memory either way
  }
}

export function notPersisted(reason: string): Warning {
  return {
    code: "CREDENTIALS_NOT_PERSISTED",
    message: `${reason} This guest key only lives for this command; later commands will create a new guest and won't see these files or checks.`,
  };
}

/** <config-dir>/orders.json: order tokens by env, so later sessions on this machine can reach each order (spec 01 §6.1). */
interface OrderIndexEntry {
  token: string;
  created_at: string;
  summary?: string;
}

type OrderIndex = Partial<Record<Env, Record<string, OrderIndexEntry>>>;

export async function loadOrderTokens(dir: string, env: Env): Promise<Record<string, OrderIndexEntry>> {
  try {
    return (JSON.parse(await readFile(join(dir, "orders.json"), "utf8")) as OrderIndex)[env] ?? {};
  } catch {
    return {};
  }
}

export async function saveOrderToken(
  dir: string,
  env: Env,
  orderId: string,
  entry: OrderIndexEntry,
): Promise<Warning | undefined> {
  const path = join(dir, "orders.json");
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    let index: OrderIndex = {};
    try {
      index = JSON.parse(await readFile(path, "utf8")) as OrderIndex;
    } catch {
      // first order
    }
    index[env] = { ...index[env], [orderId]: entry };
    const tmp = `${path}.${process.pid}.tmp`;
    await writeFile(tmp, `${JSON.stringify(index, null, 2)}\n`, { mode: 0o600 });
    await rename(tmp, path);
    await chmod(path, 0o600);
    return undefined;
  } catch (err) {
    return {
      code: "ORDER_TOKEN_NOT_SAVED",
      message: `Couldn't save the order token to ${path} (${err instanceof Error ? err.message : String(err)}). Keep it from the response.`,
    };
  }
}

/** PRINTSI_ORDER_TOKENS="ord_…=otk_…,ord_…=otk_…" (spec 01 §6.2). */
export function orderTokensFromEnv(value: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of (value ?? "").split(",")) {
    const [id, token] = pair.split("=").map((s) => s.trim());
    if (id && token) out[id] = token;
  }
  return out;
}
