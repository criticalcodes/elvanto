import { ElvantoError } from './errors.js'

/**
 * Diagnostic logging.
 *
 * Off by default. Turn it on with `debug: true`, or `ELVANTO_DEBUG=1` for the
 * CLI and MCP server, and supply `logger` to route events into your own logging
 * stack instead of stderr.
 *
 * ## What is deliberately never logged
 *
 * This library handles church member records and giving data, so the log stream
 * is treated as a place that data must not reach:
 *
 * - **Credentials.** API keys and access tokens are never logged at any level,
 *   and the Authorization header is never included.
 * - **Response records.** Counts, status codes and timings are logged; the
 *   records themselves never are. When you need the payload to diagnose a schema
 *   mismatch, use `validate: 'warn'` and read it from the warning, or
 *   `ElvantoResponseValidationError.data`.
 * - **Parameter values**, unless you opt in with `debug: 'verbose'`. Parameter
 *   *names* are logged at the normal level, which is enough to see what was
 *   asked for; values can contain a person's name, email, or giving number.
 */
export type DebugMode = 'off' | 'on' | 'verbose'

export interface ElvantoLogEvent {
  level: 'debug' | 'warn'
  /** Machine-readable event name: `request`, `response`, `retry`, … */
  event: string
  message: string
  endpoint?: string
  /** Extra structured detail. Never contains credentials or response records. */
  data?: Record<string, unknown>
}

export type ElvantoLogger = (event: ElvantoLogEvent) => void

/** Reads a debug mode from an environment variable or flag. */
export function parseDebugMode(value: string | undefined): DebugMode | undefined {
  if (value == null || value.trim() === '') return undefined
  const v = value.trim().toLowerCase()
  if (v === 'verbose' || v === '2') return 'verbose'
  if (v === '1' || v === 'true' || v === 'on' || v === 'yes' || v === 'debug') {
    return 'on'
  }
  if (v === '0' || v === 'false' || v === 'off' || v === 'no') return 'off'
  throw new ElvantoError(
    `Invalid debug mode "${value}". Expected "on", "verbose" or "off".`,
  )
}

/**
 * The default logger: one compact line per event on stderr.
 *
 * stderr rather than stdout, so logging can never corrupt CLI output that is
 * being piped, nor the MCP stdio protocol channel.
 */
export function createStderrLogger(
  write: (text: string) => void = (text) => process.stderr.write(text),
): ElvantoLogger {
  return (event) => {
    const parts = [`[elvanto]`, event.event]
    if (event.endpoint) parts.push(event.endpoint)
    if (event.message) parts.push(`— ${event.message}`)
    for (const [key, value] of Object.entries(event.data ?? {})) {
      parts.push(`${key}=${formatValue(value)}`)
    }
    write(`${parts.join(' ')}\n`)
  }
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return '-'
  if (Array.isArray(value)) return value.join(',')
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

/** A logger plus the state needed to decide what may be included. */
export interface ResolvedLogging {
  readonly enabled: boolean
  /** Whether parameter values may be logged. */
  readonly verbose: boolean
  log: (event: ElvantoLogEvent) => void
}

const NOOP_LOGGING: ResolvedLogging = {
  enabled: false,
  verbose: false,
  log: () => {},
}

/**
 * Resolves the logging configuration.
 *
 * An explicit `logger` implies logging is wanted even without `debug`, so that
 * callers wiring this into their own observability don't need to set both.
 */
export function resolveLogging(
  debug: boolean | DebugMode | undefined,
  logger: ElvantoLogger | undefined,
  env: Record<string, string | undefined> = process.env,
): ResolvedLogging {
  const requested =
    debug === true
      ? 'on'
      : debug === false
        ? 'off'
        : (debug ?? parseDebugMode(env['ELVANTO_DEBUG']) ?? (logger ? 'on' : 'off'))

  if (requested === 'off') return NOOP_LOGGING

  const sink = logger ?? createStderrLogger()
  return {
    enabled: true,
    verbose: requested === 'verbose',
    log: sink,
  }
}

/**
 * Parameter names whose values are never logged, at any level.
 *
 * Defence in depth rather than a live concern: no current endpoint takes a
 * credential as a parameter. But `extraParams` lets a caller put arbitrary keys
 * in the request body, and a future endpoint could take a token, so a
 * credential-shaped name is redacted on the way to the log regardless of mode.
 */
const NEVER_LOG_VALUES =
  /api_?key|access_?token|refresh_?token|\btoken\b|secret|password|credential|authorization/i

/**
 * Describes request parameters for a log line.
 *
 * Names only at the normal level; values only when verbose, and never for the
 * `search` parameter, whose values are the search terms themselves — a person's
 * name, email or giving number.
 */
export function describeParamsForLog(
  params: Record<string, unknown>,
  verbose: boolean,
): Record<string, unknown> {
  const names = Object.keys(params)
  if (!verbose) {
    return names.length > 0 ? { params: names } : {}
  }
  const safe: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(params)) {
    if (NEVER_LOG_VALUES.test(key)) {
      safe[key] = '<redacted>'
    } else if (key === 'search') {
      const criteria =
        value && typeof value === 'object' ? Object.keys(value).length : 0
      safe[key] = `<${criteria} criteria>`
    } else {
      safe[key] = value
    }
  }
  return { params: JSON.stringify(safe) }
}
