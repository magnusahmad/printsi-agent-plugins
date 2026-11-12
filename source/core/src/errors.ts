import { ERROR_TYPES, type ErrorBody, type ErrorType, type NextAction } from "./envelope.js";

const RETRYABLE: ReadonlySet<ErrorType> = new Set(["unavailable", "rate_limited"]);

/** A failure that maps to a documented error code (spec 01 §10). Thrown by server and CLI code alike. */
export class AppError extends Error {
  readonly type: ErrorType;
  readonly code: string;
  readonly param: string | undefined;
  readonly details: Record<string, unknown> | undefined;
  readonly retryable: boolean;
  readonly nextActions: NextAction[];

  constructor(
    type: ErrorType,
    code: string,
    message: string,
    opts: { param?: string; details?: Record<string, unknown>; retryable?: boolean; nextActions?: NextAction[] } = {},
  ) {
    super(message);
    this.name = "AppError";
    this.type = type;
    this.code = code;
    this.param = opts.param;
    this.details = opts.details;
    this.retryable = opts.retryable ?? RETRYABLE.has(type);
    this.nextActions = opts.nextActions ?? [];
  }

  get httpStatus(): number {
    return ERROR_TYPES[this.type].http;
  }

  toBody(): ErrorBody {
    const body: ErrorBody = { type: this.type, code: this.code, message: this.message, retryable: this.retryable };
    if (this.param !== undefined) body.param = this.param;
    if (this.details !== undefined) body.details = this.details;
    return body;
  }
}
