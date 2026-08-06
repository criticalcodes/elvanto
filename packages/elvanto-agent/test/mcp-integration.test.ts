import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { ElvantoClient } from '@criticalcodes/elvanto'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
// Reached by path rather than through the package entry: `serveHttp` imports
// `node:http`, so it is deliberately not re-exported from a module that has to
// stay importable on Workers.
import { serveHttp, type RunningHttpServer } from '../../elvanto-mcp/src/serve.ts'
import { CORE_MCP_TOOLS, elvantoMcpConnection } from '../src/mcp.ts'

/**
 * The seam this whole package exists to cross.
 *
 * Flue's MCP client speaks HTTP and the Elvanto MCP server was stdio-only, so the
 * agent reaching the server at all depends on two things agreeing: the transport
 * added to the server, and the connection definition here. Unit tests cover each
 * side; only this covers the join.
 *
 * It binds a real socket and drives a real MCP client — the same transport Flue
 * uses — rather than trusting that the two halves match.
 */
describe('the agent connection against a live MCP server', () => {
  const TOKEN = 'integration-token'
  let server: RunningHttpServer
  let client: Client

  beforeAll(async () => {
    server = await serveHttp(
      {
        // No network: the server's Elvanto calls are answered locally.
        createClient: () =>
          new ElvantoClient({
            auth: { apiKey: 'test-key' },
            maxRetries: 0,
            fetch: async () =>
              new Response(
                JSON.stringify({
                  status: 'ok',
                  people: {
                    page: 1,
                    per_page: 25,
                    on_this_page: 1,
                    total: 1,
                    person: [{ id: 'p1', firstname: 'Ada', lastname: 'Lovelace' }],
                  },
                }),
                { headers: { 'content-type': 'application/json' } },
              ),
          }),
      },
      // Port 0, so a developer already running the server cannot break this.
      { host: '127.0.0.1', port: 0, token: TOKEN },
    )
  })

  afterAll(async () => {
    await client?.close().catch(() => {})
    await server?.close()
  })

  test('the definition the agent builds connects and authenticates', async () => {
    const definition = elvantoMcpConnection({
      env: {
        ELVANTO_MCP_URL: `http://${server.host}:${server.port}/`,
        ELVANTO_MCP_TOKEN: TOKEN,
      },
    })
    expect(definition).toBeDefined()

    client = new Client({ name: 'integration', version: '1.0.0' })
    await client.connect(
      new StreamableHTTPClientTransport(new URL(String(definition!.url)), {
        requestInit: { headers: { authorization: `Bearer ${definition!.auth as string}` } },
      }),
    )

    const { tools } = await client.listTools()
    expect(tools.length).toBe(25)
  })

  test('every name in the default allowlist exists on the running server', async () => {
    // The failure this prevents: Flue treats an unknown allowlisted name as an
    // error, so a drifted list breaks the agent at connection time in production.
    const exposed = new Set((await client.listTools()).tools.map((tool) => tool.name))
    const missing = CORE_MCP_TOOLS.filter((name) => !exposed.has(name))
    expect(missing).toEqual([])
  })

  test('a tool call round-trips through the transport', async () => {
    const result = await client.callTool({
      name: 'elvanto_people_get_all',
      arguments: { page_size: 25 },
    })

    expect(result.isError).toBeFalsy()
    const text = (result.content as Array<{ text: string }>)[0]!.text
    expect(JSON.parse(text)).toMatchObject({ items: [{ firstname: 'Ada' }] })
  })

  test('the default allowlist reaches no financial endpoint', async () => {
    const exposed = (await client.listTools()).tools.map((tool) => tool.name)
    // Present on the server, absent from what the agent mounts.
    expect(exposed.some((name) => name.includes('financial'))).toBe(true)
    expect(CORE_MCP_TOOLS.some((name) => name.includes('financial'))).toBe(false)
  })
})
