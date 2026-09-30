import {
  ElvantoApiError,
  ElvantoError,
  ElvantoTransportError,
  ElvantoWriteOutcomeUnknownError,
  type ValidationIssue,
} from './errors.js'
import { envelopeSchema, type Envelope } from './normalize.js'
import {
  describeParamsForLog,
  resolveLogging,
  type DebugMode,
  type ElvantoLogger,
  type ResolvedLogging,
} from './logging.js'

export const DEFAULT_BASE_URL = 'https://api.elvanto.com/v1'
export const DEFAULT_TIMEOUT_MS = 30_000
export const DEFAULT_MAX_RETRIES = 2
/** See {@link ElvantoClientOptions.sameRecordWriteGapMs}. */
export const DEFAULT_SAME_RECORD_WRITE_GAP_MS = 1_100

/**
 * What to do when a response doesn't match our schema.
 *
 * - `throw` (default): raise {@link ElvantoResponseValidationError}. Surfaces
 *   API drift immediately; recommended for tests and CI.
 * - `warn`: hand back the payload and report the mismatch through `onWarning`.
 *   Elvanto publishes no machine-readable spec, so this is the pragmatic choice
 *   for production code that must not break on a new field. Records that do
 *   validate keep their normalization; only the offending record is returned raw.
 * - `off`: skip response validation entirely.
 *
 * Request parameters are always validated, regardless of this setting.
 *
 * ## Types under `warn` and `off`
 *
 * The static types describe the *validated* shape, so under these two modes they
 * are a claim rather than a guarantee: a result typed `Person[]` may contain an
 * item that failed validation and came back unchanged. That is the point of the
 * modes — keep working when a schema is imperfect — but treat a field as
 * possibly-absent if you have turned strictness off, and use `throw` in tests so
 * the claim is actually checked somewhere.
 */
export type ValidationMode = 'throw' | 'warn' | 'off'

export interface ElvantoValidationWarning {
  endpoint: string
  message: string
  issues: ValidationIssue[]
  /** The unvalidated payload that was returned to the caller anyway. */
  data: unknown
}

/** Authenticate with an account-wide secret API key. */
export interface ApiKeyAuth {
  apiKey: string
}

/** Authenticate with a fixed OAuth 2 access token. */
export interface AccessTokenAuth {
  accessToken: string
}

/**
 * Authenticate with a token fetched on demand — the hook for OAuth refresh,
 * called before every request so an expiring token can be rotated.
 */
export interface TokenProviderAuth {
  getAccessToken: () => string | Promise<string>
}

export type ElvantoAuth = ApiKeyAuth | AccessTokenAuth | TokenProviderAuth

export interface ElvantoClientOptions {
  /**
   * Credentials. Omit to read `ELVANTO_API_KEY` or `ELVANTO_ACCESS_TOKEN` from
   * the environment.
   */
  auth?: ElvantoAuth
  /**
   * Override the API root. Falls back to `ELVANTO_BASE_URL`, then to the
   * documented production URL. Mainly for testing against a stub.
   */
  baseUrl?: string
  /** Inject a `fetch` implementation. Defaults to the global one. */
  fetch?: typeof globalThis.fetch
  /** Per-request timeout in milliseconds. Default 30000. */
  timeoutMs?: number
  /**
   * Retries for rate limits, 5xx responses and network faults. Default 2.
   * Only ever applied to read-only endpoints in this version.
   */
  maxRetries?: number
  /**
   * Minimum gap between the start of one request and the next, in milliseconds.
   * Default 0 — off.
   *
   * Elvanto documents no rate limits, so this library reacts to a 429 rather than
   * predicting one. Set this to avoid provoking one in the first place: paging
   * through a large account, or fanning out `getInfo` calls, otherwise issues
   * requests as fast as they complete.
   *
   * Enforced in the transport, so it applies to concurrent callers too — a
   * `Promise.all` of 100 calls is spaced out rather than arriving at once.
   */
  minRequestIntervalMs?: number
  /**
   * Minimum gap between the end of one write to a record and the start of the
   * next write to the same record, in milliseconds. Default 1100.
   *
   * Elvanto refuses a second edit to the same person within the same wall-clock
   * second with "we've run into a problem when saving to the database", and
   * applies nothing. Seen live, with the edits otherwise valid. Writes to
   * different records are not held up. Set 0 to turn this off.
   */
  sameRecordWriteGapMs?: number
  /** Response validation strictness. Default `"throw"`. */
  validate?: ValidationMode
  /** Called when `validate: "warn"` swallows a schema mismatch. */
  onWarning?: (warning: ElvantoValidationWarning) => void
  /** Appended to the default User-Agent. */
  userAgent?: string
  /**
   * Diagnostic logging: `true` for requests, timings and retries, `"verbose"` to
   * include parameter values. Defaults to `ELVANTO_DEBUG`, else off.
   *
   * Credentials and response records are never logged — see {@link DebugMode}.
   */
  debug?: boolean | DebugMode
  /** Route log events into your own logging stack instead of stderr. */
  logger?: ElvantoLogger
}

