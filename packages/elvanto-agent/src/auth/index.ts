/**
 * Per-user Elvanto sign-in for a deployed agent.
 *
 * Mount {@link elvantoAuthRoutes} for the flow, put {@link requireElvantoSession}
 * in front of the agent, and give the agent's tools a client built from the
 * signed-in person's grant rather than from an account-wide API key. See
 * `./routes.ts` for the shape of it and `./store.ts` for where the tokens live.
 */

export {
  DEFAULT_BASE_PATH,
  DEFAULT_COOKIE_NAME,
  DEFAULT_SESSION_TTL_MS,
  conversationIdFor,
  currentSession,
  elvantoAuthRoutes,
  requireElvantoSession,
  tokenSourceFor,
  type ElvantoAuthOptions,
  type RequireSessionOptions,
} from './routes.ts'

export {
  MemorySessionStore,
  SESSION_OBJECT_NAME,
  createSessionStoreClass,
  durableObjectSessionStore,
  type DurableObjectNamespaceLike,
  type DurableObjectStateLike,
  type DurableObjectStorageLike,
  type DurableObjectStubLike,
  type ElvantoSession,
  type SessionStore,
} from './store.ts'

import type { Context } from 'hono'
import type { ElvantoAuthOptions } from './routes.ts'
import type { SessionStore } from './store.ts'
import type { Env } from '../client.ts'

/**
 * Builds auth options from the environment, or returns `undefined`.
 *
 * `undefined` rather than a throw when the three secrets are not all present,
 * because an agent with no OAuth application configured is a supported way to run
 * this — locally, against an API key, with the existing loud warning about the
 * mount being unauthenticated. Half-configured is the case worth failing on, and
 * it fails with a message naming what is missing.
 */
export function authOptionsFromEnv(
  options: {
    store: SessionStore | ((context: Context) => SessionStore)
    env?: Env
  } & Partial<ElvantoAuthOptions>,
): ElvantoAuthOptions | undefined {
  const env = options.env ?? (typeof process === 'undefined' ? {} : (process.env as Env))

  const clientId = env['ELVANTO_CLIENT_ID']?.trim()
  const clientSecret = env['ELVANTO_CLIENT_SECRET']?.trim()
  const stateSecret = env['ELVANTO_SESSION_SECRET']?.trim()

  const present = [clientId, clientSecret, stateSecret].filter(Boolean).length
  if (present === 0) return undefined
  if (present < 3) {
    const missing = [
      clientId ? '' : 'ELVANTO_CLIENT_ID',
      clientSecret ? '' : 'ELVANTO_CLIENT_SECRET',
      stateSecret ? '' : 'ELVANTO_SESSION_SECRET',
    ].filter(Boolean)
    throw new Error(
      `Elvanto OAuth is partly configured: ${missing.join(' and ')} ${
        missing.length === 1 ? 'is' : 'are'
      } missing. Set all three, or none of them to run without sign-in. ` +
        `Generate the session secret with \`openssl rand -hex 32\`.`,
    )
  }

  return {
    ...options,
    clientId: clientId!,
    clientSecret: clientSecret!,
    stateSecret: stateSecret!,
    ...(env['ELVANTO_REDIRECT_URI'] ? { redirectUri: env['ELVANTO_REDIRECT_URI'] } : {}),
    ...(env['ELVANTO_OAUTH_BASE_URL'] ? { oauthBaseUrl: env['ELVANTO_OAUTH_BASE_URL'] } : {}),
    ...(env['ELVANTO_BASE_URL'] ? { apiBaseUrl: env['ELVANTO_BASE_URL'] } : {}),
  }
}
