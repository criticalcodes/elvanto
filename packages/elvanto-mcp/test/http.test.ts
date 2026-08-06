import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { ElvantoClient, toMcpToolName } from '@criticalcodes/elvanto'
import { afterEach, describe, expect, test } from 'vitest'
import { createHttpHandler } from '../src/http.js'
import { serveHttp, type RunningHttpServer } from '../src/serve.js'
import type { ServerConfig } from '../src/server.js'

/**
 * The parts of a JSON-RPC envelope these tests read.
 *
 * `Response.json()` is `unknown`, and the tests that bypass the MCP client to
 * assert on the wire need a shape to read through.
 */
interface JsonRpcEnvelope {
  error?: { code: number; message: string }
  result?: {
    isError?: boolean
    serverInfo?: { name: string; version: string }
  }
}

async function envelope(response: Response): Promise<JsonRpcEnvelope> {
  return (await response.json()) as JsonRpcEnvelope
}

let running: RunningHttpServer[] = []
let clients: Client[] = []

afterEach(async () => {
  for (const client of clients) await client.close().catch(() => {})
  for (const server of running) await server.close()
  clients = []
  running = []
})

const peoplePage = {
  status: 'ok',
  people: {
    page: 1,
    per_page: 25,
    on_this_page: 1,
    total: 1,
    person: [{ id: 'p1', firstname: 'Ada', lastname: 'Lovelace' }],
  },
}

/** A config whose Elvanto calls are answered locally, so no network is touched. */
function stubConfig(
  respond: () => unknown = () => peoplePage,
  status = 200,
): ServerConfig {
  return {
    createClient: () =>
      new ElvantoClient({
        auth: { apiKey: 'test-key' },
        maxRetries: 0,
        fetch: async () =>
          new Response(JSON.stringify(respond()), {
            status,
            headers: { 'content-type': 'application/json' },
          }),
      }),
  }
}

/**
 * Binds a real socket and connects a real MCP client over it.
 *
 * Port 0 rather than a fixed port, so a developer already running the server —
 * or two test files at once — cannot make this fail with EADDRINUSE.
 */
async function serve(
  config: ServerConfig = stubConfig(),
  options: { token?: string; host?: string } = {},
): Promise<RunningHttpServer> {
  const server = await serveHttp(config, {
    host: options.host ?? '127.0.0.1',
    port: 0,
    ...(options.token ? { token: options.token } : {}),
  })
  running.push(server)
  return server
}

async function connect(server: RunningHttpServer, token?: string): Promise<Client> {
  const client = new Client({ name: 'test', version: '1.0.0' })
  clients.push(client)
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`http://${server.host}:${server.port}/`), {
      ...(token
        ? { requestInit: { headers: { authorization: `Bearer ${token}` } } }
        : {}),
    }),
  )
  return client
}

