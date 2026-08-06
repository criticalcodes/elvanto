import { configFromEnv, createHttpHandler } from '@criticalcodes/elvanto-mcp'
import { elvantoRoutes } from './routes.ts'
import { Elvanto } from './agents/elvanto.ts'

/**
 * The route map, and the whole server.
 *
 * `vite build` turns this into `dist-app/server.mjs` for Node and a Worker for
 * Cloudflare, so there is no listener, port handling or shutdown logic to write —
 * and the web chat mounted below is served identically on both targets.
 *
 *   curl -X POST http://localhost:5173/agents/elvanto/office \
 *     -H 'content-type: application/json' \
 *     -d '{"kind":"user","body":"Who is serving this Sunday?"}'
 */
const app = elvantoRoutes({ agent: Elvanto, title: 'Elvanto assistant' })

// Serving MCP *to other hosts* from the same deployment — Claude Desktop, a remote
// connector, another framework. The agent itself does not use this: it reaches
// Elvanto through in-process endpoint tools.
//
// The token is required, unlike the standalone server's loopback case: this route
// is mounted on whatever origin the app is served from, so it is reachable by
// definition. With no token set the handler is not mounted at all — failing closed
// rather than publishing member and giving data.
const mcpToken = process.env['ELVANTO_MCP_TOKEN']
if (mcpToken) {
  const mcp = createHttpHandler(configFromEnv(), { token: mcpToken })
  app.all('/mcp', (c) => mcp(c.req.raw))
}

export default app
