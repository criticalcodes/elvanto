import { createAgentRouter } from '@flue/runtime/routing'
import { Hono } from 'hono'
import type { Agent } from '@flue/runtime'
import { webChatPage } from './cli/web.ts'
import {
  conversationIdFor,
  currentSession,
  elvantoAuthRoutes,
  requireElvantoSession,
  DEFAULT_BASE_PATH,
  type ElvantoAuthOptions,
} from './auth/index.ts'

/**
 * The agent's HTTP surface, for mounting in `src/app.ts`.
 *
 * Belongs in `app.ts` rather than in a bespoke server because Flue already builds
 * one: `vite build` turns the route map into `dist/server.mjs` for Node and into a
 * Worker for Cloudflare. Anything mounted here is therefore served identically on
 * both targets, with no listener, port handling or shutdown logic written by hand.
 *
 * ## Authentication
 *
 * Pass `auth` and each caller signs in to Elvanto as themselves: the sign-in
 * routes are mounted, the agent mount is guarded, and the agent's tools act with
 * that person's own Elvanto permissions rather than with one account-wide API key.
 * That is what the shared-token guard removed earlier could never be — it
 * authenticated nobody in particular, one secret held by everyone, no identity and
 * no per-conversation ownership.
 *
 * Omit `auth` and there is no access control at all, which Flue's routing guide is
 * explicit about: anyone who can reach a conversation URL can talk to it, read its
 * full history and abort its work. Behind an Elvanto agent that is every member
 * record the API key can see. So without `auth`:
 *
 * - Run it locally, with `vite dev`, which binds localhost only.
 * - Do not deploy it to a public origin.
 * - If you must expose it, put real authentication in front — Cloudflare Access,
 *   an authenticating proxy — and treat the mount as trusted only because of that.
 *
 * The warning below fires in exactly that case, and is silent once `auth` is set.
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
   * is no guard here to turn off. Unnecessary when `auth` is set, which silences
   * it by making it untrue.
   */
  quiet?: boolean
  /**
   * Sign each caller in to Elvanto before they can reach the agent.
   *
   * Mounts the OAuth routes at `auth.basePath` (default `/auth`), guards the agent
   * mount with {@link requireElvantoSession}, and pins each person's conversation
   * to their own id so nobody can read anyone else's by editing the URL.
   *
   * Build it with `authOptionsFromEnv({ store })`, which returns `undefined` when
   * no OAuth application is configured — so the same route map runs signed-in in
   * production and unauthenticated on a laptop.
   */
  auth?: ElvantoAuthOptions | undefined
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

  if (!options.auth && !options.quiet) {
    // Every start, not once per install. Somebody eventually runs this on a host
    // that is not their laptop, and this is the last thing that says so.
    console.warn(
      '[elvanto-agent] This HTTP surface is UNAUTHENTICATED. Anyone who can reach ' +
        'it can read every member record the API key can see. Run it locally ' +
        '(`vite dev` binds localhost) and do not expose it without real ' +
        'authentication in front. Pass `auth` to sign each caller in to Elvanto.',
    )
  }

  if (options.auth) {
    const basePath = options.auth.basePath ?? DEFAULT_BASE_PATH
    app.route(basePath, elvantoAuthRoutes(options.auth))
    // Before the mount, and covering `/*` so it applies to every route the agent
    // router serves — prompts, reads, aborts and attachment downloads alike.
    app.use(`${mount}/*`, requireElvantoSession({ ...options.auth, mount }))
  }

  app.route(mount, createAgentRouter(options.agent))

  if (options.chatUi !== false) {
    app.get('/', async (c) => {
      if (!options.auth) {
        return c.html(
          webChatPage({
            mount,
            title,
            // `?id=` joins a named conversation, so a link can point at one.
            conversationId: c.req.query('id') ?? 'web',
          }),
        )
      }

      // Signed in, the conversation id is the person's own and not the visitor's
      // to choose — `?id=` is ignored rather than honoured, since the guard in
      // front of the mount would refuse anything else anyway.
      const session = await currentSession(c, options.auth)
      if (!session) {
        return c.html(
          signInPage({
            title,
            loginUrl: `${options.auth.basePath ?? DEFAULT_BASE_PATH}/login`,
          }),
        )
      }
      return c.html(
        webChatPage({
          mount,
          title,
          conversationId: conversationIdFor(session),
          signedInAs: session.name,
          logoutUrl: `${options.auth.basePath ?? DEFAULT_BASE_PATH}/logout`,
          personId: session.personId,
        }),
      )
    })
  }

  return app
}

/** The page a signed-out visitor gets instead of the chat. */
function signInPage(options: { title: string; loginUrl: string }): string {
  const escape = (text: string): string =>
    text.replace(
      /[&<>"']/g,
      (character) =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!,
    )

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(options.title)}</title>
<style>
  :root { color-scheme: light dark; --bg:#fbfbfa; --fg:#1a1a18; --muted:#6b6b66; --accent:#3d6b52; }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#17181a; --fg:#e8e8e4; --muted:#97978f; --accent:#7fb096; }
  }
  body {
    margin:0; background:var(--bg); color:var(--fg); min-height:100dvh;
    display:grid; place-items:center; padding:1.5rem;
    font:16px/1.6 ui-sans-serif,-apple-system,"Segoe UI",system-ui,sans-serif;
  }
  .card { max-width:26rem; text-align:center; }
  h1 { font-size:1.15rem; font-weight:600; margin:0 0 .5rem; }
  p { color:var(--muted); font-size:.92rem; margin:0 0 1.5rem; }
  a.button {
    display:inline-block; background:var(--accent); color:#fff; text-decoration:none;
    font-weight:550; padding:.6rem 1.4rem; border-radius:.5rem;
  }
  a.button:focus-visible { outline:2px solid var(--fg); outline-offset:2px; }
</style>
</head>
<body>
<div class="card">
  <h1>${escape(options.title)}</h1>
  <p>Sign in with Elvanto to continue. This assistant reads only what your own
     Elvanto account can see, and your conversation is private to you.</p>
  <a class="button" href="${escape(options.loginUrl)}">Sign in with Elvanto</a>
</div>
</body>
</html>`
}
