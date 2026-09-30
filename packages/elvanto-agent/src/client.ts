import {
  createClient,
  createTokenSource,
  parseDebugMode,
  parseValidationMode,
  type ElvantoClient,
  type ElvantoClientOptions,
  type TokenSource,
  type TokenStore,
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

  const options = baseOptions(env)
  if (accessToken) options.auth = { accessToken }
  else if (apiKey) options.auth = { apiKey }
  else if (processTokenSource) {
    options.auth = { getAccessToken: processTokenSource.getAccessToken }
  }

  return createClient(options)
}

/**
 * A credential for the whole process, when there is exactly one caller.
 *
 * Process-wide state, which wants justifying. The seam this package prefers is
 * `useElvantoBase({ client })` — a driver, passed in — and that is what the
 * deployed path uses, because there each conversation has a different credential
 * and nothing about it can be process-wide.
 *
 * A terminal binary is the opposite case and has a structural problem to go with
 * it. There is one human, so one credential, and it is known before the agent
 * runs. But the agent function belongs to the consuming project and is shared with
 * its Worker build, so it typically calls `clientFromEnv()` with no arguments and
 * there is nowhere for a runner to pass anything in. The alternative is making
 * every consumer thread a parameter through an agent module that has no other
 * reason to know about it.
 *
 * So: set once, before the agent runs, by whoever owns the process — which is
 * {@link runElvantoCli}, from its `auth` option. Explicit environment credentials
 * still win, and this is never touched on Workers.
 */
let processTokenSource: TokenSource | undefined

/** Installs the process-wide credential. Pass `undefined` to clear it. */
export function setProcessTokenSource(source: TokenSource | undefined): void {
  processTokenSource = source
}

/** The process-wide credential, if one was installed. */
export function getProcessTokenSource(): TokenSource | undefined {
  return processTokenSource
}

/**
 * The client for one signed-in person.
 *
 * The same defaults as {@link clientFromEnv} — the reasoning above applies
 * whoever the caller is — but the credential is supplied rather than found. This
 * is what makes a deployed agent answer two people differently: each sees what
 * their Elvanto account sees, and neither borrows the other's reach.
 *
 * Takes a {@link TokenSource} rather than a store and a person id, so the whole
 * credential is one injectable thing. A caller with a grant from somewhere this
 * package has never heard of — a database, a secrets manager, a test double —
 * passes it here without going near a `TokenStore`. `env` still supplies the
 * non-credential defaults (validation, pacing, base URL), and is a plain bag the
 * caller can substitute.
 *
 * ```ts
 * const { personId } = useInitialData<{ personId: string }>()
 * const tokens = personTokenSourceFromEnv(sessionStore(), personId)
 * useElvantoBase({ client: () => clientForPerson(tokens) })
 * ```
 */
export function clientForPerson(
  tokens: TokenSource,
  env: Env = ambientEnv(),
): ElvantoClient {
  const options = baseOptions(env)
  options.auth = { getAccessToken: tokens.getAccessToken }
  return createClient(options)
}

/**
 * A {@link TokenSource} for one person, configured from the environment.
 *
 * The env-reading edge, kept separate from {@link clientForPerson} and named for
 * what it does. Library code takes drivers; deciding that a client secret lives in
 * `ELVANTO_CLIENT_SECRET` is an application's policy, and a function that quietly
 * made that choice on a caller's behalf would be impossible to use any other way.
 *
 * Client credentials are optional here because Elvanto's refresh request carries
 * only the grant type and the refresh token — the refresh token *is* the
 * credential. They are sent when present for deployments that front the token
 * endpoint with something expecting them.
 */
export function personTokenSourceFromEnv(
  store: TokenStore,
  personId: string,
  env: Env = ambientEnv(),
): TokenSource {
  return createTokenSource({
    store,
    key: personId,
    clientId: env['ELVANTO_CLIENT_ID']?.trim(),
    clientSecret: env['ELVANTO_CLIENT_SECRET']?.trim(),
    ...(env['ELVANTO_OAUTH_BASE_URL'] ? { baseUrl: env['ELVANTO_OAUTH_BASE_URL'] } : {}),
  })
}

/** Everything both client shapes share, credential aside. */
function baseOptions(env: Env): ElvantoClientOptions {
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

  return options
}

function positiveInt(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === '') return undefined
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined
}
