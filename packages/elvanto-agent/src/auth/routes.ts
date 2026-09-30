/**
 * Signing a person in to Elvanto, in front of a deployed agent.
 *
 * This is the answer to the limitation `src/routes.ts` has carried since the
 * shared-token guard was removed: instead of one API key that sees every member
 * record regardless of who is asking, each caller authorizes as themselves and
 * the agent acts with their permissions.
 *
 * Three routes and one middleware:
 *
 *   GET  /auth/login     → redirect to Elvanto
 *   GET  /auth/callback  → exchange the code, start a session, set a cookie
 *   POST /auth/logout    → end the session
 *   GET  /auth/session   → who is signed in, for the chat page
 *
 * and `requireElvantoSession()`, which goes in front of the agent mount and does
 * both of the checks Flue's routing guide insists on: authentication, and the
 * ownership check that stops one signed-in user reading another's conversation by
 * guessing its id.
 */

import { Hono, type Context, type MiddlewareHandler } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import {
  DEFAULT_SCOPES,
  ElvantoClient,
  ElvantoOAuthError,
  authorizeUrl,
  createState,
  createTokenSource,
  exchangeCode,
  randomToken,
  readState,
  type ElvantoScope,
  type TokenSource,
} from '@criticalcodes/elvanto'
import type { ElvantoSession, SessionStore } from './store.ts'

export const DEFAULT_COOKIE_NAME = 'elvanto_session'
export const DEFAULT_BASE_PATH = '/auth'
/** Thirty days. The grant behind it is revocable from Elvanto at any point. */
export const DEFAULT_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000

export interface ElvantoAuthOptions {
  /** From an OAuth application registered under Elvanto: Settings > Integrations. */
  clientId: string
  clientSecret: string
  /**
   * Signs the OAuth `state`. At least 16 characters, unique to the deployment,
   * and not in version control — `wrangler secret put ELVANTO_SESSION_SECRET`.
   */
  stateSecret: string
  /** The session and grant store, or a factory called per request. */
  store: SessionStore | ((context: Context) => SessionStore)
  /** Defaults to {@link DEFAULT_SCOPES}, which omits financials and administration. */
  scopes?: readonly ElvantoScope[]
  /**
   * The redirect URI registered on the Elvanto application.
   *
   * Defaults to this deployment's own origin plus `<basePath>/callback`. Set it
   * explicitly when the app sits behind a proxy that rewrites the host, since
   * Elvanto compares this string exactly and a mismatch is rejected at the
   * authorize step rather than at the callback.
   */
  redirectUri?: string
  basePath?: string
  sessionTtlMs?: number
  cookieName?: string
  /** Where the browser lands after a successful sign-in. Default `/`. */
  afterLogin?: string
  /** Override the OAuth origin. For tests against a stub. */
  oauthBaseUrl?: string
  /** Override the API root, for `people.currentUser` and the agent's own calls. */
  apiBaseUrl?: string
}

/** The conversation a signed-in person owns. */
export function conversationIdFor(session: Pick<ElvantoSession, 'personId'>): string {
  return `user-${session.personId}`
}

function storeFor(options: ElvantoAuthOptions, context: Context): SessionStore {
  return typeof options.store === 'function' ? options.store(context) : options.store
}

function redirectUriFor(options: ElvantoAuthOptions, context: Context): string {
  if (options.redirectUri) return options.redirectUri
  const url = new URL(context.req.url)
  return `${url.origin}${options.basePath ?? DEFAULT_BASE_PATH}/callback`
}

/**
 * Whether to mark the cookie `Secure`.
 *
 * Derived from the request rather than configured, because getting it wrong in
 * either direction is bad in a way that is hard to notice: hard-coded `true`
 * makes sign-in silently fail on a plain-HTTP localhost, and hard-coded `false`
 * ships a session cookie that a downgrade attack can read.
 */
function isSecureRequest(context: Context): boolean {
  const url = new URL(context.req.url)
  return url.protocol === 'https:' || context.req.header('x-forwarded-proto') === 'https'
}

