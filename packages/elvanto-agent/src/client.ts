import {
  createClient,
  parseDebugMode,
  parseValidationMode,
  type ElvantoClient,
  type ElvantoClientOptions,
} from '@criticalcodes/elvanto'

/** Env bag, so a Worker's bindings can be passed where `process.env` is absent. */
export type Env = Record<string, string | undefined>

/**
 * The ambient environment, if there is one.
 *
 * Cloudflare passes configuration as a binding object rather than a global, and
 * `process` may not exist at all depending on the compatibility flags — so this
 * probes instead of assuming, and callers on Workers should pass `env` explicitly.
 */
export function ambientEnv(): Env {
  return typeof process === 'undefined' ? {} : (process.env as Env)
}

/**
 * Builds the Elvanto client the tools share.
 *
 * Two defaults differ from the SDK's, both because an agent session is a poor
 * place to be strict:
 *
 * - **`validate: 'warn'`.** These response schemas are derived from Elvanto's
 *   documentation, so an undocumented field is expected rather than exceptional.
 *   Under `throw` one new field would fail a tool call mid-conversation and the
 *   model would have no way to recover; under `warn` the record comes back
 *   unnormalized and the session continues. Tests should still run `throw`.
 * - **No `onWarning` to stdout.** Warnings carry the offending payload, which is
 *   member data, so the default reports the endpoint and issue count only.
 *
 * It also paces requests by default, which the SDK does not. Several of these
 * tools walk pages of services to answer one question, and Elvanto documents no
 * rate limit — so the ceiling is discovered by hitting it. A small gap costs a
 * roster lookup very little and keeps a song-history sweep from arriving as a
 * burst.
 */
export function clientFromEnv(env: Env = ambientEnv()): ElvantoClient {
  const apiKey = env['ELVANTO_API_KEY']
  const accessToken = env['ELVANTO_ACCESS_TOKEN']

  const options: ElvantoClientOptions = {
    validate: parseValidationMode(env['ELVANTO_VALIDATE']) ?? 'warn',
    minRequestIntervalMs: positiveInt(env['ELVANTO_MIN_REQUEST_INTERVAL_MS']) ?? 100,
    userAgent: 'elvanto-agent',
    onWarning: (warning) => {
      // Deliberately drops `warning.data`. It is the raw record, and this line
      // may land in an agent runtime's durable log.
      console.warn(
        `[elvanto-agent] ${warning.endpoint} returned an unexpected shape ` +
          `(${warning.issues.length} issue${warning.issues.length === 1 ? '' : 's'}). ` +
          `Using the raw response.`,
      )
    },
  }

  const debug = parseDebugMode(env['ELVANTO_DEBUG'])
  if (debug) options.debug = debug
  if (env['ELVANTO_BASE_URL']) options.baseUrl = env['ELVANTO_BASE_URL']

  if (accessToken) options.auth = { accessToken }
  else if (apiKey) options.auth = { apiKey }

  return createClient(options)
}

function positiveInt(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === '') return undefined
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined
}
