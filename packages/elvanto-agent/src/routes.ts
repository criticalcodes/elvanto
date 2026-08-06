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
 * An earlier version of this package shipped its own `serve` command instead. It
 * reproduced what the build already emits, needed an extra dependency, and worked
 * only on Node — so it is gone.
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

  app.route(mount, createAgentRouter(options.agent))

  if (options.chatUi !== false) {
    app.get('/', (c) =>
      c.html(
        webChatPage({
          mount,
          title: options.title ?? agentIdentity(options.agent),
          // `?id=` joins a named conversation, so a link can point at one.
          conversationId: c.req.query('id') ?? 'web',
        }),
      ),
    )
  }

  return app
}
