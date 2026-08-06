import { createAgentRouter } from '@flue/runtime/routing'
import { Hono } from 'hono'
import type { Agent } from '@flue/runtime'
import { webChatPage } from './cli/web.ts'
import {
  loginRoutes,
  requireToken,
  unconfiguredPage,
  type AuthMode,
} from './auth.ts'
import { ambientEnv, type Env } from './client.ts'

/**
 * The agent's HTTP surface, for mounting in `src/app.ts`.
 *
 * Belongs in `app.ts` rather than in a bespoke server because Flue already builds
 * one: `vite build` turns the route map into `dist/server.mjs` for Node and into a
 * Worker for Cloudflare. Anything mounted here is therefore served identically on
 * both targets, with no listener, port handling or shutdown logic written by hand.
 *
 * ## It fails closed
 *
 * Flue mounts agents with no authentication — its routing guide is explicit that
 * anyone who can reach a conversation URL can talk to it, read its whole history
 * and abort its work. Behind this particular agent is every member record in a
 * church's account, so serving it open is not a default worth having. With no token
 * configured, the agent routes are not mounted at all and the root explains why.
 */
export const DEFAULT_TOKEN_VARIABLE = 'ELVANTO_AGENT_TOKEN'

export interface ElvantoRoutesOptions {
  agent: Agent
  /** Mount path. Defaults to `/agents/<agent identity>`. */
  mount?: string
  /** Title in the chat page header. */
  title?: string
  /**
   * How callers are authenticated. Defaults to the shared token in
   * `ELVANTO_AGENT_TOKEN`.
   *
   * `'external'` mounts no guard, and is only correct when something in front has
   * already authenticated the caller — Cloudflare Access, an authenticating proxy,
   * a private network. It has to be written out, because choosing it by accident
   * leaves the account readable by anyone with the URL.
   */
  auth?: AuthMode
  env?: Env
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
 * Builds a Hono app with the agent's routes, a login form, and the web chat.
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

  const env = options.env ?? ambientEnv()
  const auth =
    options.auth ??
    (env[DEFAULT_TOKEN_VARIABLE]?.trim()
      ? ({ token: env[DEFAULT_TOKEN_VARIABLE]!.trim() } as const)
      : undefined)

  // No token, and no explicit decision to rely on something else: serve an
  // explanation instead of the agent. Loud and inconvenient on purpose — the
  // alternative is a public endpoint onto member records.
  if (auth === undefined) {
    console.warn(
      `[elvanto-agent] ${DEFAULT_TOKEN_VARIABLE} is not set, so the agent is not ` +
        `mounted. Set it, or pass auth: 'external' if authentication sits in front.`,
    )
    app.all('*', (c) => c.html(unconfiguredPage(DEFAULT_TOKEN_VARIABLE), 503))
    return app
  }

  if (auth !== 'external') {
    const login = loginRoutes(auth.token)
    // Before the guard, or signing in would require being signed in.
    app.get('/login', login.page)
    app.post('/login', login.submit)

    // `/*` covers every route the agent router serves — prompts, reads, aborts and
    // attachment downloads alike — and the chat page at the root.
    app.use(`${mount}/*`, requireToken(auth.token))
    app.use('/', requireToken(auth.token))
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
