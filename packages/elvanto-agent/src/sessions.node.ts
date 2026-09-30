/**
 * The session store on Node. Selected by the `#sessions` alias in
 * `vite.config.ts` for the Node target, and used by `vite dev`.
 *
 * A module-level singleton, which is correct here for the reason it would be
 * wrong on Cloudflare: the Node build serves the sign-in routes and runs the
 * agent in one process, so both reach the same object.
 *
 * Two consequences worth stating rather than discovering. Sessions do not survive
 * a restart — everyone signs in again after a deploy, which is an inconvenience
 * and not a correctness problem. And a deployment running more than one instance
 * behind a load balancer will hand a user a session one instance cannot see; that
 * one *is* a correctness problem, and such a deployment should supply its own
 * {@link SessionStore} over Redis, Postgres or whatever it already runs.
 */

import { MemorySessionStore, type SessionStore } from './auth/store.ts'

const shared = new MemorySessionStore()

export function sessionStore(): SessionStore {
  return shared
}
