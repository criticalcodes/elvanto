import { createAgentRouter } from '@flue/runtime/routing'
import { configFromEnv, createHttpHandler } from '@criticalcodes/elvanto-mcp'
import { Hono } from 'hono'
import { Elvanto } from './agents/elvanto.ts'

const app = new Hono()

// The route map. Talk to the agent with one POST per message:
//
//   curl -X POST http://localhost:5173/agents/elvanto/office \
//     -H 'content-type: application/json' \
//     -d '{"kind":"user","body":"Who is serving this Sunday?"}'
app.route('/agents/elvanto', createAgentRouter(Elvanto))

// The MCP server, mounted in-process.
//
// Two things this buys. Locally, `vite dev` gives you the agent and its MCP
// endpoint in one process, so there is no second terminal and no separate
// install — point ELVANTO_MCP_URL at http://127.0.0.1:5173/mcp. Deployed, it makes
// this application a remote MCP server other hosts can use.
//
// The token is required here, unlike the loopback case in the standalone server:
// this route is mounted on whatever origin the app is served from, so it is
// reachable by definition. With no token set, the handler is not mounted at all —
// failing closed rather than publishing member and giving data.
const mcpToken = process.env['ELVANTO_MCP_TOKEN']
if (mcpToken) {
  const mcp = createHttpHandler(configFromEnv(), { token: mcpToken })
  app.all('/mcp', (c) => mcp(c.req.raw))
} else {
  console.warn(
    '[elvanto-agent] ELVANTO_MCP_TOKEN is not set, so /mcp is not mounted. The ' +
      'custom tools still work; the raw Elvanto endpoint tools will be absent.',
  )
}

export default app
