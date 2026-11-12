import { z } from "zod";

/** Error types and their CLI exit codes and HTTP statuses (spec 01 §5, 02 §6). */
export const ERROR_TYPES = {
  internal: { exit: 1, http: 500 },
  usage: { exit: 2, http: 400 },
  invalid_request: { exit: 3, http: 400 },
  unsupported: { exit: 3, http: 400 },
  authentication: { exit: 4, http: 401 },
  permission: { exit: 4, http: 403 },
  not_found: { exit: 5, http: 404 },
  conflict: { exit: 6, http: 409 },
  authority_exceeded: { exit: 7, http: 402 },
  payment_failed: { exit: 7, http: 402 },
  unavailable: { exit: 8, http: 503 },
  rate_limited: { exit: 8, http: 429 },
  timeout: { exit: 9, http: 504 },
} as const;

export type ErrorType = keyof typeof ERROR_TYPES;

const errorTypeSchema = z.enum(Object.keys(ERROR_TYPES) as [ErrorType, ...ErrorType[]]);

export const nextActionSchema = z
  .object({
    kind: z.enum(["command", "human", "wait", "fix_file"]),
    description: z.string(),
    /** Structured operation, e.g. "products.show". The API sends this; clients render it. */
    op: z.string().optional(),
    args: z.record(z.string(), z.unknown()).optional(),
    /** Rendered CLI command. Added by the CLI from op + args. */
    command: z.string().optional(),
    url: z.string().optional(),
    expires_at: z.string().optional(),
    requires_human: z.boolean(),
    spends_money: z.boolean(),
  })
  .meta({ id: "NextAction" });

export const warningSchema = z.object({ code: z.string(), message: z.string() }).meta({ id: "Warning" });

export const errorBodySchema = z
  .object({
    type: errorTypeSchema,
    code: z.string(),
    message: z.string(),
    retryable: z.boolean(),
    param: z.string().optional(),
    details: z.record(z.string(), z.unknown()).optional(),
  })
  .meta({ id: "ErrorBody" });

const common = {
  env: z.enum(["live", "sandbox"]).optional(),
  api_version: z.string().optional(),
  request_id: z.string().optional(),
  next_actions: z.array(nextActionSchema),
  warnings: z.array(warningSchema).optional(),
};

export const successEnvelopeSchema = z
  .object({
    ok: z.literal(true),
    summary: z.string().optional(),
    data: z.unknown(),
    ...common,
  })
  .meta({ id: "SuccessEnvelope" });

export const errorEnvelopeSchema = z
  .object({
    ok: z.literal(false),
    error: errorBodySchema,
    ...common,
  })
  .meta({ id: "ErrorEnvelope" });

export type NextAction = z.infer<typeof nextActionSchema>;
export type Warning = z.infer<typeof warningSchema>;
export type ErrorBody = z.infer<typeof errorBodySchema>;
export type SuccessEnvelope<T = unknown> = Omit<z.infer<typeof successEnvelopeSchema>, "data"> & { data: T };
export type ErrorEnvelope = z.infer<typeof errorEnvelopeSchema>;
export type Envelope<T = unknown> = SuccessEnvelope<T> | ErrorEnvelope;

export function exitCodeFor(envelope: Envelope): number {
  return envelope.ok ? 0 : ERROR_TYPES[envelope.error.type].exit;
}
