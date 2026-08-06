import { createAgentRouter } from '@flue/runtime/routing'
import { Hono } from 'hono'
import type { Agent } from '@flue/runtime'
import { webChatPage } from './cli/web.ts'

/**
 * The agent's HTTP surface, for mounting in `src/app.ts`.
 *
 * Belongs in `app.ts` rather than in a bespoke server because Flue already builds
 * one: `vite build` turns the route map into `dist/server.mjs` for Node and into a
 * Worker for Cloudflare. Anything mounted here is therefore served identically on
 * both targets, with no listener, port handling or shutdown logic written by hand.
 *
 * ## Unauthenticated. Local use only.
 *
 * There is no access control here, and that is a statement of current limitation
 * rather than a design choice. Flue mounts agents with no authentication — its
 * routing guide is explicit that anyone who can reach a conversation URL can talk
 * to it, read its full history and abort its work — and behind an Elvanto agent is
 * every member record the API key can see.
 *
 * A shared-token guard was written and removed. It authenticated nobody in
 * particular: one secret held by everyone, no identity, no per-conversation
 * ownership, and it would have made "we have auth" true in a way that mattered
 * less than it sounded. The real answer is Elvanto's OAuth, where each caller
 * signs in as themselves and the agent acts with *their* permissions instead of a
 * single all-seeing API key. Until that exists:
 *
 * - Run it locally, with `vite dev`, which binds localhost only.
 * - Do not deploy it to a public origin.
 * - If you must expose it before then, put real authentication in front —
 *   Cloudflare Access, an authenticating proxy — and treat the mount as trusted
 *   only because of that.
 */
export interface ElvantoRoutesOptions {
  agent: Agent
  /** Mount path. Defaults to `/agents/<agent identity>`. */
  mount?: string
  /** Title in the chat page header. */
  title?: string
  /**
   * Serve the built-in web chat at the app root. Default true.
   *
   * `false` when the application has its own front end — the agent's API routes
   * are mounted either way.
   */
  chatUi?: boolean
  /**
   * Suppress the "unauthenticated" warning.
   *
   * For an application that has put its own authentication in front of this mount
   * and does not need reminding. It silences a log line and nothing else — there
   * is no guard here to turn off.
   */
  quiet?: boolean
}

/**
 * The agent's durable identity — its `agentName` static, else the function name,
 * lowercased. The same rule `start()` uses, so a mount path cannot drift from the
 * conversation storage key.
 */
export function agentIdentity(agent: Agent): string {
  const named = agent as { agentName?: string; name?: string }
  return (named.agentName ?? named.name ?? 'agent').toLowerCase()
}

/**
 * Builds a Hono app with the agent's routes and, by default, the web chat.
 *
 * ```ts
 * // src/app.ts
 * import { elvantoRoutes } from '@criticalcodes/elvanto-agent/routes'
 * import { Church } from './agents/church.ts'
 *
 * export default elvantoRoutes({ agent: Church, title: 'Church office' })
 * ```
 */
export function elvantoRoutes(options: ElvantoRoutesOptions): Hono {
  const app = new Hono()
  const mount = options.mount ?? `/agents/${agentIdentity(options.agent)}`
  const title = options.title ?? agentIdentity(options.agent)

  if (!options.quiet) {
    // Every start, not once per install. Somebody eventually runs this on a host
    // that is not their laptop, and this is the last thing that says so.
    console.warn(
      '[elvanto-agent] This HTTP surface is UNAUTHENTICATED. Anyone who can reach ' +
        'it can read every member record the API key can see. Run it locally ' +
        '(`vite dev` binds localhost) and do not expose it without real ' +
        'authentication in front. Pending Elvanto OAuth support.',
    )
  }

  app.route(mount, createAgentRouter(options.agent))

  if (options.chatUi !== false) {
    app.get('/', (c) =>
      c.html(
        webChatPage({
          mount,
          title,
          // `?id=` joins a named conversation, so a link can point at one.
          conversationId: c.req.query('id') ?? 'web',
        }),
      ),
    )
  }

  return app
}
