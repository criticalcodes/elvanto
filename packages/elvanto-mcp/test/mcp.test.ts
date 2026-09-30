import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js'
import { ElvantoClient, endpointIds, readEndpointIds, toMcpToolName } from '@criticalcodes/elvanto'
import { afterEach, describe, expect, test } from 'vitest'
import { z } from 'zod'
import {
  buildTools,
  configFromEnv,
  createServer,
  DEFAULT_PAGE_SIZE,
  describeError,
  fitToBudget,
  MIN_MAX_RESPONSE_CHARS,
  toolDescription,
  type ServerConfig,
} from '../src/server.js'

interface RecordedRequest {
  path: string
  body: Record<string, unknown>
}

let cleanup: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const close of cleanup) await close()
  cleanup = []
})

/**
 * Connects a real MCP client to the server over an in-memory transport, so the
 * tests exercise the actual protocol rather than calling handlers directly.
 */
async function connect(
  respond: (path: string, body: Record<string, unknown>) => unknown,
  config: Partial<ServerConfig> = {},
): Promise<{ client: Client; requests: RecordedRequest[] }> {
  const requests: RecordedRequest[] = []

  const server = createServer({
    ...config,
    createClient: () =>
      new ElvantoClient({
        auth: { apiKey: 'test-key' },
        maxRetries: 0,
        ...config.clientOptions,
        fetch: async (input, init) => {
          const path = String(input)
            .replace(/^https:\/\/api\.elvanto\.com\/v1\//, '')
            .replace(/\.json$/, '')
          const body =
            typeof init?.body === 'string' && init.body
              ? (JSON.parse(init.body) as Record<string, unknown>)
              : {}
          requests.push({ path, body })
          return new Response(JSON.stringify(respond(path, body)), {
            headers: { 'content-type': 'application/json' },
          })
        },
      }),
  })

  const client = new Client({ name: 'test', version: '1.0.0' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ])

  cleanup.push(async () => {
    await client.close()
    await server.close()
  })

  return { client, requests }
}

const peoplePage = {
  status: 'ok',
  people: {
    page: 1,
    per_page: 25,
    on_this_page: 1,
    total: 668,
    person: [
      {
        id: 'p1',
        firstname: 'John',
        lastname: 'Smith',
        volunteer: 1,
        locations: { location: [{ id: 'l1', name: 'Central Campus' }] },
      },
    ],
  },
}

const textOf = (result: CallToolResult): string => {
  const first = result.content[0]
  return first && first.type === 'text' ? first.text : ''
}

describe('tool listing', () => {
  test('exposes one tool per read-only endpoint', async () => {
    const { client } = await connect(() => peoplePage)
    const { tools } = await client.listTools()
    expect(tools).toHaveLength(readEndpointIds.length)
  })

  test('names every tool in snake_case, with no camelCase leaking through', async () => {
    const { client } = await connect(() => peoplePage)
    const { tools } = await client.listTools()
    for (const tool of tools) {
      expect(tool.name, tool.name).toMatch(/^elvanto_[a-z0-9_]+$/)
    }
    const names = tools.map((tool) => tool.name)
    expect(names).toContain('elvanto_people_flows_steps_get_all')
    expect(names).toContain('elvanto_songs_arrangements_get_info')
    expect(names).toContain('elvanto_people_custom_fields_get_all')
  })

  test('marks every tool as read-only and non-destructive', async () => {
    const { client } = await connect(() => peoplePage)
    const { tools } = await client.listTools()
    for (const tool of tools) {
      expect(tool.annotations?.readOnlyHint, tool.name).toBe(true)
      expect(tool.annotations?.destructiveHint, tool.name).toBe(false)
    }
  })

  test('gives each tool a JSON Schema derived from the endpoint parameters', async () => {
    const { client } = await connect(() => peoplePage)
    const { tools } = await client.listTools()
    const byName = new Map(tools.map((tool) => [tool.name, tool]))

    const getInfo = byName.get('elvanto_people_get_info')!
    expect(getInfo.inputSchema.type).toBe('object')
    expect(getInfo.inputSchema.required).toEqual(['id'])
    const properties = getInfo.inputSchema.properties as Record<string, { description?: string }>
    expect(properties['id']!.description).toContain('ID of the person')

    // Endpoints with no parameters still advertise an object schema.
    const calendars = byName.get('elvanto_calendar_get_all')!
    expect(calendars.inputSchema.type).toBe('object')
    expect(calendars.inputSchema.properties).toEqual({})
  })

  test('documents the page size default and links the docs', async () => {
    const { client } = await connect(() => peoplePage)
    const { tools } = await client.listTools()
    const peopleGetAll = tools.find((tool) => tool.name === 'elvanto_people_get_all')!

    expect(peopleGetAll.description).toContain(`up to ${DEFAULT_PAGE_SIZE} records`)
    expect(peopleGetAll.description).toContain('https://www.elvanto.com/api/people/getAll/')
  })

  test('tells a model when a shape has not met real data', () => {
    const describe_ = (verified: 'docs' | 'live') =>
      toolDescription(
        {
          id: 'widgets.getAll',
          path: 'widgets/getAll',
          effect: 'read',
          summary: 'List widgets.',
          params: z.object({}),
          result: { kind: 'single', key: 'widget', item: z.looseObject({}) },
          docs: 'https://www.elvanto.com/api/widgets/getAll/',
          verified,
        },
        25,
      )

    expect(describe_('docs')).toContain('not been verified against real data')
    expect(describe_('docs')).toContain('may differ')
    // A live-verified endpoint carries no such caveat, so the note stays
    // meaningful rather than appearing on everything.
    expect(describe_('live')).not.toContain('may differ')
  })

  test('carries the caveat on the endpoints that actually lack live data', async () => {
    const { client } = await connect(() => peoplePage)
    const { tools } = await client.listTools()
    const byName = new Map(tools.map((tool) => [tool.name, tool]))

    // Songs and financial were unreachable in the account swept.
    expect(byName.get('elvanto_songs_get_info')!.description).toContain(
      'not been verified against real data',
    )
    expect(byName.get('elvanto_financial_transactions_get_all')!.description).toContain(
      'not been verified against real data',
    )
    // People and groups were exercised for real.
    expect(byName.get('elvanto_people_get_all')!.description).not.toContain(
      'not been verified against real data',
    )
  })

  test('flags the OAuth-only endpoint', () => {
    const currentUser = buildTools().find(
      (tool: Tool) => tool.name === 'elvanto_people_current_user',
    )!
    expect(currentUser.description).toContain('Requires OAuth')
  })
})

describe('tool calls', () => {
  test('calls the endpoint and returns normalized JSON', async () => {
    const { client, requests } = await connect(() => peoplePage)
    const result = (await client.callTool({
      name: 'elvanto_people_get_all',
      arguments: {},
    })) as CallToolResult

    expect(result.isError).toBeFalsy()
    expect(requests[0]!.path).toBe('people/getAll')

    const payload = JSON.parse(textOf(result))
    expect(payload.total).toBe(668)
    expect(payload.has_more).toBe(true)
    expect(payload.returned).toBe(1)
    // Normalization is visible to the model.
    expect(payload.items[0].volunteer).toBe(true)
    expect(payload.items[0].locations).toEqual([{ id: 'l1', name: 'Central Campus' }])
  })

  test('caps page size by default so a big account cannot flood the context', async () => {
    const { client, requests } = await connect(() => peoplePage)
    await client.callTool({ name: 'elvanto_people_get_all', arguments: {} })
    expect(requests[0]!.body['page_size']).toBe(DEFAULT_PAGE_SIZE)
  })

  test('respects an explicit page size', async () => {
    const { client, requests } = await connect(() => peoplePage)
    await client.callTool({
      name: 'elvanto_people_get_all',
      arguments: { page_size: 200 },
    })
    expect(requests[0]!.body['page_size']).toBe(200)
  })

  test('does not inject a page size where the endpoint has none', async () => {
    const { client, requests } = await connect(() => ({
      status: 'ok',
      calendars: { calendar: [{ id: 'c1', name: 'Main' }] },
    }))
    await client.callTool({ name: 'elvanto_calendar_get_all', arguments: {} })
    expect(requests[0]!.body).toEqual({})
  })

  test('passes arguments through to Elvanto', async () => {
    const { client, requests } = await connect(() => peoplePage)
    await client.callTool({
      name: 'elvanto_people_search',
      arguments: { search: { lastname: 'Smith' }, fields: ['birthday'] },
    })
    expect(requests[0]!.body).toMatchObject({
      search: { lastname: 'Smith' },
      fields: ['birthday'],
    })
  })

  test('unwraps a single record rather than returning a one-element array', async () => {
    const { client } = await connect(() => ({
      status: 'ok',
      person: [{ id: 'p1', firstname: 'John' }],
    }))
    const result = (await client.callTool({
      name: 'elvanto_people_get_info',
      arguments: { id: 'p1' },
    })) as CallToolResult

    const payload = JSON.parse(textOf(result))
    expect(payload.firstname).toBe('John')
    expect(Array.isArray(payload)).toBe(false)
  })
})

describe('error reporting', () => {
  test('reports invalid arguments as a tool error, not a protocol failure', async () => {
    const { client } = await connect(() => peoplePage)
    const result = (await client.callTool({
      name: 'elvanto_people_get_info',
      arguments: {},
    })) as CallToolResult

    expect(result.isError).toBe(true)
    expect(textOf(result)).toMatch(/Invalid arguments/)
  })

  test('tells the model when a failure is the operator\'s to fix', async () => {
    const { client } = await connect(() => ({
      status: 'fail',
      error: { code: 401, message: 'Unauthorised' },
    }))
    const result = (await client.callTool({
      name: 'elvanto_people_get_all',
      arguments: {},
    })) as CallToolResult

    expect(result.isError).toBe(true)
    expect(textOf(result)).toMatch(/cannot be fixed by changing the request/)
  })

  test('explains that a 404 covers both bad IDs and empty filters', async () => {
    const { client } = await connect(() => ({
      status: 'fail',
      error: { code: 404, message: 'No people match your criteria' },
    }))
    const result = (await client.callTool({
      name: 'elvanto_people_get_all',
      arguments: {},
    })) as CallToolResult
    expect(textOf(result)).toMatch(/matches no records|match no records/)
  })

  test('points a schema mismatch at the operator, not the model', async () => {
    const { client } = await connect(() => ({
      status: 'ok',
      people: { page: 1, per_page: 1, on_this_page: 1, total: 1, person: [{ firstname: 'no id' }] },
    }))
    const result = (await client.callTool({
      name: 'elvanto_people_get_all',
      arguments: {},
    })) as CallToolResult

    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('ELVANTO_VALIDATE=warn')
  })

  test('honours the validation opt-out', async () => {
    const { client } = await connect(
      () => ({
        status: 'ok',
        people: { page: 1, per_page: 1, on_this_page: 1, total: 1, person: [{ firstname: 'no id' }] },
      }),
      { clientOptions: { validate: 'off', onWarning: () => {} } },
    )
    const result = (await client.callTool({
      name: 'elvanto_people_get_all',
      arguments: {},
    })) as CallToolResult

    expect(result.isError).toBeFalsy()
    expect(JSON.parse(textOf(result)).items).toHaveLength(1)
  })

  test('answers an unknown tool name with a pointer to tools/list', async () => {
    const { client, requests } = await connect(() => peoplePage)
    const result = (await client.callTool({
      name: 'elvanto_not_a_tool',
      arguments: {},
    })) as CallToolResult

    // A tool error rather than a protocol error, so the model can recover.
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('tools/list')
    // Nothing was sent to Elvanto.
    expect(requests).toHaveLength(0)
  })

  test('describeError passes an unrecognised error through', () => {
    expect(describeError(new Error('socket hang up'))).toBe('socket hang up')
    expect(describeError('plain string')).toBe('plain string')
  })
})

describe('response size limits', () => {
  const bigPage = (count: number) => ({
    status: 'ok',
    people: {
      page: 1,
      per_page: count,
      on_this_page: count,
      total: count,
      person: Array.from({ length: count }, (_, i) => ({
        id: `p${i}`,
        firstname: 'Name'.repeat(20),
        lastname: 'Surname'.repeat(20),
      })),
    },
  })

  test('truncates an oversized response and says how many were dropped', async () => {
    const { client } = await connect(() => bigPage(200), { maxResponseChars: 2000 })
    const result = (await client.callTool({
      name: 'elvanto_people_get_all',
      arguments: { page_size: 200 },
    })) as CallToolResult

    const payload = JSON.parse(textOf(result))
    expect(payload.items.length).toBeLessThan(200)
    expect(payload.truncated.dropped_records).toBeGreaterThan(0)
    expect(payload.truncated.advice).toContain('page_size')
    // The cap is a cap: the notice has to fit inside it too.
    expect(textOf(result).length).toBeLessThanOrEqual(2000)
  })

  test('honours the cap for a single oversized record, and stays parseable', async () => {
    // Slicing the serialised JSON would cut mid-string and hand the model text
    // that JSON.parse rejects — a service with plans, volunteers and songs, or a
    // song with lyrics and a chord chart, easily exceeds the default cap.
    const { client } = await connect(
      () => ({
        status: 'ok',
        song: [{ id: 's1', title: 'Adonai', lyrics: 'la '.repeat(4_000), artist: 'Mia' }],
      }),
      { maxResponseChars: MIN_MAX_RESPONSE_CHARS },
    )
    const result = (await client.callTool({
      name: 'elvanto_songs_get_info',
      arguments: { id: 's1' },
    })) as CallToolResult

    const text = textOf(result)
    expect(text.length).toBeLessThanOrEqual(MIN_MAX_RESPONSE_CHARS)
    const payload = JSON.parse(text) // must not throw
    // Biggest field dropped first, so the identifying ones survive.
    expect(payload.truncated.dropped_fields).toContain('lyrics')
    expect(payload.id).toBe('s1')
    expect(payload.title).toBe('Adonai')
  })

  test('never returns more than the cap, across payload shapes', () => {
    const cap = 1_500
    const shapes: unknown[] = [
      { items: Array.from({ length: 500 }, (_, i) => ({ id: `p${i}`, name: 'x'.repeat(50) })), total: 500, page: 1 },
      { items: [{ id: 'one', blob: 'y'.repeat(50_000) }], total: 1, page: 1 },
      { items: [], total: 0, page: 1 },
      { id: 'r1', huge: 'z'.repeat(40_000), small: 'ok' },
      'a plain string that is quite long '.repeat(200),
    ]
    for (const shape of shapes) {
      const text = fitToBudget(shape, cap)
      expect(text.length, JSON.stringify(shape).slice(0, 40)).toBeLessThanOrEqual(cap)
      expect(() => JSON.parse(text), 'must stay parseable').not.toThrow()
    }
  })

  test('refuses a cap too small to explain itself', () => {
    // Below the floor there is no room for the truncation notice, so the cap
    // could not be honoured and explained at the same time.
    const server = createServer({ maxResponseChars: 10 })
    expect(server).toBeDefined()
    expect(fitToBudget({ id: 'x' }, MIN_MAX_RESPONSE_CHARS).length).toBeLessThanOrEqual(
      MIN_MAX_RESPONSE_CHARS,
    )
  })

  test('leaves a response within the limit untouched', async () => {
    const { client } = await connect(() => bigPage(2), { maxResponseChars: 100_000 })
    const result = (await client.callTool({
      name: 'elvanto_people_get_all',
      arguments: {},
    })) as CallToolResult

    const payload = JSON.parse(textOf(result))
    expect(payload.truncated).toBeUndefined()
    expect(payload.items).toHaveLength(2)
  })
})

describe('configFromEnv', () => {
  test('reads the validation opt-out', () => {
    expect(configFromEnv({ ELVANTO_VALIDATE: 'warn' }).clientOptions?.validate).toBe('warn')
    expect(configFromEnv({ ELVANTO_VALIDATE: 'off' }).clientOptions?.validate).toBe('off')
  })

  test('defaults validation to the client default when unset', () => {
    expect(configFromEnv({}).clientOptions?.validate).toBeUndefined()
  })

  test('reads the page size and response cap', () => {
    const config = configFromEnv({
      ELVANTO_MCP_PAGE_SIZE: '50',
      ELVANTO_MCP_MAX_RESPONSE_CHARS: '5000',
    })
    expect(config.defaultPageSize).toBe(50)
    expect(config.maxResponseChars).toBe(5000)
  })

  test('ignores nonsense rather than failing to start', () => {
    const config = configFromEnv({ ELVANTO_MCP_PAGE_SIZE: 'lots' })
    expect(config.defaultPageSize).toBeUndefined()
  })

  test('rejects an invalid validation mode loudly, since it is a real mistake', () => {
    expect(() => configFromEnv({ ELVANTO_VALIDATE: 'maybe' })).toThrow()
  })

  test('applies the configured page size to tool descriptions', () => {
    const tools = buildTools(100)
    const peopleGetAll = tools.find((tool: Tool) => tool.name === 'elvanto_people_get_all')!
    expect(peopleGetAll.description).toContain('up to 100 records')
  })
})

describe('name derivation matches the SDK', () => {
  test('every tool name comes from the shared registry helper', () => {
    const tools = buildTools().map((tool: Tool) => tool.name)
    expect(tools).toEqual(readEndpointIds.map((id) => toMcpToolName(id)))
  })
})

describe('writes', () => {
  const personAck = { status: 'ok', person: { id: 'p-new', family_id: 1 } }

  test('are neither listed nor callable by default', async () => {
    const { client, requests } = await connect(() => personAck)

    const { tools } = await client.listTools()
    expect(tools.map((tool) => tool.name)).toEqual(
      readEndpointIds.map((id) => toMcpToolName(id)),
    )

    const result = await client.callTool({
      name: 'elvanto_people_create',
      arguments: { firstname: 'Ada', lastname: 'Lovelace' },
    })
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toMatch(/Unknown tool/)
    expect(requests).toHaveLength(0)
  })

  test('"write" adds the undoable ones and holds back the destructive ones', async () => {
    const { client } = await connect(() => personAck, { writes: 'write' })
    const names = (await client.listTools()).tools.map((tool) => tool.name)

    expect(names).toContain('elvanto_people_create')
    expect(names).toContain('elvanto_groups_add_person')
    expect(names).toContain('elvanto_people_flows_steps_add_person')
    expect(names).not.toContain('elvanto_people_remove')
    expect(names).not.toContain('elvanto_people_edit')
    expect(names).not.toContain('elvanto_groups_remove_person')

    const removed = await client.callTool({
      name: 'elvanto_people_remove',
      arguments: { id: 'p' },
    })
    expect(removed.isError).toBe(true)
  })

  test('"all" exposes every endpoint', async () => {
    const { client } = await connect(() => personAck, { writes: 'all' })
    const names = (await client.listTools()).tools.map((tool) => tool.name)
    expect(names).toEqual(endpointIds.map((id) => toMcpToolName(id)))
  })

  test('a write tool calls Elvanto and returns the acknowledgement', async () => {
    const { client, requests } = await connect(() => personAck, { writes: 'write' })

    const result = await client.callTool({
      name: 'elvanto_people_create',
      arguments: { firstname: 'Ada', lastname: 'Lovelace' },
    })

    expect(result.isError).toBeFalsy()
    expect(JSON.stringify(result.content)).toContain('p-new')
    expect(requests).toEqual([
      { path: 'people/create', body: { firstname: 'Ada', lastname: 'Lovelace' } },
    ])
  })

  test('hints tell the client which tools change or delete data', () => {
    const tools = new Map(buildTools(DEFAULT_PAGE_SIZE, 'all').map((tool) => [tool.name, tool]))

    expect(tools.get('elvanto_people_get_all')!.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
    })
    expect(tools.get('elvanto_people_create')!.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
    })
    expect(tools.get('elvanto_people_remove')!.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
    })
    expect(tools.get('elvanto_people_remove')!.description).toMatch(/cannot be\s+undone/)
  })

  test('an unknown outcome tells the model to check before retrying', async () => {
    const { client, requests } = await connect(
      () => {
        throw new Error('unreachable')
      },
      { writes: 'write', clientOptions: { maxRetries: 3 } },
    )

    const result = await client.callTool({
      name: 'elvanto_groups_add_person',
      arguments: { id: 'g', person_id: 'p' },
    })

    expect(result.isError).toBe(true)
    const text = JSON.stringify(result.content)
    expect(text).toMatch(/may or may not have been applied/)
    expect(text).toMatch(/read the record/)
    expect(requests).toHaveLength(1)
  })

  test('ELVANTO_MCP_WRITES is read, and a typo fails fast', () => {
    expect(configFromEnv({}).writes).toBe('off')
    expect(configFromEnv({ ELVANTO_MCP_WRITES: 'ALL' }).writes).toBe('all')
    expect(() => configFromEnv({ ELVANTO_MCP_WRITES: 'yes' })).toThrow(/ELVANTO_MCP_WRITES/)
  })
})
