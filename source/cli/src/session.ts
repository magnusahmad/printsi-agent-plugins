import { join } from "node:path";
import { AppError, BRAND, type Warning } from "@internal/core";
import { configDir, forgetGuest, loadGuest, notPersisted, saveGuest } from "./credentials.js";
import { apiRequest } from "./http.js";
import type { Settings } from "./settings.js";

type Source = "explicit" | "stored" | "created";

/**
 * Makes sure settings.token holds a credential (spec 01 §6.2): --token / PRINTSI_TOKEN, else the stored guest key,
 * else a new guest created silently and saved. Returns warnings to surface in the response.
 */
export async function ensureCredential(
  settings: Settings,
  vars: Record<string, string | undefined>,
): Promise<{ warnings: Warning[]; source: Source }> {
  if (settings.token) return { warnings: [], source: "explicit" };
  const dir = configDir(settings, vars);
  const stored = await loadGuest(dir, settings.env);
  if (stored) {
    settings.token = stored.key;
    return { warnings: [], source: "stored" };
  }
  const created = await apiRequest(settings, { method: "POST", path: "/v1/guests" });
  if (!created.ok) throw new AppError(created.error.type, created.error.code, created.error.message);
  const { guest_id, key } = created.data as { guest_id: string; key: string };
  settings.token = key;
  if (settings.noSave) return { warnings: [notPersisted("--no-save is set.")], source: "created" };
  const warning = await saveGuest(dir, settings.env, { guest_id, key });
  return { warnings: warning ? [warning] : [], source: "created" };
}

/**
 * Runs `fn` with a credential. If a *saved* guest key is rejected (the sandbox was reset, or a local database wiped),
 * the sandbox quietly replaces it with a new guest and runs `fn` once more. Live never does this: a new guest there
 * would lose sight of the old guest's orders, so the error explains what happened instead.
 */
export async function withCredential<T>(
  settings: Settings,
  vars: Record<string, string | undefined>,
  fn: (warnings: Warning[]) => Promise<T>,
): Promise<T> {
  const { warnings, source } = await ensureCredential(settings, vars);
  try {
    return await fn(warnings);
  } catch (err) {
    if (!(err instanceof AppError) || err.code !== "INVALID_TOKEN" || source !== "stored") throw err;
    const dir = configDir(settings, vars);
    const file = join(dir, "credentials.json");
    if (settings.env !== "sandbox") {
      throw new AppError(
        "authentication",
        "INVALID_TOKEN",
        `The guest key saved in ${file} was rejected. If you meant to start over, delete the "${settings.env}" entry in that file; otherwise use the order token (otk_…) or account key you have, via --token.`,
      );
    }
    await forgetGuest(dir, settings.env);
    settings.token = undefined;
    const retry = await ensureCredential(settings, vars);
    return fn([
      {
        code: "SANDBOX_GUEST_RECREATED",
        message: `The saved sandbox guest key was no longer valid (the sandbox data was probably reset), so ${BRAND.name} created a new sandbox guest. Earlier sandbox files and checks belong to the old guest.`,
      },
      ...retry.warnings,
    ]);
  }
}
