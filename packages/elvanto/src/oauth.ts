/**
 * Elvanto's OAuth 2 authorization code flow.
 *
 * ## Runtime constraints
 *
 * Everything here is web-standard — `fetch`, `URL`, `crypto.subtle`, `TextEncoder`
 * — and reaches for no Node built-in, because the deployed agent runs this on
 * Cloudflare Workers. The one piece that genuinely needs a filesystem, the
 * on-disk token store, lives in `./node` instead and is not part of this entry.
 *
 * ## What Elvanto's flow does and does not give you
 *
 * It is the plain authorization code grant with no PKCE, so exchanging a code
 * requires the client secret. There is therefore no such thing as a safe public
 * client here: anything doing this flow needs a confidential place to hold a
 * secret, which is why every surface in this repository asks the operator to
 * register their *own* OAuth application (Elvanto: Settings > Integrations)
 * rather than shipping a client id of ours.
 *
 * Scopes are coarse and write-shaped — {@link ELVANTO_SCOPES} is the whole list,
 * and there is no read-only member of it. This library only ever issues reads, but
 * a token it holds is capable of more than this library does with it. Request the
 * narrowest set that answers your questions; {@link DEFAULT_SCOPES} omits the two
 * that would otherwise hand over giving data and account administration.
 */

import { ElvantoError } from './errors.js'

/** Where the OAuth endpoints live. Note this is the API *origin*, not the `/v1` root. */
export const DEFAULT_OAUTH_BASE_URL = 'https://api.elvanto.com'

/**
 * Refresh this long before the access token actually expires.
 *
 * Covers clock skew between us and Elvanto plus the flight time of the request
 * the token is about to be used on, so a token does not expire in transit.
 */
export const DEFAULT_EXPIRY_SKEW_MS = 60_000

/**
 * Every scope Elvanto defines.
 *
 * All seven are write-capable; Elvanto publishes no read-only variant. A token
 * with `ManagePeople` can edit people, whatever the holder intends to do with it.
 */
export const ELVANTO_SCOPES = [
  'ManagePeople',
  'ManageGroups',
  'ManageServices',
  'ManageSongs',
  'ManageCalendar',
  'ManageFinancials',
  'AdministerAccount',
] as const

export type ElvantoScope = (typeof ELVANTO_SCOPES)[number]

/**
 * The scopes requested when a caller does not choose.
 *
 * `ManageFinancials` and `AdministerAccount` are deliberately absent. They are
 * the two that would let a token reach giving records and account settings, and
 * the default posture everywhere in this repository is that giving data is opted
 * into rather than out of — the agent toolkit's endpoint allowlist makes the same
 * omission.
 */
export const DEFAULT_SCOPES: readonly ElvantoScope[] = [
  'ManagePeople',
  'ManageGroups',
  'ManageServices',
  'ManageSongs',
  'ManageCalendar',
]

/** The OAuth flow failed: a rejected exchange, a bad state, a malformed response. */
export class ElvantoOAuthError extends ElvantoError {
  /** Elvanto's `error` field, when the response carried one. */
  readonly oauthError: string | undefined
  readonly httpStatus: number | undefined

  constructor(args: {
    message: string
    oauthError?: string | undefined
    httpStatus?: number | undefined
    cause?: unknown
  }) {
    super(args.message, args.cause !== undefined ? { cause: args.cause } : undefined)
    this.oauthError = args.oauthError
    this.httpStatus = args.httpStatus
  }
}

/**
 * A granted token pair.
 *
 * `expiresAt` is an absolute epoch-millisecond instant rather than Elvanto's
 * relative `expires_in`, because these get persisted: a duration is only
 * meaningful next to the moment it was issued, and storing the two separately
 * invites reading one without the other.
 */
export interface ElvantoTokens {
  accessToken: string
  refreshToken: string
  /** Epoch milliseconds. */
  expiresAt: number
  /** Scopes the grant carries, as far as the token response reported them. */
  scopes: readonly string[]
}