export interface RequestOptions {
  /** Abort the request early. Combined with the configured timeout. */
  signal?: AbortSignal
  /** Override the client's validation mode for this call. */
  validate?: ValidationMode
  /**
   * Extra body parameters, merged over the validated ones and sent as-is.
   *
   * An escape hatch for parameters this version doesn't model — Elvanto ships
   * API changes ahead of its documentation. These bypass parameter validation
   * entirely, so a typo here reaches Elvanto rather than being caught locally.
   */
  extraParams?: Record<string, unknown>
}

interface ResolvedOptions {
  baseUrl: string
  fetchImpl: typeof globalThis.fetch
  timeoutMs: number
  maxRetries: number
  minRequestIntervalMs: number
  sameRecordWriteGapMs: number
  validate: ValidationMode
  onWarning: ((warning: ElvantoValidationWarning) => void) | undefined
  userAgent: string
}

const PACKAGE_VERSION = '0.1.0'

/**
 * Resolves credentials, applying environment fallbacks.
 *
 * An explicit API key wins over an explicit token; between the two environment
 * variables, `ELVANTO_API_KEY` wins.
 */
export function resolveAuth(
  auth: ElvantoAuth | undefined,
  env: Record<string, string | undefined> = process.env,
): ElvantoAuth {
  if (auth) {
    if ('apiKey' in auth && auth.apiKey) return auth
    if ('accessToken' in auth && auth.accessToken) return auth
    if ('getAccessToken' in auth) return auth
    throw new ElvantoError(
      'Empty credentials supplied. Pass { apiKey }, { accessToken } or { getAccessToken }.',
    )
  }

  const apiKey = env['ELVANTO_API_KEY']?.trim()
  if (apiKey) return { apiKey }

  const accessToken = env['ELVANTO_ACCESS_TOKEN']?.trim()
  if (accessToken) return { accessToken }

  throw new ElvantoError(
    'No Elvanto credentials found. Pass { auth: { apiKey } } or set ELVANTO_API_KEY ' +
      '(Elvanto: Settings > Account Settings > Secret API Key).',
  )
}

/**
 * Reads a validation mode from a string, e.g. an environment variable or CLI
 * flag. Returns `undefined` for absent input and throws on nonsense.
 */
export function parseValidationMode(
  value: string | undefined,
): ValidationMode | undefined {
  if (value == null || value.trim() === '') return undefined
  const v = value.trim().toLowerCase()
  if (v === 'throw' || v === 'strict') return 'throw'
  if (v === 'warn') return 'warn'
  if (v === 'off' || v === 'none' || v === 'false') return 'off'
  throw new ElvantoError(
    `Invalid validation mode "${value}". Expected "throw", "warn" or "off".`,
  )
}

/**
 * Builds the Authorization header.
 *
 * API keys use HTTP Basic with the key as the username and an ignored password,
 * which is what Elvanto documents (`curl -u "API_KEY:x"`).
 */