describe('MCP over streamable HTTP', () => {
  test('a real client completes the handshake and lists every tool', async () => {
    const client = await connect(await serve())
    const { tools } = await client.listTools()

    // The same 25 the stdio transport advertises — the transport must not change
    // the tool set.
    expect(tools.length).toBe(25)
    expect(tools.map((t) => t.name)).toContain(toMcpToolName('people.getAll'))
  })

  test('calls a tool and returns the normalized result', async () => {
    const client = await connect(await serve())
    const result = await client.callTool({
      name: toMcpToolName('people.getAll'),
      arguments: {},
    })

    const text = (result.content as Array<{ text: string }>)[0]!.text
    expect(result.isError).toBeFalsy()
    expect(JSON.parse(text)).toMatchObject({ total: 1, items: [{ firstname: 'Ada' }] })
  })

  test('survives a second, independent request after initialize', async () => {
    // The point of the stateless design: initialize and the call are separate
    // HTTP requests served by separate server instances. If session validation
    // were active, the second would be rejected.
    const client = await connect(await serve())
    await client.listTools()
    await client.listTools()
    const result = await client.callTool({
      name: toMcpToolName('people.getAll'),
      arguments: {},
    })
    expect(result.isError).toBeFalsy()
  })

  test('two concurrent callers do not interfere', async () => {
    const server = await serve()
    const [a, b] = await Promise.all([connect(server), connect(server)])
    const [first, second] = await Promise.all([a!.listTools(), b!.listTools()])
    expect(first.tools.length).toBe(second.tools.length)
  })

  describe('authentication', () => {
    test('accepts the configured bearer token', async () => {
      const client = await connect(await serve(stubConfig(), { token: 'sekret' }), 'sekret')
      expect((await client.listTools()).tools.length).toBe(25)
    })

    test('rejects a missing token with 401 and names the scheme', async () => {
      const server = await serve(stubConfig(), { token: 'sekret' })
      const response = await fetch(`http://${server.host}:${server.port}/`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      })

      expect(response.status).toBe(401)
      expect(response.headers.get('www-authenticate')).toBe('Bearer')
    })

    test('rejects a wrong token, and does not leak whether the name existed', async () => {
      const server = await serve(stubConfig(), { token: 'sekret' })
      for (const header of ['Bearer wrong', 'Bearer', 'Basic sekret', 'sekret']) {
        const response = await fetch(`http://${server.host}:${server.port}/`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: header },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
        })
        expect(response.status, header).toBe(401)
      }
    })

    test('a token of the same length as the secret is still rejected', async () => {
      // Guards the constant-time comparison: equal lengths take the compare path
      // rather than the early length return.
      const server = await serve(stubConfig(), { token: 'sekret' })
      const response = await fetch(`http://${server.host}:${server.port}/`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer secret' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      })
      expect(response.status).toBe(401)
    })

    test('serves without a token when none is configured', async () => {
      const client = await connect(await serve())
      expect((await client.listTools()).tools.length).toBe(25)
    })
  })

  describe('unsupported methods', () => {
    test('declines GET and DELETE with 405 and an Allow header', async () => {
      const server = await serve()
      for (const method of ['GET', 'DELETE', 'PUT']) {
        const response = await fetch(`http://${server.host}:${server.port}/`, { method })
        expect(response.status, method).toBe(405)
        expect(response.headers.get('allow'), method).toBe('POST')
        // Shaped as JSON-RPC, so a client parses the reason rather than guessing.
        expect((await envelope(response)).error?.code).toBe(-32000)
      }
    })

    test('authentication is checked before the method', async () => {
      // Otherwise an unauthenticated probe learns which methods are offered.
      const server = await serve(stubConfig(), { token: 'sekret' })
      const response = await fetch(`http://${server.host}:${server.port}/`, { method: 'GET' })
      expect(response.status).toBe(401)
    })
  })

  describe('Elvanto failures', () => {
    async function callWith(config: ServerConfig): Promise<{ isError: boolean; text: string }> {
      const client = await connect(await serve(config))
      const result = await client.callTool({
        name: toMcpToolName('people.getAll'),
        arguments: {},
      })
      return {
        isError: Boolean(result.isError),
        text: (result.content as Array<{ text: string }>)[0]!.text,
      }
    }

    test('a failure arriving as HTTP 200 is still a tool error', async () => {
      // Elvanto reports some failures with a 200 and `{"status":"fail"}` in the
      // body. The transport must not read that as success.
      const { isError, text } = await callWith(
        stubConfig(() => ({ status: 'fail', error: { code: 256, message: 'Invalid API key' } })),
      )
      expect(isError).toBe(true)
      expect(text).toContain('Invalid API key')
    })

    test('a 401 is reported as unfixable by the model', async () => {
      const { isError, text } = await callWith(
        stubConfig(
          () => ({ status: 'fail', error: { code: 101, message: 'Unauthorised' } }),
          401,
        ),
      )
      expect(isError).toBe(true)
      // The distinction that matters to an agent: retrying or rephrasing will
      // not help, so it should stop rather than loop.
      expect(text).toContain('credentials')
      expect(text).toContain('ELVANTO_API_KEY')
    })

    test('the HTTP layer still returns 200 — the error is in the tool result', async () => {
      // A JSON-RPC transport error would make the host retry the protocol call;
      // a tool error is data the model can read and act on.
      const server = await serve(
        stubConfig(() => ({ status: 'fail', error: { code: 101, message: 'Nope' } }), 401),
      )
      const raw = await fetch(`http://${server.host}:${server.port}/`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: toMcpToolName('people.getAll'), arguments: {} },
        }),
      })
      expect(raw.status).toBe(200)
      expect((await envelope(raw)).result?.isError).toBe(true)
    })
  })

  test('the handler needs no server, so it can be mounted anywhere', async () => {
    // What a Worker or Hono route does: hand it a Request, get a Response.
    const handle = createHttpHandler(stubConfig())
    const response = await handle(
      new Request('https://example.invalid/mcp', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-06-18',
            capabilities: {},
            clientInfo: { name: 'test', version: '1.0.0' },
          },
        }),
      }),
    )

    expect(response.status).toBe(200)
    expect((await envelope(response)).result?.serverInfo?.name).toBe('elvanto')
  })
})