/** The sign-in routes, to mount at `basePath`. */
export function elvantoAuthRoutes(options: ElvantoAuthOptions): Hono {
  const app = new Hono()
  const basePath = options.basePath ?? DEFAULT_BASE_PATH
  const cookieName = options.cookieName ?? DEFAULT_COOKIE_NAME

  app.get('/login', async (context) => {
    const state = await createState({
      secret: options.stateSecret,
      // The post-sign-in destination rides in the signed state rather than in a
      // second cookie, so it cannot be tampered with and needs no storage.
      payload: { to: sanitizeReturnPath(context.req.query('to'), options.afterLogin) },
    })

    return context.redirect(
      authorizeUrl({
        clientId: options.clientId,
        redirectUri: redirectUriFor(options, context),
        scopes: options.scopes ?? DEFAULT_SCOPES,
        state,
        ...(options.oauthBaseUrl ? { baseUrl: options.oauthBaseUrl } : {}),
      }),
    )
  })

  app.get('/callback', async (context) => {
    const declined = context.req.query('error')
    if (declined) {
      return context.html(page('Sign-in declined', `Elvanto reported: ${escapeHtml(declined)}`), 400)
    }

    let statePayload: Record<string, unknown>
    try {
      statePayload = await readState({
        secret: options.stateSecret,
        state: context.req.query('state'),
      })
    } catch {
      // Deliberately terse. A state failure is either a stale tab or someone
      // trying to bind a session to an account that is not the visitor's, and
      // neither is helped by explaining which.
      return context.html(
        page(
          'Sign-in refused',
          'That sign-in link has expired or did not come from here. Start again.',
        ),
        400,
      )
    }

    const code = context.req.query('code')
    if (!code) {
      return context.html(page('Sign-in failed', 'Elvanto sent no authorization code.'), 400)
    }

    const store = storeFor(options, context)

    let session: ElvantoSession
    try {
      const tokens = await exchangeCode({
        clientId: options.clientId,
        clientSecret: options.clientSecret,
        code,
        redirectUri: redirectUriFor(options, context),
        ...(options.oauthBaseUrl ? { baseUrl: options.oauthBaseUrl } : {}),
      })

      // Who signed in has to come from Elvanto, not from anything the browser
      // said — it is the identity the ownership check is built on.
      const client = new ElvantoClient({
        auth: { accessToken: tokens.accessToken },
        validate: 'warn',
        ...(options.apiBaseUrl ? { baseUrl: options.apiBaseUrl } : {}),
      })
      const person = await client.people.currentUser()
      const personId = person?.id
      if (!personId) {
        return context.html(
          page(
            'Sign-in failed',
            'Elvanto authorized the application but did not say who you are, so ' +
              'there is no identity to attach this session to.',
          ),
          502,
        )
      }

      await store.write(personId, tokens)
      session = {
        id: randomToken(32),
        personId,
        name: [person.firstname, person.lastname].filter(Boolean).join(' '),
        createdAt: Date.now(),
        expiresAt: Date.now() + (options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS),
      }
      await store.writeSession(session)
    } catch (error) {
      const detail =
        error instanceof ElvantoOAuthError ? error.message : 'The token exchange failed.'
      return context.html(page('Sign-in failed', escapeHtml(detail)), 502)
    }

    setCookie(context, cookieName, session.id, {
      httpOnly: true,
      secure: isSecureRequest(context),
      // Lax rather than Strict: the callback is itself a cross-site navigation
      // from Elvanto, and Strict would withhold the cookie on exactly that hop.
      sameSite: 'Lax',
      path: '/',
      maxAge: Math.floor((session.expiresAt - Date.now()) / 1000),
    })

    const to =
      typeof statePayload['to'] === 'string'
        ? statePayload['to']
        : (options.afterLogin ?? '/')
    return context.redirect(to)
  })

  const signOut = async (context: Context): Promise<Response> => {
    const id = getCookie(context, cookieName)
    if (id) await storeFor(options, context).deleteSession(id)
    deleteCookie(context, cookieName, { path: '/' })
    // The grant itself is left alone: signing out of a browser should not
    // silently revoke a grant the same person's other sessions are using. To
    // withdraw it entirely, revoke the application in Elvanto's own settings.
    return context.redirect('/')
  }
  app.post('/logout', signOut)
  app.get('/logout', signOut)

  app.get('/session', async (context) => {
    const session = await currentSession(context, options)
    if (!session) return context.json({ signedIn: false, loginUrl: `${basePath}/login` })
    return context.json({
      signedIn: true,
      name: session.name,
      conversationId: conversationIdFor(session),
      expiresAt: session.expiresAt,
    })
  })

  return app
}

/** Reads and validates the session cookie. */
export async function currentSession(
  context: Context,
  options: ElvantoAuthOptions,
): Promise<ElvantoSession | undefined> {
  const id = getCookie(context, options.cookieName ?? DEFAULT_COOKIE_NAME)
  if (!id) return undefined
  const session = await storeFor(options, context).readSession(id)
  if (!session) return undefined
  if (session.expiresAt <= Date.now()) {
    await storeFor(options, context).deleteSession(id)
    return undefined
  }
  return session
}

