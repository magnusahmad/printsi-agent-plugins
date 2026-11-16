import { BRAND } from "./brand.js";

/**
 * Renders a structured next action ({ op, args }) as a CLI command line (spec 02 §1).
 * op "products.show" → "printsi products show"; args._ are positionals, other keys become --kebab-case flags.
 */
export function renderCommand(op: string, args: Record<string, unknown> = {}, bin: string = BRAND.name): string {
  const parts: string[] = [bin, ...op.split(".")];
  const positionals = args._;
  if (Array.isArray(positionals)) parts.push(...positionals.map(String));
  for (const [key, value] of Object.entries(args)) {
    if (key === "_" || value === undefined || value === null || value === false) continue;
    const flag = `--${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`).replace(/_/g, "-")}`;
    if (value === true) {
      parts.push(flag);
    } else if (Array.isArray(value)) {
      for (const v of value) parts.push(flag, String(v));
    } else {
      parts.push(flag, String(value));
    }
  }
  return parts.map(shellQuote).join(" ");
}

/** Product options the CLI takes as flags of their own; any other option goes through `--option key=value`. */
const OPTION_FLAGS = new Set(["size", "stock", "finish", "sides", "fold", "orientation"]);

/** Product options as command arguments every CLI version accepts (spec 01 §7.5). */
export function optionArgs(options: Record<string, string | number>): Record<string, unknown> {
  const named = Object.entries(options).filter(([key]) => OPTION_FLAGS.has(key));
  const others = Object.entries(options).filter(([key]) => !OPTION_FLAGS.has(key));
  return {
    ...Object.fromEntries(named),
    ...(others.length > 0 && { option: others.map(([key, value]) => `${key}=${value}`) }),
  };
}

function shellQuote(s: string): string {
  if (s === "") return "''";
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}
