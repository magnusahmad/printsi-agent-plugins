import { AppError, type Envelope } from "@internal/core";
import { apiRequest } from "./http.js";
import { withOrderCredential } from "./orders.js";
import { withCredential } from "./session.js";
import { CLI_VERSION, type Settings } from "./settings.js";

/** `ticket …` and `feedback` (support from inside printsi): filed against the caller's key, or the order's token. */

type Vars = Record<string, string | undefined>;
type Flags = Record<string, string | boolean | string[] | undefined>;

export const TICKET_CATEGORIES = ["order_problem", "check_problem", "payment", "bug", "question", "other"] as const;

export async function ticketCreate(settings: Settings, vars: Vars, flags: Flags): Promise<Envelope> {
  const message = requireText(flags.message, "--message");
  const category = typeof flags.category === "string" ? flags.category : undefined;
  if (category && !(TICKET_CATEGORIES as readonly string[]).includes(category)) {
    throw new AppError("usage", "INVALID_FLAG_VALUE", `--category must be one of: ${TICKET_CATEGORIES.join(", ")}.`, {
      param: "--category",
    });
  }
  return file(settings, vars, flags, {
    kind: "ticket",
    message,
    ...(category && { category }),
    ...(typeof flags.subject === "string" && { subject: flags.subject }),
    ...(typeof flags.email === "string" && { contact_email: flags.email }),
  });
}

export async function feedback(settings: Settings, vars: Vars, flags: Flags): Promise<Envelope> {
  const message = requireText(flags.message, "--message");
  let rating: number | undefined;
  if (flags.rating !== undefined) {
    rating = Number(flags.rating);
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
      throw new AppError("usage", "INVALID_FLAG_VALUE", "--rating must be 1–5.", { param: "--rating" });
    }
  }
  return file(settings, vars, flags, { kind: "feedback", message, ...(rating !== undefined && { rating }) });
}

export async function ticketShow(settings: Settings, vars: Vars, id: string): Promise<Envelope> {
  return withCredential(settings, vars, () => apiRequest(settings, { path: `/v1/tickets/${encodeURIComponent(id)}` }));
}

export async function ticketList(settings: Settings, vars: Vars): Promise<Envelope> {
  return withCredential(settings, vars, () => apiRequest(settings, { path: "/v1/tickets" }));
}

async function file(settings: Settings, vars: Vars, flags: Flags, body: Record<string, unknown>): Promise<Envelope> {
  const order = typeof flags.order === "string" ? flags.order : undefined;
  const json = {
    ...body,
    ...(order && { order_id: order }),
    client: {
      cli_version: CLI_VERSION,
      platform: process.platform,
      node: process.versions.node,
      ...(vars.PRINTSI_HOST && { host: vars.PRINTSI_HOST }),
    },
  };
  const send = () => apiRequest(settings, { method: "POST", path: "/v1/tickets", json });
  return order ? withOrderCredential(settings, vars, order, send) : withCredential(settings, vars, send);
}

function requireText(value: unknown, flag: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new AppError("usage", "MISSING_ARGUMENT", `${flag} is required: say what happened and what you expected.`, {
      param: flag,
    });
  }
  return value;
}
