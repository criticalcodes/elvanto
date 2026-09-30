import { configFromEnv, createHttpHandler } from '@criticalcodes/elvanto-mcp'
import { elvantoRoutes } from './routes.ts'
import { authOptionsFromEnv } from './auth/index.ts'
import { Elvanto } from './agents/elvanto.ts'
import { sessionStore } from '#sessions'

/**
 * The route map, and the whole server.
 *
 * `vite build` turns this into `dist-app/server.mjs` for Node and a Worker for
 * Cloudflare, so there is no listener, port handling or shutdown logic to write —
 * and the web chat mounted below is served identically on both targets.
 *
 *   curl -X POST http://localhost:5173/agents/elvanto/user-123 \
 *     -H 'content-type: application/json' \
 *     -d '{"kind":"user","body":"Who is serving this Sunday?"}'
 */

/**
 * Per-user sign-in, when an OAuth application is configured.
 *
 * `undefined` when ELVANTO_CLIENT_ID, ELVANTO_CLIENT_SECRET and
 * ELVANTO_SESSION_SECRET are all absent, which is the local case: the agent then
 * runs against ELVANTO_API_KEY with no access control, and `elvantoRoutes` says
 * so loudly. Set all three and every caller signs in as themselves instead.
 */
const auth = authOptionsFromEnv({ store: () => sessionStore() })

const app = elvantoRoutes({
  agent: Elvanto,
  title: 'Elvanto assistant',
  ...(auth ? { auth } : {}),
})

// Serving MCP *to other hosts* from the same deployment — Claude Desktop, a remote
// connector, another framework. The agent itself does not use this: it reaches
// Elvanto through in-process endpoint tools.
//
// The token is required, unlike the standalone server's loopback case: this route
// is mounted on whatever origin the app is served from, so it is reachable by
// definition. With no token set the handler is not mounted at all — failing closed
// rather than publishing member and giving data.
//
// This route is *not* covered by the sign-in above, and cannot be: MCP hosts hold
// a bearer token, not a browser cookie. It therefore still speaks to Elvanto with
// the account-wide key in the environment, and remains the one surface here where
// a caller's reach is not their own. Leave ELVANTO_MCP_TOKEN unset on a deployment
// where that is not wanted.
const mcpToken = process.env['ELVANTO_MCP_TOKEN']
if (mcpToken) {
  const mcp = createHttpHandler(configFromEnv(), { token: mcpToken })
  app.all('/mcp', (c) => mcp(c.req.raw))
}

export default app
