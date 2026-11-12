import { parseArgs } from "node:util";
import { AppError, BRAND, type Envelope, exitCodeFor, renderCommand } from "@internal/core";
import { COMMANDS, type Command, type FlagSpec, findCommand, unknownCommand } from "./commands.js";
import { GLOBAL_FLAGS, resolveSettings, type Settings } from "./settings.js";
import { renderText } from "./text.js";

export interface RunResult {
  stdout: string;
  exitCode: number;
  envelope: Envelope;
}

/** Runs one CLI invocation. Pure apart from the network: callers write stdout and set the exit code. */
export async function run(argv: string[], vars: Record<string, string | undefined> = process.env): Promise<RunResult> {
  let settings: Settings = resolveSettings({}, vars, 30);
  let envelope: Envelope;
  try {
    const words = commandWords(argv);
    const wantsHelp = argv.includes("--help") || argv.includes("-h");
    const match = findCommand(words);
    if (words.length === 0 || (wantsHelp && !match)) {
      settings = resolveSettings(globalFlags(argv), vars, 5);
      envelope = await helpFor([], settings);
    } else if (!match) {
      throw unknownCommand(words);
    } else if (wantsHelp) {
      settings = resolveSettings(globalFlags(argv), vars, 5);
      envelope = await helpFor(match.command.path, settings);
    } else {
      const { command, consumed } = match;
      const parsed = parseCommandArgs(command, removeWords(argv, words.slice(0, consumed)));
      settings = resolveSettings(parsed.values, vars, command.timeoutS);
      checkPositionals(command, parsed.positionals);
      envelope = await command.run({ settings, vars, positionals: parsed.positionals, flags: parsed.values });
    }
  } catch (err) {
    envelope = toErrorEnvelope(err);
  }
  envelope = finalize(envelope, settings);
  const stdout = settings.format === "text" ? renderText(envelope) : `${JSON.stringify(envelope, null, 2)}\n`;
  return { stdout, exitCode: exitCodeFor(envelope), envelope };
}

/** Leading bare words before the first non-global flag, skipping global flags and their values. */
function commandWords(argv: string[]): string[] {
  const words: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i] as string;
    if (!token.startsWith("-")) {
      words.push(token);
      continue;
    }
    const name = token.replace(/^--?/, "").split("=")[0] as string;
    const spec = (GLOBAL_FLAGS as Record<string, FlagSpec>)[name];
    if (!spec && name !== "help" && name !== "h") break;
    if (spec?.type === "string" && !token.includes("=")) i++;
  }
  return words;
}

function removeWords(argv: string[], words: string[]): string[] {
  const rest = [...argv];
  for (const w of words) rest.splice(rest.indexOf(w), 1);
  return rest;
}

function globalFlags(argv: string[]) {
  return parseArgs({
    args: argv.filter((a) => a !== "--help" && a !== "-h"),
    options: toParseArgsOptions(GLOBAL_FLAGS),
    allowPositionals: true,
    strict: false,
  }).values as Record<string, string | boolean | undefined>;
}

function parseCommandArgs(command: Command, args: string[]) {
  try {
    const { values, positionals } = parseArgs({
      args,
      options: toParseArgsOptions({ ...GLOBAL_FLAGS, ...command.flags }),
      allowPositionals: true,
      strict: true,
    });
    return { values: values as Record<string, string | boolean | string[] | undefined>, positionals };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const code = /unknown option/i.test(message) ? "UNKNOWN_FLAG" : "INVALID_FLAG_VALUE";
    throw new AppError("usage", code, message, {
      details: { command: command.path.join(" "), flags: Object.keys({ ...GLOBAL_FLAGS, ...command.flags }) },
      nextActions: [helpAction(command.path)],
    });
  }
}

function checkPositionals(command: Command, positionals: string[]) {
  const required = command.positionals.filter((p) => p.required);
  if (positionals.length < required.length) {
    const missing = required[positionals.length] as Command["positionals"][number];
    throw new AppError("usage", "MISSING_ARGUMENT", `Missing <${missing.name}>: ${missing.description}`, {
      param: missing.name,
      nextActions: [helpAction(command.path)],
    });
  }
  // help takes a multi-word command name; everything else takes at most its declared positionals.
  if (command.path[0] !== "help" && positionals.length > command.positionals.length) {
    throw new AppError(
      "usage",
      "UNEXPECTED_ARGUMENT",
      `Unexpected argument "${positionals[command.positionals.length]}".`,
      {
        nextActions: [helpAction(command.path)],
      },
    );
  }
}

function toParseArgsOptions(flags: Record<string, FlagSpec>) {
  return Object.fromEntries(
    Object.entries(flags).map(([name, f]) => [name, { type: f.type, ...(f.multiple && { multiple: true }) }]),
  ) as Record<string, { type: "string" | "boolean"; multiple?: boolean }>;
}

async function helpFor(path: string[], settings: Settings): Promise<Envelope> {
  const help = COMMANDS.find((c) => c.path[0] === "help") as Command;
  return help.run({ settings, vars: {}, positionals: path, flags: {} });
}

function helpAction(path: string[]) {
  return {
    kind: "command" as const,
    description: `Show usage for ${path.join(" ")}.`,
    op: "help",
    args: { _: path },
    requires_human: false,
    spends_money: false,
  };
}

function toErrorEnvelope(err: unknown): Envelope {
  const appError =
    err instanceof AppError
      ? err
      : new AppError(
          "internal",
          "INTERNAL",
          `Unexpected CLI error: ${err instanceof Error ? err.message : String(err)}`,
        );
  return { ok: false, error: appError.toBody(), next_actions: appError.nextActions };
}

/**
 * Adds env and renders structured next actions as runnable commands (spec 02 §1).
 * The server's own env wins over the CLI's: with --api-base the CLI can't know which env it reached.
 */
function finalize(envelope: Envelope, settings: Settings): Envelope {
  const env = envelope.env ?? settings.env;
  const warnings = [...(envelope.warnings ?? [])];
  if (env !== settings.env) {
    warnings.push({
      code: "ENV_MISMATCH",
      message: `${settings.apiBase} is the ${env} environment, but the CLI is in ${settings.env} mode. ${
        env === "sandbox" ? "Pass --sandbox." : "Remove --sandbox."
      }`,
    });
  }
  const nextActions = envelope.next_actions.map((action) => {
    if (!action.op || action.command) return action;
    const args = { ...action.args, ...(env === "sandbox" && { sandbox: true }) };
    return { ...action, command: renderCommand(action.op, args, BRAND.name) };
  });
  return { ...envelope, env, next_actions: nextActions, ...(warnings.length > 0 && { warnings }) };
}
