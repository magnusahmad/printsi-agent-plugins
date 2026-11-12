import {
  API_VERSION,
  AppError,
  BRAND,
  type Envelope,
  errorEnvelopeSchema,
  nextActionSchema,
  successEnvelopeSchema,
} from "@internal/core";
import { z } from "zod";
import { runCheck } from "./check.js";
import { apiGet } from "./http.js";
import {
  addressValidate,
  orderCancel,
  orderCreate,
  orderEvents,
  orderList,
  orderPurchase,
  orderQuote,
  orderReportProblem,
  orderShow,
  orderUpdate,
  orderWait,
  pickupPoints,
  WAIT_TARGETS,
} from "./orders.js";
import { CLI_VERSION, GLOBAL_FLAGS, type Settings } from "./settings.js";
import { feedback, TICKET_CATEGORIES, ticketCreate, ticketList, ticketShow } from "./tickets.js";

export type FlagSpec = {
  type: "string" | "boolean";
  description: string;
  valueName?: string;
  multiple?: boolean;
  /** Required by the command (the CLI checks it; MCP advertises it in the input schema). */
  required?: boolean;
};

export interface CommandContext {
  settings: Settings;
  vars: Record<string, string | undefined>;
  positionals: string[];
  flags: Record<string, string | boolean | string[] | undefined>;
}

export interface Command {
  path: string[];
  summary: string;
  positionals: { name: string; required: boolean; description: string }[];
  flags: Record<string, FlagSpec>;
  examples: string[];
  /** Default --timeout in seconds. */
  timeoutS: number;
  needsNetwork: boolean;
  run(ctx: CommandContext): Promise<Envelope>;
}

/** Named product-option flags (spec 01 §7.5); --option key=value covers the rest. */
const OPTION_FLAGS = ["size", "stock", "finish", "sides", "fold", "orientation"] as const;

const optionFlagSpecs: Record<string, FlagSpec> = {
  ...Object.fromEntries(
    OPTION_FLAGS.map((k) => [
      k,
      { type: "string", description: `Filter by ${k}.`, valueName: "value" } satisfies FlagSpec,
    ]),
  ),
  option: {
    type: "string",
    multiple: true,
    description: "Filter by any option, as key=value. Repeatable.",
    valueName: "key=value",
  },
};

const shipToFlag: FlagSpec = {
  type: "string",
  description: "Delivery address: a JSON file, inline JSON, or - for stdin.",
  valueName: "address",
};

const orderDetailFlags: Record<string, FlagSpec> = {
  pickup: {
    type: "string",
    description:
      'Collect from a pickup point instead of door delivery: a pkp_… id from `pickup-points`, "nearest", or "door" to switch back.',
    valueName: "point",
  },
  "deliver-by": {
    type: "string",
    description: "Deadline (YYYY-MM-DD); used to rank quotes, never a guarantee.",
    valueName: "date",
  },
  "max-total": {
    type: "string",
    description:
      "Budget in the order's currency (USD, in the US and Hong Kong), e.g. 450; quotes above it are flagged.",
    valueName: "amount",
  },
  note: { type: "string", description: "Your note, kept on the order.", valueName: "text" },
};

const orderArg = { name: "order", required: true, description: "Order id (ord_…)." };

const SCHEMAS = {
  envelope: successEnvelopeSchema,
  error: errorEnvelopeSchema,
  "next-action": nextActionSchema,
} as const;

