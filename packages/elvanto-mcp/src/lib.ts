/**
 * The importable surface of the Elvanto MCP server.
 *
 * Separate from `index.ts`, which is the `elvanto-mcp` executable and carries a
 * shebang. This entry exists so an application can mount the server in its own
 * HTTP surface — a Hono route, a Worker `fetch` — instead of spawning a process:
 *
 * ```ts
 * import { configFromEnv, createHttpHandler } from '@criticalcodes/elvanto-mcp'
 *
 * const handler = createHttpHandler(configFromEnv(), { token: env.ELVANTO_MCP_TOKEN })
 * app.all('/mcp', (c) => handler(c.req.raw))
 * ```
 *
 * `serve.ts` is deliberately not re-exported: it imports `node:http`, and this
 * entry has to stay importable on Workers.
 */

export { createHttpHandler, type HttpHandlerOptions } from './http.js'

export {
  buildTools,
  configFromEnv,
  createServer,
  toolDescription,
  DEFAULT_MAX_RESPONSE_CHARS,
  DEFAULT_PAGE_SIZE,
  MIN_MAX_RESPONSE_CHARS,
  SERVER_NAME,
  SERVER_VERSION,
  type ServerConfig,
} from './server.js'