async function authorizationHeader(auth: ElvantoAuth): Promise<string> {
  if ('apiKey' in auth) {
    return `Basic ${Buffer.from(`${auth.apiKey}:x`).toString('base64')}`
  }
  if ('accessToken' in auth) {
    return `Bearer ${auth.accessToken}`
  }
  const token = await auth.getAccessToken()
  if (!token) {
    throw new ElvantoError('getAccessToken() returned an empty token.')
  }
  return `Bearer ${token}`
}

/**
 * The HTTP layer: one POST per call, envelope unwrapping, error mapping and
 * retries. Endpoint semantics live in the registry, not here.
 */
export class Transport {
  private readonly auth: ElvantoAuth
  private readonly options: ResolvedOptions
  readonly logging: ResolvedLogging

  /**
   * Serialises slot acquisition for request pacing.
   *
   * Each caller awaits the previous one before checking the clock, so concurrent
   * callers queue instead of all passing the same check at once. The gate is
   * released as soon as a slot is taken, not when the request finishes — the aim
   * is to space request *starts*, not to serialise the requests themselves.
   */
  private pacingGate: Promise<void> = Promise.resolve()
  private lastRequestStartedAt = 0

  /**
   * The latest write to each record: a promise that settles when it finishes,
   * and when that was. Each write to a record waits on the one before, so
   * concurrent writes queue rather than landing in the same second.
   *
   * No timer outlives a write. One that did would either hold the process open
   * after its last request or, unreferenced, let it exit under a waiter.
   */
  private readonly recordWrites = new Map<string, { done: Promise<void>; finishedAt: number }>()

  constructor(options: ElvantoClientOptions = {}) {
    this.logging = resolveLogging(options.debug, options.logger)
    this.auth = resolveAuth(options.auth)

    const fetchImpl = options.fetch ?? globalThis.fetch
    if (typeof fetchImpl !== 'function') {
      throw new ElvantoError(
        'No fetch implementation available. Use Node 20+ or pass { fetch }.',
      )
    }

    this.options = {
      baseUrl: (
        options.baseUrl ??
        process.env['ELVANTO_BASE_URL']?.trim() ??
        DEFAULT_BASE_URL
      ).replace(/\/+$/, ''),
      fetchImpl,
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxRetries: options.maxRetries ?? DEFAULT_MAX_RETRIES,
      minRequestIntervalMs: Math.max(options.minRequestIntervalMs ?? 0, 0),
      sameRecordWriteGapMs: Math.max(options.sameRecordWriteGapMs ?? DEFAULT_SAME_RECORD_WRITE_GAP_MS, 0),
      validate: options.validate ?? 'throw',
      onWarning: options.onWarning,
      userAgent: options.userAgent
        ? `elvanto-js/${PACKAGE_VERSION} ${options.userAgent}`
        : `elvanto-js/${PACKAGE_VERSION}`,
    }
  }

  get validationMode(): ValidationMode {
    return this.options.validate
  }

  get onWarning(): ((warning: ElvantoValidationWarning) => void) | undefined {
    return this.options.onWarning
  }

  /** True when authenticating with an API key rather than OAuth. */
  get usesApiKey(): boolean {
    return 'apiKey' in this.auth
  }

  /** Waits until the configured minimum gap since the last request has elapsed. */
  private async takePacingSlot(): Promise<void> {
    const interval = this.options.minRequestIntervalMs
    if (interval <= 0) return

    const previous = this.pacingGate
    let release!: () => void
    this.pacingGate = new Promise<void>((resolve) => {
      release = resolve
    })
    try {
      await previous
      const wait = this.lastRequestStartedAt + interval - Date.now()
      if (wait > 0) await delay(wait)
      this.lastRequestStartedAt = Date.now()
    } finally {
      // Always release, or one failure would stall every later request.
      release()
    }
  }