export const COMMANDS: Command[] = [
  {
    path: ["capabilities"],
    summary: `What ${BRAND.name} can print, where it delivers, and which operations exist. No credential needed.`,
    positionals: [],
    flags: {},
    examples: [`${BRAND.name} capabilities`],
    timeoutS: 30,
    needsNetwork: true,
    run: ({ settings }) => apiGet(settings, "/v1/capabilities"),
  },
  {
    path: ["products", "list"],
    summary: "List product families.",
    positionals: [],
    flags: {},
    examples: [`${BRAND.name} products list`],
    timeoutS: 30,
    needsNetwork: true,
    run: ({ settings }) => apiGet(settings, "/v1/products"),
  },
  {
    path: ["products", "show"],
    summary: "Options, defaults, quantities and file requirements for one product.",
    positionals: [{ name: "product", required: true, description: "Product id or alias, e.g. flyer or brochure." }],
    flags: {
      ...optionFlagSpecs,
      region: {
        type: "string",
        description: "Only this region's options, quantities and file rules: US or HK.",
        valueName: "region",
      },
      qty: {
        type: "string",
        description: "Check a quantity against what the printer offers (needs a region, or a size that implies one).",
        valueName: "n",
      },
    },
    examples: [
      `${BRAND.name} products show brochure --fold trifold`,
      `${BRAND.name} products show flyer --option size=8.5x11`,
      `${BRAND.name} products show flyer --region HK --qty 50`,
    ],
    timeoutS: 30,
    needsNetwork: true,
    run: async ({ settings, positionals, flags }) => {
      const product = positionals[0] as string;
      const query = optionQuery(flags);
      if (typeof flags.region === "string") query.region = flags.region;
      if (typeof flags.qty === "string") query.quantity = flags.qty;
      return apiGet(settings, `/v1/products/${encodeURIComponent(product)}`, query);
    },
  },
  {
    path: ["check"],
    summary:
      "Free preflight: checks a PDF against a product's print requirements and returns previews with issues marked. Creates no order and needs no address or payment; the file is stored for the check.",
    positionals: [{ name: "pdf", required: true, description: "Path to the print-ready PDF." }],
    flags: {
      product: { type: "string", description: "Product id or alias, e.g. flyer.", valueName: "id", required: true },
      ...optionFlagSpecs,
      "preview-dir": {
        type: "string",
        description: "Download page previews (PNG, with trim/safe/fold overlays) here.",
        valueName: "dir",
      },
      "all-issues": { type: "boolean", description: "Return every issue instead of up to 3 per code." },
    },
    examples: [
      `${BRAND.name} check flyer.pdf --product flyer --size 8.5x11`,
      `${BRAND.name} check brochure.pdf --product brochure --size 8.5x11 --fold trifold --preview-dir ./preview`,
    ],
    timeoutS: 120,
    needsNetwork: true,
    run: ({ settings, vars, positionals, flags }) => {
      if (typeof flags.product !== "string") {
        throw new AppError("usage", "MISSING_ARGUMENT", "--product is required, e.g. --product flyer.", {
          param: "--product",
          nextActions: [
            {
              kind: "command",
              description: "List products.",
              op: "products.list",
              requires_human: false,
              spends_money: false,
            },
          ],
        });
      }
      return runCheck(settings, vars, {
        file: positionals[0] as string,
        product: flags.product,
        options: optionValues(flags),
        previewDir: typeof flags["preview-dir"] === "string" ? flags["preview-dir"] : undefined,
        allIssues: flags["all-issues"] === true,
      });
    },
  },
  {
    path: ["address", "validate"],
    summary: "Check a delivery address: the contiguous US + DC, or Hong Kong; no PO boxes or military addresses.",
    positionals: [],
    flags: { "ship-to": { ...shipToFlag, required: true } },
    examples: [`${BRAND.name} address validate --ship-to ./office.json`],
    timeoutS: 30,
    needsNetwork: true,
    run: ({ settings, vars, flags }) => addressValidate(settings, vars, flags),
  },
  {
    path: ["mcp"],
    summary:
      "Serve these commands as MCP tools over stdio, for agent hosts (e.g. Hermes). Runs until stdin closes; the bin starts it directly.",
    positionals: [],
    flags: {},
    examples: [`${BRAND.name} mcp --sandbox`],
    timeoutS: 5,
    needsNetwork: false,
    run: async () => {
      throw new AppError(
        "usage",
        "MCP_IS_A_SERVER",
        `Run \`${BRAND.name} mcp\` from an MCP host; it speaks JSON-RPC on stdio.`,
      );
    },
  },
  {
    path: ["pickup-points"],
    summary: "Pickup points (lockers, shops) near a street address, closest first, where the printer offers them.",
    positionals: [],
    flags: {
      "ship-to": { ...shipToFlag, required: true },
      limit: { type: "string", description: "How many to list (1–20, default 5).", valueName: "n" },
    },
    examples: [`${BRAND.name} pickup-points --ship-to ./office.json`],
    timeoutS: 30,
    needsNetwork: true,
    run: ({ settings, vars, flags }) => pickupPoints(settings, vars, flags),
  },
  {
    path: ["order", "create"],
    summary:
      "Create an unpaid draft order with quotes: uploads and checks the PDF, validates the address and returns a quote per shipping method. Nothing is bought; use order_purchase for that.",
    positionals: [],
    flags: {
      file: { type: "string", description: "Print-ready PDF.", valueName: "pdf", required: true },
      product: { type: "string", description: "Product id or alias, e.g. flyer.", valueName: "id", required: true },
      ...optionFlagSpecs,
      qty: { type: "string", description: "Quantity; must be one the product offers.", valueName: "n", required: true },
      "ship-to": { ...shipToFlag, required: true },
      ...orderDetailFlags,
      "client-ref": {
        type: "string",
        description: "Your reference; re-running create with the same one returns the same order.",
        valueName: "ref",
      },
    },
    examples: [
      `${BRAND.name} order create --file flyer.pdf --product flyer --size 8.5x11 --qty 500 --ship-to ./office.json --deliver-by 2026-11-06 --client-ref open-house`,
    ],
    timeoutS: 120,
    needsNetwork: true,
    run: ({ settings, vars, flags }) => orderCreate(settings, vars, flags, optionValues(flags)),
  },
  {
    path: ["order", "update"],
    summary:
      "Change an order's file, options, quantity, address, deadline or budget. Content changes re-check and re-quote.",
    positionals: [orderArg],
    flags: {
      file: { type: "string", description: "Replacement PDF.", valueName: "pdf" },
      product: { type: "string", description: "Change the product.", valueName: "id" },
      ...optionFlagSpecs,
      qty: { type: "string", description: "New quantity.", valueName: "n" },
      "ship-to": shipToFlag,
      ...orderDetailFlags,
    },
    examples: [`${BRAND.name} order update ord_… --file fixed.pdf`, `${BRAND.name} order update ord_… --qty 1000`],
    timeoutS: 120,
    needsNetwork: true,
    run: ({ settings, vars, positionals, flags }) =>
      orderUpdate(settings, vars, positionals[0] as string, flags, optionValues(flags)),
  },
  {
    path: ["order", "quote"],
    summary: "Get fresh quotes for the order as it stands (e.g. after quotes expired).",
    positionals: [orderArg],
    flags: {},
    examples: [`${BRAND.name} order quote ord_…`],
    timeoutS: 120,
    needsNetwork: true,
    run: ({ settings, vars, positionals }) => orderQuote(settings, vars, positionals[0] as string),
  },
  {
    path: ["order", "show"],
    summary: "An order's status, spec, file check, address and quotes.",
    positionals: [orderArg],
    flags: { include: { type: "string", description: "Extra detail, e.g. issues.", valueName: "issues" } },
    examples: [`${BRAND.name} order show ord_…`],
    timeoutS: 30,
    needsNetwork: true,
    run: ({ settings, vars, positionals, flags }) => orderShow(settings, vars, positionals[0] as string, flags),
  },
  {
    path: ["order", "list"],
    summary: "Orders you own, plus orders this machine holds tokens for.",
    positionals: [],
    flags: {
      status: { type: "string", description: "active, all, or a status.", valueName: "status" },
      limit: { type: "string", description: "Maximum to return (default 20).", valueName: "n" },
    },
    examples: [`${BRAND.name} order list --status active`],
    timeoutS: 30,
    needsNetwork: true,
    run: ({ settings, vars, flags }) => orderList(settings, vars, flags),
  },
  {
    path: ["order", "wait"],
    summary: "Wait until the order reaches a state. Exits 9 on timeout; call again to keep waiting.",
    positionals: [orderArg],
    flags: { for: { type: "string", description: `Target: ${WAIT_TARGETS.join(", ")}.`, valueName: "target" } },
    examples: [`${BRAND.name} order wait ord_… --for quoted`],
    timeoutS: 100,
    needsNetwork: true,
    run: ({ settings, vars, positionals, flags }) =>
      orderWait(settings, vars, positionals[0] as string, typeof flags.for === "string" ? flags.for : "quoted"),
  },
  {
    path: ["order", "events"],
    summary: "The order's history: revisions, checks, quotes and status changes.",
    positionals: [orderArg],
    flags: {},
    examples: [`${BRAND.name} order events ord_…`],
    timeoutS: 30,
    needsNetwork: true,
    run: ({ settings, vars, positionals }) => orderEvents(settings, vars, positionals[0] as string),
  },
  {
    path: ["order", "purchase"],
    summary:
      "Request a purchase of a quote. Charges nothing: returns an approval link for the user to review and pay on Stripe's page. The card is held, and charged only once the printer accepts.",
    positionals: [orderArg],
    flags: {
      quote: {
        type: "string",
        description: "The quote to buy (qte_…), usually recommended_quote_id.",
        valueName: "id",
        required: true,
      },
      "max-total": {
        type: "string",
        description: "Refuse if the total is above this, in the order's currency (USD, e.g. 450).",
        valueName: "amount",
      },
    },
    examples: [`${BRAND.name} order purchase ord_… --quote qte_…`],
    timeoutS: 30,
    needsNetwork: true,
    run: ({ settings, vars, positionals, flags }) => orderPurchase(settings, vars, positionals[0] as string, flags),
  },
  {
    path: ["order", "report-problem"],
    summary: "Report a Cloudprinter delivery or print problem and request a supplier remedy.",
    positionals: [orderArg],
    flags: {
      kind: {
        type: "string",
        description: "damaged, missing, misprint, wrong_item or late.",
        valueName: "kind",
        required: true,
      },
      description: { type: "string", description: "What happened.", valueName: "text", required: true },
      quantity: { type: "string", description: "Number of affected copies.", valueName: "number", required: true },
    },
    examples: [`${BRAND.name} order report-problem ord_… --kind damaged --description "Bent corners" --quantity 5`],
    timeoutS: 30,
    needsNetwork: true,
    run: ({ settings, vars, positionals, flags }) =>
      orderReportProblem(settings, vars, positionals[0] as string, flags),
  },
  {
    path: ["order", "cancel"],
    summary: "Cancel an unpaid order. A paid order has gone to the printer and can't be canceled.",
    positionals: [orderArg],
    flags: { reason: { type: "string", description: "Why, for the record.", valueName: "text" } },
    examples: [`${BRAND.name} order cancel ord_… --reason "wrong file"`],
    timeoutS: 30,
    needsNetwork: true,
    run: ({ settings, vars, positionals, flags }) =>
      orderCancel(
        settings,
        vars,
        positionals[0] as string,
        typeof flags.reason === "string" ? flags.reason : undefined,
      ),
  },
  {
    path: ["ticket", "create"],
    summary:
      "File a support ticket when something went wrong (a check, an order, payment, or printsi itself). With --order, the order's history is attached. A person reads every ticket; replies go to the email that paid for the order.",
    positionals: [],
    flags: {
      message: {
        type: "string",
        description: "What happened and what you expected (10–4000 characters). Include error codes and request ids.",
        valueName: "text",
        required: true,
      },
      order: { type: "string", description: "The order it's about (ord_…), if any.", valueName: "id" },
      category: {
        type: "string",
        description: `One of: ${TICKET_CATEGORIES.join(", ")}.`,
        valueName: "category",
      },
      subject: {
        type: "string",
        description: "One-line summary (defaults to the message's first line).",
        valueName: "text",
      },
      email: {
        type: "string",
        description: "Where to reply when there's no order (the user's own address, only with their permission).",
        valueName: "address",
      },
    },
    examples: [
      `${BRAND.name} ticket create --order ord_… --category order_problem --message "Order says shipped 5 days ago but tracking hasn't moved."`,
    ],
    timeoutS: 30,
    needsNetwork: true,
    run: ({ settings, vars, flags }) => ticketCreate(settings, vars, flags),
  },
  {
    path: ["ticket", "show"],
    summary: "A ticket's status, our replies and the resolution.",
    positionals: [{ name: "ticket", required: true, description: "Ticket id (tkt_…)." }],
    flags: {},
    examples: [`${BRAND.name} ticket show tkt_…`],
    timeoutS: 30,
    needsNetwork: true,
    run: ({ settings, vars, positionals }) => ticketShow(settings, vars, positionals[0] as string),
  },
  {
    path: ["ticket", "list"],
    summary: "Tickets and feedback you've filed.",
    positionals: [],
    flags: {},
    examples: [`${BRAND.name} ticket list`],
    timeoutS: 30,
    needsNetwork: true,
    run: ({ settings, vars }) => ticketList(settings, vars),
  },
  {
    path: ["feedback"],
    summary:
      "Send feedback about printsi: what worked, what didn't, what you wish it did. Goes straight to the people building it.",
    positionals: [],
    flags: {
      message: { type: "string", description: "The feedback (10–4000 characters).", valueName: "text", required: true },
      rating: { type: "string", description: "Optional 1–5.", valueName: "n" },
      order: { type: "string", description: "The order it's about (ord_…), if any.", valueName: "id" },
    },
    examples: [`${BRAND.name} feedback --rating 5 --message "Check caught the missing bleed before I paid."`],
    timeoutS: 30,
    needsNetwork: true,
    run: ({ settings, vars, flags }) => feedback(settings, vars, flags),
  },
  {
    path: ["help"],
    summary: "Describe commands. With --format json, a machine-readable command spec.",
    positionals: [{ name: "command", required: false, description: "Limit to one command, e.g. 'products show'." }],
    flags: {},
    examples: [`${BRAND.name} help --format json`, `${BRAND.name} help products show`],
    timeoutS: 5,
    needsNetwork: false,
    run: async ({ positionals }) => {
      const wanted = positionals.join(" ");
      const commands = COMMANDS.filter((c) => !wanted || c.path.join(" ") === wanted);
      if (commands.length === 0) throw unknownCommand(positionals);
      return {
        ok: true,
        summary: wanted
          ? (commands[0] as Command).summary
          : `${BRAND.name} ${CLI_VERSION}: ${COMMANDS.length} commands.`,
        data: {
          cli: BRAND.name,
          version: CLI_VERSION,
          global_flags: GLOBAL_FLAGS,
          commands: commands.map(describeCommand),
        },
        next_actions: [],
      };
    },
  },
  {
    path: ["schema"],
    summary: "JSON Schema (2020-12) for response objects.",
    positionals: [{ name: "name", required: false, description: `One of: ${Object.keys(SCHEMAS).join(", ")}.` }],
    flags: {},
    examples: [`${BRAND.name} schema envelope`],
    timeoutS: 5,
    needsNetwork: false,
    run: async ({ positionals }) => {
      const name = positionals[0];
      if (name !== undefined && !(name in SCHEMAS)) {
        throw new AppError("invalid_request", "UNKNOWN_SCHEMA", `No schema called "${name}".`, {
          details: { allowed: Object.keys(SCHEMAS) },
        });
      }
      const names = name ? [name as keyof typeof SCHEMAS] : (Object.keys(SCHEMAS) as (keyof typeof SCHEMAS)[]);
      return {
        ok: true,
        data: { schemas: Object.fromEntries(names.map((n) => [n, z.toJSONSchema(SCHEMAS[n])])) },
        next_actions: [],
      };
    },
  },
  {
    path: ["version"],
    summary: "CLI version and supported API version.",
    positionals: [],
    flags: {},
    examples: [`${BRAND.name} version`],
    timeoutS: 5,
    needsNetwork: false,
    run: async ({ settings }) => ({
      ok: true,
      summary: `${BRAND.name} ${CLI_VERSION} (API ${API_VERSION}, ${settings.env}).`,
      data: {
        version: CLI_VERSION,
        api_version: API_VERSION,
        env: settings.env,
        api_base: settings.apiBase,
        node: process.versions.node,
      },
      next_actions: [],
    }),
  },
];