export interface RequireSessionOptions extends ElvantoAuthOptions {
  /**
   * The path the agent router is mounted at, e.g. `/agents/elvanto`. Used to
   * find the conversation id, which is the first segment after it.
   */
  mount: string
}

/**
 * Guards the agent mount.
 *
 * Does three things, and the second two are the ones that are easy to skip:
 *
 * 1. **Authentication.** No valid session, no access.
 * 2. **Ownership.** The conversation id must be the one this person owns.
 *    Conversation ids are caller-chosen path segments, so without this any
 *    signed-in user can read any other's history by editing the URL.
 * 3. **Identity binding.** A message that creates a conversation carries
 *    `initialData`, which is how the agent learns whose grant to use. The browser
 *    sends it, so it is checked here against the session rather than believed —
 *    otherwise a signed-in user could name someone else's person id and have the
 *    agent act with *their* Elvanto permissions.
 */
export function requireElvantoSession(
  options: RequireSessionOptions,
): MiddlewareHandler {
  const mount = options.mount.replace(/\/$/, '')

  return async (context, next) => {
    const session = await currentSession(context, options)
    if (!session) {
      // A browser navigating here should be offered the sign-in; an API caller
      // should be told plainly. Guessing from Accept is imperfect but the failure
      // mode is mild either way.
      if ((context.req.header('accept') ?? '').includes('text/html')) {
        return context.redirect(`${options.basePath ?? DEFAULT_BASE_PATH}/login`)
      }
      return context.json(
        { error: 'unauthorized', loginUrl: `${options.basePath ?? DEFAULT_BASE_PATH}/login` },
        401,
      )
    }

    const path = new URL(context.req.url).pathname
    const rest = path.startsWith(mount) ? path.slice(mount.length).replace(/^\//, '') : ''
    const conversationId = rest.split('/')[0] ?? ''
    if (conversationId && conversationId !== conversationIdFor(session)) {
      return context.json({ error: 'forbidden' }, 403)
    }

    if (context.req.method === 'POST') {
      // Cloned so the body stays readable by the agent router behind this.
      const claimed = await context.req.raw
        .clone()
        .json()
        .then((body: unknown) =>
          body && typeof body === 'object'
            ? ((body as { initialData?: { personId?: unknown } }).initialData?.personId ??
              undefined)
            : undefined,
        )
        .catch(() => undefined)

      if (claimed !== undefined && claimed !== session.personId) {
        return context.json({ error: 'forbidden', detail: 'initialData does not match the session' }, 403)
      }
    }

    context.set('elvantoSession', session)
    return next()
  }
}

/**
 * The client the agent's tools should use for a given person.
 *
 * Separate from `clientFromEnv` because the credential is per-conversation rather
 * than per-process: the whole point of signing in is that two people talking to
 * the same deployment do not share one view of the account.
 */
export function tokenSourceFor(
  store: SessionStore,
  personId: string,
  options: {
    clientId?: string | undefined
    clientSecret?: string | undefined
    oauthBaseUrl?: string | undefined
  } = {},
): TokenSource {
  return createTokenSource({
    store,
    key: personId,
    clientId: options.clientId,
    clientSecret: options.clientSecret,
    ...(options.oauthBaseUrl ? { baseUrl: options.oauthBaseUrl } : {}),
  })
}

/**
 * Keeps a redirect target on this origin.
 *
 * An open redirect on a sign-in route is worth more to an attacker than most,
 * because the link that reaches the victim is a genuine one from the real site.
 * Only a path is ever accepted, and `//host` is rejected along with everything
 * else that a browser would read as a host.
 */
function sanitizeReturnPath(
  requested: string | undefined,
  fallback: string | undefined,
): string {
  const target = requested ?? fallback ?? '/'
  if (!target.startsWith('/') || target.startsWith('//')) return '/'
  return target
}

function page(title: string, detail: string): string {
  return (
    `<!doctype html><meta charset="utf-8"><title>${escapeHtml(title)}</title>` +
    `<body style="font:16px/1.6 system-ui,sans-serif;max-width:32rem;margin:20vh auto;padding:0 1rem">` +
    `<h1 style="font-size:1.1rem">${escapeHtml(title)}</h1><p>${detail}</p>` +
    `<p><a href="/">Back</a></p></body>`
  )
}

function escapeHtml(text: string): string {
  return text.replace(
    /[&<>"']/g,
    (character) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!,
  )
}