  /**
   * POSTs to an Elvanto endpoint and returns the parsed envelope.
   *
   * @param endpoint API path without extension or leading slash, e.g. `people/getAll`.
   * @param params JSON body. Undefined values are stripped.
   * @param policy `write: true` for a request that changes the account. Such a
   *   request is only retried after a 429, and any failure that may have
   *   happened after Elvanto acted surfaces as
   *   {@link ElvantoWriteOutcomeUnknownError}.
   */
  async request(
    endpoint: string,
    params: Record<string, unknown> = {},
    options: RequestOptions = {},
    policy: { write?: boolean; records?: readonly string[] } = {},
  ): Promise<Envelope> {
    if (!policy.write) return this.send(endpoint, params, options, false)
    return this.spacedFor(policy.records ?? [], async () => {
      try {
        return await this.send(endpoint, params, options, true)
      } catch (error) {
        if (outcomeUnknown(error)) {
          throw new ElvantoWriteOutcomeUnknownError({ endpoint, cause: error })
        }
        throw error
      }
    })
  }

  /** Runs a write once every earlier write to the same records has cleared its gap. */
  private async spacedFor<T>(records: readonly string[], run: () => Promise<T>): Promise<T> {
    const gap = this.options.sameRecordWriteGapMs
    if (gap <= 0 || records.length === 0) return run()

    // Forget writes whose gap has long passed, so the map stays small.
    const now = Date.now()
    for (const [record, write] of this.recordWrites) {
      if (write.finishedAt + gap < now) this.recordWrites.delete(record)
    }

    const previous = records
      .map((record) => this.recordWrites.get(record))
      .filter((write) => write !== undefined)
    let release!: () => void
    const entry = {
      done: new Promise<void>((resolve) => {
        release = resolve
      }),
      finishedAt: Number.POSITIVE_INFINITY,
    }
    for (const record of records) this.recordWrites.set(record, entry)
    try {
      await Promise.all(previous.map((write) => write.done))
      // Measured from when the last write finished, which is when Elvanto stamped it.
      const readyAt = Math.max(0, ...previous.map((write) => write.finishedAt + gap))
      const wait = readyAt - Date.now()
      if (wait > 0) await delay(wait)
      return await run()
    } finally {
      entry.finishedAt = Date.now()
      release()
    }
  }

  private async send(
    endpoint: string,
    params: Record<string, unknown>,
    options: RequestOptions,
    write: boolean,
  ): Promise<Envelope> {
    const url = `${this.options.baseUrl}/${endpoint}.json`
    const body = JSON.stringify(stripUndefined(params))
    const headers: Record<string, string> = {
      Authorization: await authorizationHeader(this.auth),
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'User-Agent': this.options.userAgent,
    }

    const log = this.logging
    if (log.enabled) {
      log.log({
        level: 'debug',
        event: 'request',
        endpoint,
        message: 'POST',
        data: {
          url,
          bytes: body.length,
          ...describeParamsForLog(stripUndefined(params), log.verbose),
        },
      })
    }

    let lastError: unknown
    for (let attempt = 0; attempt <= this.options.maxRetries; attempt++) {
      if (attempt > 0) {
        const waitMs = backoffMs(attempt, lastError)
        if (log.enabled) {
          log.log({
            level: 'debug',
            event: 'retry',
            endpoint,
            message: `attempt ${attempt + 1} of ${this.options.maxRetries + 1}`,
            data: { waitMs: Math.round(waitMs), after: describeRetryReason(lastError) },
          })
        }
        await delay(waitMs)
      }

      await this.takePacingSlot()

      const startedAt = Date.now()
      const { signal, dispose } = withTimeout(
        this.options.timeoutMs,
        options.signal,
      )
      let response: Response
      try {
        response = await this.options.fetchImpl(url, {
          method: 'POST',
          headers,
          body,
          signal,
        })
      } catch (cause) {
        dispose()
        // A caller-initiated abort is final; don't burn retries on it.
        if (options.signal?.aborted) {
          throw new ElvantoTransportError({
            message: 'aborted by caller',
            endpoint,
            cause,
          })
        }
        lastError = new ElvantoTransportError({
          message: describeCause(cause, this.options.timeoutMs),
          endpoint,
          cause,
        })
        if (log.enabled) {
          log.log({
            level: 'debug',
            event: 'transport-error',
            endpoint,
            message: describeCause(cause, this.options.timeoutMs),
            data: { durationMs: Date.now() - startedAt, attempt: attempt + 1 },
          })
        }
        // The request may have reached Elvanto before the connection failed, so
        // a write is never sent again.
        if (write || attempt === this.options.maxRetries) throw lastError
        continue
      }
      dispose()

      const text = await response.text().catch(() => '')
      const parsed = safeJsonParse(text)

      if (log.enabled) {
        log.log({
          level: 'debug',
          event: 'response',
          endpoint,
          message: `HTTP ${response.status}`,
          data: {
            durationMs: Date.now() - startedAt,
            bytes: text.length,
            attempt: attempt + 1,
            // Elvanto's own reported processing time, useful for telling a slow
            // network apart from a slow query.
            generatedIn: readGeneratedIn(parsed),
          },
        })
      }

      if (
        isRetryableStatus(response.status, write) &&
        attempt < this.options.maxRetries
      ) {
        lastError = response
        continue
      }

      if (!response.ok) {
        throw apiErrorFrom(endpoint, response.status, parsed, text)
      }

      if (parsed === undefined) {
        throw new ElvantoApiError({
          message: `expected JSON but got ${describeBody(text)}`,
          httpStatus: response.status,
          endpoint,
          body: text,
        })
      }

      const envelope = envelopeSchema.safeParse(parsed)
      const data: Envelope = envelope.success
        ? envelope.data
        : (parsed as Envelope)

      // Elvanto reports some failures with HTTP 200 and status: "fail".
      if (typeof data.status === 'string' && data.status.toLowerCase() === 'fail') {
        throw apiErrorFrom(endpoint, response.status, data, text)
      }

      return data
    }

    /* c8 ignore next 2 — the loop always returns or throws. */
    throw lastError ??
      new ElvantoTransportError({ message: 'request failed', endpoint })
  }
}

