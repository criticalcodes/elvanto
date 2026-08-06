import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { createServer, type ServerConfig } from './server.js'

/**
 * MCP over streamable HTTP, as a `Request → Response` function.
 *
 * Deliberately free of Node imports so the same handler runs on Cloudflare
 * Workers, Deno and Bun as well as Node — `serve.ts` owns the Node listener. The
 * reason this exists at all is that MCP hosts are split: stdio is what a desktop
 * client launches, but agent frameworks increasingly speak only HTTP. Flue, for
 * one, accepts a URL and has no stdio transport.
 *
 * ## Stateless, one server per request
 *
 * Every request gets a fresh {@link createServer} and transport, and no session
 * state is kept. That costs a tool-list rebuild per request — cheap, and the list
 * is derived from a static registry — and buys two things worth more: the handler
 * works on a runtime with no durable process between requests, and two
 * concurrent callers cannot interleave on one server's single transport slot.
 *
 * Stateless mode is what makes it legal: the transport's session validation
 * short-circuits when `sessionIdGenerator` is undefined, so a `tools/call` whose
 * `initialize` landed on a different instance is still served.
 */
export interface HttpHandlerOptions {
  /**
   * Bearer token required on every request. Compared in constant time.
   *
   * Optional here because the loopback case does not need it, but the process
   * that binds a socket should think harder — see `planStartup`, which refuses to
   * serve a non-loopback interface without one. An API key grants read access to
   * every member and giving record in the account, so an unauthenticated port is
   * a copy of the church database.
   */
  token?: string
}

/**
 * Builds the request handler.
 *
 * ```ts
 * // Hono, or any web-standard router.
 * app.all('/mcp', (c) => handler(c.req.raw))
 * ```
 */
export function createHttpHandler(
  config: ServerConfig = {},
  options: HttpHandlerOptions = {},
): (request: Request) => Promise<Response> {
  return async function handle(request: Request): Promise<Response> {
    if (options.token !== undefined && !isAuthorized(request, options.token)) {
      // A bare 401 tells a misconfigured client nothing; naming the scheme lets
      // it retry correctly, and it leaks nothing an attacker could not guess.
      return jsonRpcError(401, -32001, 'Unauthorized: a bearer token is required.', {
        'www-authenticate': 'Bearer',
      })
    }

    // Only POST carries JSON-RPC. GET opens a server-initiated SSE stream, which
    // a read-only server never writes to, and DELETE ends a session this handler
    // does not keep — the spec lets a server decline both, and clients treat 405
    // as "not offered" rather than as a failure.
    if (request.method !== 'POST') {
      return jsonRpcError(
        405,
        -32000,
        `${request.method} is not supported. This server accepts JSON-RPC over POST; ` +
          `it holds no session state and sends no unsolicited notifications.`,
        { allow: 'POST' },
      )
    }

    const server = createServer(config)
    const transport = new WebStandardStreamableHTTPServerTransport({
      // Stateless: see the note above.
      sessionIdGenerator: undefined,
      // Answer with a plain JSON body rather than an SSE frame. Nothing here
      // streams — a tool call is one round trip to Elvanto — and a buffered body
      // is what lets this close the server before returning, below.
      enableJsonResponse: true,
    })

    try {
      await server.connect(transport)
      const response = await transport.handleRequest(request)

      // Read the body out before tearing the server down. Returning the
      // transport's own Response and closing after would race: closing can
      // cancel the underlying stream, and the caller would see a truncated body
      // for the largest responses only — the worst kind of bug to find later.
      const body = await response.arrayBuffer()
      return new Response(body, {
        status: response.status,
        headers: response.headers,
      })
    } finally {
      // Both, and in this order: the server owns the transport it connected to,
      // and a stateless handler that leaks either accumulates one per request.
      await server.close().catch(() => {})
      await transport.close().catch(() => {})
    }
  }
}

/**
 * Constant-time bearer comparison.
 *
 * Hand-rolled because `crypto.timingSafeEqual` is Node-only and this module has
 * to run on Workers. Length is compared first and leaks only the token's length,
 * which is not the secret.
 */
function isAuthorized(request: Request, expected: string): boolean {
  const header = request.headers.get('authorization')
  if (!header) return false

  const match = /^Bearer[ ]+(.+)$/i.exec(header.trim())
  if (!match) return false

  const presented = match[1]!
  if (presented.length !== expected.length) return false

  let difference = 0
  for (let i = 0; i < presented.length; i++) {
    difference |= presented.charCodeAt(i) ^ expected.charCodeAt(i)
  }
  return difference === 0
}

/** A JSON-RPC error shaped like the transport's own, so clients parse it alike. */
function jsonRpcError(
  status: number,
  code: number,
  message: string,
  headers: Record<string, string> = {},
): Response {
  return new Response(
    JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null }),
    { status, headers: { 'content-type': 'application/json', ...headers } },
  )
}
