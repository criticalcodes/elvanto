// Worker-level Cloudflare code lives here; HTTP routing stays in src/app.ts.
//
//   - Named exports become top-level Worker exports — e.g. application-owned
//     Durable Object classes (declare their bindings in wrangler.jsonc).
//   - An optional default export adds non-HTTP handlers: scheduled (cron),
//     queue consumers, inbound email, etc. (never `fetch`).
//
// https://flueframework.com/docs/guide/cloudflare-target/#extending-cloudflarets-entrypoint

import { createSessionStoreClass } from './auth/store.ts'

/**
 * Where signed-in sessions and their OAuth grants live on Cloudflare.
 *
 * A Durable Object rather than a KV namespace, because this is a token store: a
 * Durable Object is single-threaded and strongly consistent, so two tool calls
 * refreshing the same expiring grant at once cannot both win and leave the loser's
 * refresh token spent. KV's eventual consistency would make that a real race with
 * an unpleasant symptom — a session that dies at a refresh boundary for no visible
 * reason.
 *
 * Its binding and migration are declared in `wrangler.jsonc`. Renaming this class
 * is a storage-identity change and needs a migration, so it is named for what it
 * holds rather than for the deployment.
 */
export class ElvantoSessionStore extends createSessionStoreClass() {}
