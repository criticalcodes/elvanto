/**
 * The session store on Cloudflare. Selected by the `#sessions` alias in
 * `vite.config.ts` when building for the Worker target.
 *
 * Reached through the ambient `env` rather than a per-request binding, because
 * the two callers live in different isolates: the sign-in routes run in the
 * Worker, and the agent's tools run inside the agent's own Durable Object, which
 * never sees an HTTP request of its own. The ambient import is the only thing
 * both can read, and it is exactly what Flue's Cloudflare guide reaches for when
 * an agent needs an application-owned object.
 */

import { env } from 'cloudflare:workers'
import {
  durableObjectSessionStore,
  type DurableObjectNamespaceLike,
  type SessionStore,
} from './auth/store.ts'

export function sessionStore(): SessionStore {
  const namespace = env['ELVANTO_SESSIONS'] as DurableObjectNamespaceLike | undefined
  if (!namespace) {
    throw new Error(
      'No ELVANTO_SESSIONS binding. Declare the Durable Object binding and its ' +
        'migration in wrangler.jsonc — see the auth section of the README.',
    )
  }
  return durableObjectSessionStore(namespace)
}