export interface AuthorizeUrlOptions {
  clientId: string
  /** Must match a redirect URI registered on the Elvanto application exactly. */
  redirectUri: string
  /** Defaults to {@link DEFAULT_SCOPES}. */
  scopes?: readonly string[]
  /** Round-tripped by Elvanto. Use {@link createState} to make it tamper-evident. */
  state?: string
  /**
   * `web_server` (the default) is the authorization code flow this module
   * implements. `user_agent` is Elvanto's implicit flow, which returns a token in
   * a URL fragment and has no refresh token — supported here only so a caller who
   * wants it can build the URL.
   */
  type?: 'web_server' | 'user_agent'
  baseUrl?: string
}

/** Builds the URL to send a user to so they can authorize the application. */
export function authorizeUrl(options: AuthorizeUrlOptions): string {
  const scopes = options.scopes ?? DEFAULT_SCOPES
  if (scopes.length === 0) {
    throw new ElvantoOAuthError({
      message: 'At least one scope is required. Elvanto rejects an empty scope list.',
    })
  }

  const url = new URL('/oauth', normalizeBaseUrl(options.baseUrl))
  url.searchParams.set('type', options.type ?? 'web_server')
  url.searchParams.set('client_id', options.clientId)
  url.searchParams.set('redirect_uri', options.redirectUri)
  url.searchParams.set('scope', scopes.join(','))
  if (options.state !== undefined) url.searchParams.set('state', options.state)
  return url.toString()
}

export interface ExchangeCodeOptions {
  clientId: string
  clientSecret: string
  /** The `code` query parameter Elvanto sent to the redirect URI. */
  code: string
  /** The same redirect URI used to obtain the code. Elvanto checks it matches. */
  redirectUri: string
  fetch?: typeof globalThis.fetch
  baseUrl?: string
  /** The clock, so `expiresAt` is testable. */
  now?: () => number
  signal?: AbortSignal
}

/** Exchanges an authorization code for a token pair. */
export async function exchangeCode(
  options: ExchangeCodeOptions,
): Promise<ElvantoTokens> {
  return requestTokens(
    {
      grant_type: 'authorization_code',
      client_id: options.clientId,
      client_secret: options.clientSecret,
      code: options.code,
      redirect_uri: options.redirectUri,
    },
    options,
  )
}

export interface RefreshTokensOptions {
  refreshToken: string
  /**
   * Elvanto's documented refresh request carries only the grant type and the
   * refresh token — the token itself is the credential. Client credentials are
   * accepted here and sent when given, since some deployments front the token
   * endpoint with something that expects them.
   */
  clientId?: string | undefined
  clientSecret?: string | undefined
  fetch?: typeof globalThis.fetch
  baseUrl?: string
  now?: () => number
  signal?: AbortSignal
}

/** Trades a refresh token for a fresh access token. */
export async function refreshTokens(
  options: RefreshTokensOptions,
): Promise<ElvantoTokens> {
  if (!options.refreshToken) {
    throw new ElvantoOAuthError({
      message: 'No refresh token to refresh with. The user must authorize again.',
    })
  }
  return requestTokens(
    {
      grant_type: 'refresh_token',
      refresh_token: options.refreshToken,
      ...(options.clientId ? { client_id: options.clientId } : {}),
      ...(options.clientSecret ? { client_secret: options.clientSecret } : {}),
    },
    { ...options, refreshToken: options.refreshToken },
  )
}

/**
 * POSTs to the token endpoint and parses the result.
 *
 * The body is form-encoded rather than JSON, which is what Elvanto's own client
 * libraries send and what the endpoint accepts.
 */