/** Finds the command named by the leading words of argv. */
export function findCommand(words: string[]): { command: Command; consumed: number } | undefined {
  for (const command of [...COMMANDS].sort((a, b) => b.path.length - a.path.length)) {
    if (command.path.every((p, i) => words[i] === p)) return { command, consumed: command.path.length };
  }
  return undefined;
}

export function unknownCommand(words: string[]): AppError {
  return new AppError("usage", "UNKNOWN_COMMAND", `Unknown command "${words.join(" ")}".`, {
    details: { available: COMMANDS.map((c) => c.path.join(" ")) },
    nextActions: [
      { kind: "command", description: "List commands.", op: "help", requires_human: false, spends_money: false },
    ],
  });
}

function describeCommand(c: Command) {
  return {
    command: c.path.join(" "),
    summary: c.summary,
    positionals: c.positionals,
    flags: c.flags,
    examples: c.examples,
    default_timeout_s: c.timeoutS,
  };
}

/** Named option flags plus repeatable --option key=value, as a plain map. */
function optionValues(flags: CommandContext["flags"]): Record<string, string> {
  const options: Record<string, string> = {};
  for (const key of OPTION_FLAGS) {
    const v = flags[key];
    if (typeof v === "string") options[key] = v.trim().toLowerCase();
  }
  const generic = flags.option;
  for (const pair of Array.isArray(generic) ? generic : []) {
    const eq = pair.indexOf("=");
    if (eq <= 0) {
      throw new AppError("usage", "INVALID_FLAG_VALUE", `--option expects key=value, got "${pair}".`, {
        param: "--option",
      });
    }
    options[pair.slice(0, eq).trim().toLowerCase()] = pair
      .slice(eq + 1)
      .trim()
      .toLowerCase();
  }
  return options;
}

function optionQuery(flags: CommandContext["flags"]): Record<string, string> {
  return Object.fromEntries(Object.entries(optionValues(flags)).map(([k, v]) => [`option.${k}`, v]));
}