function apiErrorFrom(
  endpoint: string,
  httpStatus: number,
  parsed: unknown,
  rawText: string,
): ElvantoApiError {
  const error =
    parsed && typeof parsed === 'object'
      ? ((parsed as Record<string, unknown>)['error'] as
          | Record<string, unknown>
          | undefined)
      : undefined

  const rawCode = error?.['code']
  const code =
    typeof rawCode === 'number'
      ? rawCode
      : typeof rawCode === 'string' && rawCode.trim() !== ''
        ? Number(rawCode)
        : undefined

  const message =
    (typeof error?.['message'] === 'string' && error['message']) ||
    (rawText ? describeBody(rawText) : `HTTP ${httpStatus}`)

  // Elvanto sometimes carries the meaningful status in the body rather than the
  // status line, so promote a body code that looks like an HTTP status.
  const effectiveStatus =
    httpStatus === 200 && code !== undefined && code >= 400 && code < 600
      ? code
      : httpStatus

  return new ElvantoApiError({
    message,
    httpStatus: effectiveStatus,
    code: code === undefined || Number.isNaN(code) ? undefined : code,
    endpoint,
    body: parsed ?? rawText,
  })
}

function stripUndefined(
  params: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) out[key] = value
  }
  return out
}

function safeJsonParse(text: string): unknown {
  if (text.trim() === '') return undefined
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

function describeBody(text: string): string {
  const snippet = text.trim().slice(0, 200)
  return snippet === '' ? 'an empty response' : snippet
}

function describeCause(cause: unknown, timeoutMs: number): string {
  if (cause instanceof Error) {
    if (cause.name === 'TimeoutError' || cause.name === 'AbortError') {
      return `timed out after ${timeoutMs}ms`
    }
    return cause.message
  }
  return String(cause)
}

/**
 * Whether a status is worth another attempt.
 *
 * A 429 means Elvanto refused before doing anything, so it is safe to repeat
 * even for a write. A 408 or 5xx may arrive after the work was done.
 */
function isRetryableStatus(status: number, write: boolean): boolean {
  if (status === 429) return true
  if (write) return false
  return status === 408 || (status >= 500 && status <= 599)
}

/**
 * Whether a failed write may nonetheless have been applied: the connection
 * failed or timed out, or Elvanto answered with a status that can follow the
 * work rather than precede it.
 */
function outcomeUnknown(error: unknown): boolean {
  if (error instanceof ElvantoTransportError) return true
  if (error instanceof ElvantoApiError) {
    return error.httpStatus === 408 || (error.httpStatus >= 500 && error.httpStatus <= 599)
  }
  return false
}

/** Elvanto's `generated_in` field, for a log line. Absent on non-JSON bodies. */
function readGeneratedIn(parsed: unknown): string | undefined {
  if (!parsed || typeof parsed !== 'object') return undefined
  const value = (parsed as Record<string, unknown>)['generated_in']
  return typeof value === 'string' || typeof value === 'number'
    ? String(value)
    : undefined
}

/** Names what triggered a retry, without leaking a response body. */
function describeRetryReason(lastError: unknown): string {
  if (lastError instanceof Response) return `HTTP ${lastError.status}`
  if (lastError instanceof Error) return lastError.name
  return 'unknown'
}

/** Upper bound on a single backoff, so a hostile Retry-After can't hang a caller. */
export const MAX_BACKOFF_MS = 60_000

/**
 * Backoff before the next attempt. Elvanto documents no rate limits, so a
 * `Retry-After` header is honoured when present and exponential backoff with
 * jitter is used otherwise.
 *
 * Exported for unit testing: the clamp is impractical to prove through the
 * transport, since doing so means actually waiting out the delay.
 */
export function backoffMs(attempt: number, lastError: unknown): number {
  if (lastError instanceof Response) {
    const retryAfter = lastError.headers.get('retry-after')?.trim()
    if (retryAfter) {
      const seconds = Number(retryAfter)
      if (Number.isFinite(seconds)) {
        // A numeric header settles it either way. Falling through to Date.parse
        // on a negative value would be wrong: `Date.parse('-5')` reads it as a
        // year, yielding a 0ms delay that retries a failing server immediately.
        return seconds >= 0
          ? Math.min(seconds * 1000, MAX_BACKOFF_MS)
          : exponentialBackoffMs(attempt)
      }
      const date = Date.parse(retryAfter)
      if (!Number.isNaN(date)) {
        return Math.min(Math.max(date - Date.now(), 0), MAX_BACKOFF_MS)
      }
    }
  }
  return exponentialBackoffMs(attempt)
}

/** 500ms doubling per attempt, capped at 8s, plus jitter to avoid a thundering herd. */
function exponentialBackoffMs(attempt: number): number {
  const base = 500 * 2 ** (attempt - 1)
  return Math.min(base, 8_000) + Math.random() * 250
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Combines the configured timeout with an optional caller signal.
 *
 * `AbortSignal.any` exists from Node 20.3; the manual fallback keeps older
 * 20.x working.
 */
function withTimeout(
  timeoutMs: number,
  callerSignal: AbortSignal | undefined,
): { signal: AbortSignal; dispose: () => void } {
  const timeoutSignal = AbortSignal.timeout(timeoutMs)
  if (!callerSignal) return { signal: timeoutSignal, dispose: () => {} }

  if (typeof AbortSignal.any === 'function') {
    return {
      signal: AbortSignal.any([timeoutSignal, callerSignal]),
      dispose: () => {},
    }
  }

  const controller = new AbortController()
  const abort = (reason: unknown) => controller.abort(reason)

  // An already-aborted signal never fires its listener, so check first —
  // otherwise a caller who aborted before the request was issued would have the
  // request sent anyway, silently defeating cancellation.
  if (callerSignal.aborted) {
    return { signal: callerSignal, dispose: () => {} }
  }

  const onTimeout = () => abort(timeoutSignal.reason)
  const onCaller = () => abort(callerSignal.reason)
  timeoutSignal.addEventListener('abort', onTimeout, { once: true })
  callerSignal.addEventListener('abort', onCaller, { once: true })
  return {
    signal: controller.signal,
    dispose: () => {
      timeoutSignal.removeEventListener('abort', onTimeout)
      callerSignal.removeEventListener('abort', onCaller)
    },
  }
}