async function requestTokens(
  form: Record<string, string>,
  options: {
    fetch?: typeof globalThis.fetch
    baseUrl?: string
    now?: () => number
    signal?: AbortSignal
    /** Carried through so a refresh that omits a new one keeps the old. */
    refreshToken?: string
  },
): Promise<ElvantoTokens> {
  const fetchImpl = options.fetch ?? globalThis.fetch
  if (typeof fetchImpl !== 'function') {
    throw new ElvantoOAuthError({
      message: 'No fetch implementation available. Use Node 20+ or pass { fetch }.',
    })
  }

  const url = new URL('/oauth/token', normalizeBaseUrl(options.baseUrl)).toString()
  const now = options.now ?? Date.now

  let response: Response
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: new URLSearchParams(form).toString(),
      ...(options.signal ? { signal: options.signal } : {}),
    })
  } catch (cause) {
    throw new ElvantoOAuthError({
      message: `Could not reach Elvanto's token endpoint: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
      cause,
    })
  }

  const text = await response.text().catch(() => '')
  let parsed: unknown
  try {
    parsed = text.trim() === '' ? undefined : JSON.parse(text)
  } catch {
    parsed = undefined
  }
  const body = (parsed ?? {}) as Record<string, unknown>

  // Elvanto reports some failures with a 200 and an `error` field, the same way
  // the data API reports them with `status: "fail"`.
  const oauthError =
    typeof body['error'] === 'string' ? body['error'] : undefined
  if (!response.ok || oauthError) {
    const description =
      typeof body['error_description'] === 'string'
        ? body['error_description']
        : undefined
    throw new ElvantoOAuthError({
      message:
        `Elvanto rejected the token request` +
        `${oauthError ? ` (${oauthError})` : ''}: ` +
        // Never the raw body: a failed refresh echoes the refresh token back in
        // some error shapes, and this message is the thing that gets logged.
        (description ?? `HTTP ${response.status}`),
      ...(oauthError ? { oauthError } : {}),
      httpStatus: response.status,
    })
  }

  const accessToken = body['access_token']
  if (typeof accessToken !== 'string' || accessToken === '') {
    throw new ElvantoOAuthError({
      message:
        'Elvanto returned no access_token. The response did not look like a token grant.',
      httpStatus: response.status,
    })
  }

  // A refresh response is documented to carry a new refresh token, but keeping
  // the old one when it does not is the difference between a session that
  // survives and one that silently ends at the next expiry.
  const refreshed = body['refresh_token']
  const refreshToken =
    typeof refreshed === 'string' && refreshed !== ''
      ? refreshed
      : (options.refreshToken ?? '')

  const expiresIn = Number(body['expires_in'])
  const expiresAt =
    Number.isFinite(expiresIn) && expiresIn > 0
      ? now() + expiresIn * 1000
      : // No expiry stated. Treat it as short-lived rather than eternal: a token
        // wrongly believed valid fails a user's request, one wrongly refreshed
        // costs a round trip.
        now() + 3_600_000

  const scope = body['scope']
  const scopes =
    typeof scope === 'string' && scope.trim() !== ''
      ? scope.split(/[,\s]+/).filter(Boolean)
      : []

  return { accessToken, refreshToken, expiresAt, scopes }
}

/** Whether an access token is expired, or close enough that it should be renewed. */
export function isExpired(
  tokens: ElvantoTokens,
  skewMs: number = DEFAULT_EXPIRY_SKEW_MS,
  now: () => number = Date.now,
): boolean {
  return tokens.expiresAt - skewMs <= now()
}

/**
 * Somewhere token pairs live between processes.
 *
 * One interface, several backings, because the same flow has to work in three
 * places with nothing in common: a file on a laptop for the CLI and the MCP
 * server, a Durable Object for the deployed agent, memory for tests. Keys are
 * caller-chosen — the CLI uses one fixed key, the agent uses a per-person one.
 *
 * Implementations must treat their contents as secret at rest to whatever degree
 * the medium allows; a refresh token is a standing grant, not a session.
 */
export interface TokenStore {
  read(key: string): Promise<ElvantoTokens | undefined>
  write(key: string, tokens: ElvantoTokens): Promise<void>
  delete(key: string): Promise<void>
}

/** An in-memory store, for tests and single-process development. */
export class MemoryTokenStore implements TokenStore {
  private readonly entries = new Map<string, ElvantoTokens>()

  read(key: string): Promise<ElvantoTokens | undefined> {
    return Promise.resolve(this.entries.get(key))
  }

  write(key: string, tokens: ElvantoTokens): Promise<void> {
    this.entries.set(key, tokens)
    return Promise.resolve()
  }

  delete(key: string): Promise<void> {
    this.entries.delete(key)
    return Promise.resolve()
  }
}

export interface TokenSourceOptions {
  store: TokenStore
  /** Which entry in the store this source owns. */
  key: string
  clientId?: string | undefined
  clientSecret?: string | undefined
  fetch?: typeof globalThis.fetch
  baseUrl?: string
  now?: () => number
  /** Renew this long before the stated expiry. Default 60s. */
  skewMs?: number
  /** Called after a successful refresh, for logging or metrics. Never given the token. */
  onRefresh?: () => void
}

export interface TokenSource {
  /**
   * The current access token, refreshed first if it is expired or nearly so.
   * Shaped to drop straight into the client's `getAccessToken` hook.
   */
  getAccessToken: () => Promise<string>
  /** The stored pair as it currently stands, without refreshing. */
  peek: () => Promise<ElvantoTokens | undefined>
  /** Forget the grant. Used by `logout`. */
  revoke: () => Promise<void>
}

/**
 * An access token that renews itself.
 *
 * Refreshes are single-flighted. A model turn routinely fires several tool calls
 * at once, and without this each one would notice the same expired token and
 * start its own refresh — Elvanto would issue several grants, each write to the
 * store would clobber the last, and whichever refresh token landed last is the
 * only one still valid. Concurrent callers therefore share one in-flight refresh.
 *
 * ```ts
 * const tokens = createTokenSource({ store, key: 'default', clientId, clientSecret })
 * const client = createClient({ auth: { getAccessToken: tokens.getAccessToken } })
 * ```
 */
export function createTokenSource(options: TokenSourceOptions): TokenSource {
  const now = options.now ?? Date.now
  const skewMs = options.skewMs ?? DEFAULT_EXPIRY_SKEW_MS
  let inFlight: Promise<ElvantoTokens> | undefined

  const load = async (): Promise<ElvantoTokens> => {
    const stored = await options.store.read(options.key)
    if (!stored) {
      throw new ElvantoOAuthError({
        message:
          'No stored Elvanto credentials. Authorize first — run `elvanto login`, ' +
          'or sign in through the application that owns this session.',
      })
    }
    return stored
  }

  const renew = async (stored: ElvantoTokens): Promise<ElvantoTokens> => {
    const fresh = await refreshTokens({
      refreshToken: stored.refreshToken,
      clientId: options.clientId,
      clientSecret: options.clientSecret,
      ...(options.fetch ? { fetch: options.fetch } : {}),
      ...(options.baseUrl !== undefined ? { baseUrl: options.baseUrl } : {}),
      now,
    })
    // Elvanto does not echo scope on every grant; keep what the original said
    // so a stored record does not lose its provenance across a refresh.
    const merged: ElvantoTokens =
      fresh.scopes.length === 0 ? { ...fresh, scopes: stored.scopes } : fresh
    await options.store.write(options.key, merged)
    options.onRefresh?.()
    return merged
  }

  return {
    async getAccessToken(): Promise<string> {
      const stored = await load()
      if (!isExpired(stored, skewMs, now)) return stored.accessToken

      // Re-read inside the shared promise rather than closing over `stored`: a
      // caller that queued behind an earlier refresh must not then refresh again
      // with the refresh token that refresh has already spent.
      inFlight ??= (async () => {
        try {
          const latest = (await options.store.read(options.key)) ?? stored
          if (!isExpired(latest, skewMs, now)) return latest
          return await renew(latest)
        } finally {
          inFlight = undefined
        }
      })()

      const fresh = await inFlight
      return fresh.accessToken
    },

    peek(): Promise<ElvantoTokens | undefined> {
      return options.store.read(options.key)
    },

    revoke(): Promise<void> {
      return options.store.delete(options.key)
    },
  }
}

/* ---------------------------------------------------------------------------
 * Tamper-evident state
 * ------------------------------------------------------------------------ */

/**
 * The `state` parameter, signed.
 *
 * Elvanto round-trips `state` verbatim, which makes it the only channel a
 * redirect handler has for knowing that a callback belongs to a request it
 * actually made. Unsigned, it is attacker-chosen: anyone can call the redirect
 * URI with a code of their own and, if the handler believes the state, have the
 * victim's session bound to the attacker's Elvanto account. So it carries an
 * HMAC and an issue time, and {@link readState} refuses anything it did not sign
 * or that has aged out.
 *
 * The payload is not encrypted — treat it as public — and it must not carry
 * anything secret. Its job is integrity, not confidentiality.
 */
export interface StateOptions {
  /** A secret unique to this deployment. At least 16 characters. */
  secret: string
  /** Arbitrary JSON round-tripped through the redirect, e.g. a return path. */
  payload?: Record<string, unknown>
  now?: () => number
}

export async function createState(options: StateOptions): Promise<string> {
  requireSecret(options.secret)
  const now = options.now ?? Date.now
  const body = base64UrlEncode(
    JSON.stringify({ iat: now(), ...(options.payload ?? {}) }),
  )
  return `${body}.${await hmacHex(options.secret, body)}`
}

export interface ReadStateOptions {
  secret: string
  state: string | null | undefined
  /** How long a state stays acceptable. Default 10 minutes. */
  maxAgeMs?: number
  now?: () => number
}

/**
 * Verifies a returned state and hands back its payload.
 *
 * Throws rather than returning a boolean, because every caller of this treats a
 * failure the same way — abandon the callback — and a boolean is the kind of
 * thing that gets checked with the wrong polarity exactly once.
 */
export async function readState(
  options: ReadStateOptions,
): Promise<Record<string, unknown>> {
  requireSecret(options.secret)
  const state = options.state
  if (!state) {
    throw new ElvantoOAuthError({
      message: 'The OAuth callback carried no state parameter. Refusing it.',
    })
  }

  const separator = state.lastIndexOf('.')
  if (separator < 1) {
    throw new ElvantoOAuthError({ message: 'Malformed OAuth state. Refusing it.' })
  }
  const body = state.slice(0, separator)
  const signature = state.slice(separator + 1)

  const expected = await hmacHex(options.secret, body)
  if (!timingSafeEqual(signature, expected)) {
    throw new ElvantoOAuthError({
      message:
        'The OAuth state did not verify. This callback did not come from a sign-in ' +
        'this server started.',
    })
  }

  let payload: Record<string, unknown>
  try {
    payload = JSON.parse(base64UrlDecode(body)) as Record<string, unknown>
  } catch {
    throw new ElvantoOAuthError({ message: 'Malformed OAuth state payload. Refusing it.' })
  }

  const maxAgeMs = options.maxAgeMs ?? 600_000
  const now = (options.now ?? Date.now)()
  const issuedAt = Number(payload['iat'])
  // A signed state with no readable issue time is a state this code did not
  // write, whatever the signature says about it.
  if (!Number.isFinite(issuedAt) || now - issuedAt > maxAgeMs || issuedAt > now + 60_000) {
    throw new ElvantoOAuthError({
      message: 'The OAuth state has expired. Start the sign-in again.',
    })
  }

  return payload
}

function requireSecret(secret: string): void {
  if (!secret || secret.length < 16) {
    throw new ElvantoOAuthError({
      message:
        'The OAuth state secret must be at least 16 characters. Generate one with ' +
        '`openssl rand -hex 32` and keep it out of version control.',
    })
  }
}

async function hmacHex(secret: string, message: string): Promise<string> {
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(message))
  return [...new Uint8Array(signature)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

/**
 * Compares without leaking where the difference is.
 *
 * Both inputs here are hex of a fixed length, so comparing lengths first gives
 * nothing away.
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let difference = 0
  for (let index = 0; index < a.length; index++) {
    difference |= a.charCodeAt(index) ^ b.charCodeAt(index)
  }
  return difference === 0
}

/** A URL-safe random identifier, for session ids and unsigned nonces. */
export function randomToken(bytes = 32): string {
  const buffer = new Uint8Array(bytes)
  crypto.getRandomValues(buffer)
  return [...buffer].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

function base64UrlEncode(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function base64UrlDecode(text: string): string {
  const padded = text.replace(/-/g, '+').replace(/_/g, '/')
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4))
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0))
  return new TextDecoder().decode(bytes)
}

/**
 * Resolves the OAuth origin from what the caller passed, and nothing else.
 *
 * Deliberately blind to the environment. An earlier version fell back to
 * `ELVANTO_OAUTH_BASE_URL` here, which meant every function in this module had a
 * hidden dependency on ambient state — untestable without mutating `process.env`,
 * and meaningless on Workers, where there is no `process` to read. Reading the
 * environment is a policy decision and belongs to the application: the CLI, the
 * MCP server and the agent each resolve it and pass it in.
 */
function normalizeBaseUrl(baseUrl: string | undefined): string {
  return (baseUrl ?? DEFAULT_OAUTH_BASE_URL).replace(/\/+$/, '')
}
