/**
 * Base class for every error this library throws. Catch this to catch them all.
 */
export class ElvantoError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = new.target.name
  }
}

/**
 * The request reached Elvanto and it answered with `status: "fail"`, or with a
 * non-2xx HTTP status.
 *
 * Elvanto's error codes are not HTTP codes — a documented `250` means "invalid
 * page number" and arrives with HTTP 200. `httpStatus` and `code` are therefore
 * tracked separately.
 */
export class ElvantoApiError extends ElvantoError {
  readonly httpStatus: number
  /** Elvanto's own error code, when the body carried one. */
  readonly code: number | undefined
  readonly endpoint: string
  /** Raw parsed body, for anything the typed fields don't capture. */
  readonly body: unknown

  constructor(args: {
    message: string
    httpStatus: number
    code?: number | undefined
    endpoint: string
    body?: unknown
  }) {
    super(`Elvanto ${args.endpoint} failed: ${args.message}`)
    this.httpStatus = args.httpStatus
    this.code = args.code
    this.endpoint = args.endpoint
    this.body = args.body
  }

  /** Bad or missing credentials. */
  get isAuthError(): boolean {
    return this.httpStatus === 401 || this.httpStatus === 403
  }

  /**
   * Elvanto returns 404 both for "that ID doesn't exist" and for "no records
   * match your filters", so this covers both.
   */
  get isNotFound(): boolean {
    return this.httpStatus === 404
  }

  get isRateLimited(): boolean {
    return this.httpStatus === 429
  }
}

/** The request never completed — DNS failure, socket error, timeout, abort. */
export class ElvantoTransportError extends ElvantoError {
  readonly endpoint: string

  constructor(args: { message: string; endpoint: string; cause?: unknown }) {
    super(`Elvanto ${args.endpoint} request failed: ${args.message}`, {
      cause: args.cause,
    })
    this.endpoint = args.endpoint
  }
}

/** Parameters failed validation before anything was sent. */
export class ElvantoRequestValidationError extends ElvantoError {
  readonly endpoint: string
  readonly issues: ValidationIssue[]

  constructor(args: { endpoint: string; issues: ValidationIssue[] }) {
    super(
      `Invalid parameters for ${args.endpoint}:\n${formatIssues(args.issues)}`,
    )
    this.endpoint = args.endpoint
    this.issues = args.issues
  }
}

/**
 * Elvanto answered successfully but the payload didn't match our schema.
 *
 * Only thrown when `validate` is `"throw"`. Because Elvanto publishes no
 * machine-readable spec — our schemas are derived from documentation examples —
 * this most often means the API returned something real that we model wrongly,
 * not that the data is bad. `data` carries the unvalidated payload so callers
 * who catch this can still use it.
 */
export class ElvantoResponseValidationError extends ElvantoError {
  readonly endpoint: string
  readonly issues: ValidationIssue[]
  /** The raw, unvalidated response payload. */
  readonly data: unknown

  constructor(args: {
    endpoint: string
    issues: ValidationIssue[]
    data: unknown
  }) {
    super(
      `Unexpected response shape from ${args.endpoint}:\n${formatIssues(
        args.issues,
      )}\n\nThis usually means Elvanto's API differs from its documentation. ` +
        `Re-run with validate: "warn" to use the data anyway, and please report it.`,
    )
    this.endpoint = args.endpoint
    this.issues = args.issues
    this.data = args.data
  }
}

export interface ValidationIssue {
  /** Dotted path to the offending value, e.g. `people.person[0].id`. */
  path: string
  message: string
}

function formatIssues(issues: ValidationIssue[]): string {
  return issues
    .slice(0, 20)
    .map((i) => `  - ${i.path || '(root)'}: ${i.message}`)
    .join('\n')
}
