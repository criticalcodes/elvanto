import { describe, expect, test } from 'vitest'
import * as v from 'valibot'
import { toJsonSchema } from '@valibot/to-json-schema'
import { describeParams, endpointIds, getEndpoint, readEndpointIds, toMcpToolName } from '@criticalcodes/elvanto'
import { buildTools } from '@criticalcodes/elvanto-mcp'
import {
  ALL_ENDPOINTS,
  CORE_ENDPOINTS,
  endpointTool,
  endpointTools,
  inputSchemaFor,
  resolveEndpoints,
} from '../src/tools/endpoints.ts'
import { callTool, page, stubClient } from './harness.ts'

describe('generated endpoint tools', () => {
  test('one tool per endpoint, named exactly as the MCP surface names it', () => {
    // The names have to match: an instruction, an allowlist or a transcript should
    // read the same whether the endpoints arrived natively or over MCP.
    const native = endpointTools({ client: stubClient(() => ({})).client }, 'all')
    const mcp = buildTools().map((tool) => tool.name)

    expect(native.length).toBe(readEndpointIds.length)
    expect(native.map((tool) => tool.name).sort()).toEqual([...mcp].sort())
  })

  test('descriptions match the MCP surface too', () => {
    // Both come from the SDK's endpointToolDescription, so this pins the shared
    // source of truth rather than two copies that happen to agree today.
    const native = endpointTools({ client: stubClient(() => ({})).client }, 'all')
    const byName = new Map(buildTools().map((tool) => [tool.name, tool.description]))

    for (const tool of native) {
      expect(tool.description, tool.name).toBe(byName.get(tool.name))
    }
  })

  test('every generated schema converts to JSON Schema for the model', () => {
    // Flue presents the input schema to the model as JSON Schema. A schema that
    // cannot convert would leave the model with no parameter documentation at all.
    for (const id of endpointIds) {
      const schema = inputSchemaFor(getEndpoint(id))
      expect(() => toJsonSchema(schema, { errorMode: 'ignore' }), id).not.toThrow()
    }
  })

  test('every registry parameter reaches the model, with its description', () => {
    for (const id of endpointIds) {
      const endpoint = getEndpoint(id)
      const json = toJsonSchema(inputSchemaFor(endpoint), { errorMode: 'ignore' }) as {
        properties?: Record<string, { description?: string }>
      }

      for (const param of describeParams(endpoint)) {
        expect(json.properties?.[param.name], `${id}.${param.name}`).toBeDefined()
        if (param.description) {
          expect(json.properties?.[param.name]?.description, `${id}.${param.name}`).toBe(
            param.description,
          )
        }
      }
    }
  })

  test('required parameters are required, optional ones are not', () => {
    // `people.getInfo` needs an id; `people.getAll` needs nothing.
    const withId = inputSchemaFor(getEndpoint('people.getInfo'))
    expect(v.safeParse(withId, {}).success).toBe(false)
    expect(v.safeParse(withId, { id: 'p1' }).success).toBe(true)

    const noneRequired = inputSchemaFor(getEndpoint('people.getAll'))
    expect(v.safeParse(noneRequired, {}).success).toBe(true)
  })

  test('parameter kinds survive the round trip', () => {
    const services = inputSchemaFor(getEndpoint('services.getAll'))
    // enum
    expect(v.safeParse(services, { status: 'published' }).success).toBe(true)
    expect(v.safeParse(services, { status: 'nonsense' }).success).toBe(false)
    // yes/no enum
    expect(v.safeParse(services, { all: 'yes' }).success).toBe(true)
    expect(v.safeParse(services, { all: true }).success).toBe(false)
    // string array
    expect(v.safeParse(services, { fields: ['songs'] }).success).toBe(true)
    expect(v.safeParse(services, { fields: 'songs' }).success).toBe(false)
    // integer
    expect(v.safeParse(services, { page_size: 25 }).success).toBe(true)
    expect(v.safeParse(services, { page_size: 25.5 }).success).toBe(false)
    // string-or-array
    expect(v.safeParse(services, { service_types: 'st1' }).success).toBe(true)
    expect(v.safeParse(services, { service_types: ['st1', 'st2'] }).success).toBe(true)
  })

  test('the record-valued search parameter accepts a field-to-keyword map', () => {
    const search = inputSchemaFor(getEndpoint('people.search'))
    expect(v.safeParse(search, { search: { lastname: 'Smith' } }).success).toBe(true)
    expect(v.safeParse(search, { search: { volunteer: true, page: 2 } }).success).toBe(true)
    expect(v.safeParse(search, { search: 'Smith' }).success).toBe(false)
  })

  test('a call reaches the right endpoint and returns a model payload', async () => {
    const stub = stubClient(() => page('people', 'person', [{ id: 'p1', firstname: 'Ada' }]))
    const tool = endpointTool({ client: stub.client }, 'people.getAll')

    const { output } = await callTool(tool, {})
    expect(stub.requests[0]!.path).toBe('people/getAll')

    // Serialised, and in Elvanto's own snake_case vocabulary — the same shape the
    // MCP server returns.
    const parsed = JSON.parse(output as string)
    expect(parsed).toMatchObject({ total: 1, per_page: expect.anything(), has_more: false })
    expect(parsed.items[0]).toMatchObject({ firstname: 'Ada' })
  })

  test('applies the 25-record page default, not Elvanto\'s 1000', async () => {
    const stub = stubClient(() => page('people', 'person', []))
    await callTool(endpointTool({ client: stub.client }, 'people.getAll'), {})
    expect(stub.requests[0]!.body['page_size']).toBe(25)
  })

  test('an explicit page size wins', async () => {
    const stub = stubClient(() => page('people', 'person', []))
    await callTool(endpointTool({ client: stub.client }, 'people.getAll'), { page_size: 100 })
    expect(stub.requests[0]!.body['page_size']).toBe(100)
  })

  test('a non-paginated endpoint gets no page size', async () => {
    const stub = stubClient(() => ({
      status: 'ok',
      person: [{ id: 'p1', firstname: 'Ada' }],
    }))
    await callTool(endpointTool({ client: stub.client }, 'people.getInfo'), { id: 'p1' })
    expect(stub.requests[0]!.body).not.toHaveProperty('page_size')
  })

  test('a huge response is truncated, and says so', async () => {
    // The cap matters more here than on the MCP server: there is no separate
    // process between a 1000-record page and the model's context.
    const many = Array.from({ length: 400 }, (_, index) => ({
      id: `p${index}`,
      firstname: 'Ada',
      lastname: 'Lovelace',
      email: `ada${index}@example.invalid`,
      mailing_address: 'x'.repeat(400),
    }))
    const stub = stubClient(() => page('people', 'person', many))

    const { output } = await callTool(
      endpointTool({ client: stub.client }, 'people.getAll', { maxResponseChars: 4000 }),
      { page_size: 1000 },
    )

    const text = output as string
    expect(text.length).toBeLessThanOrEqual(4000)
    const parsed = JSON.parse(text)
    expect(parsed.truncated.dropped_records).toBeGreaterThan(0)
    expect(parsed.truncated.advice).toContain('page_size')
  })

  test('a failing call surfaces as an error the model can read', async () => {
    const stub = stubClient(() => ({
      status: 'fail',
      error: { code: 256, message: 'Invalid API key' },
    }))
    await expect(
      callTool(endpointTool({ client: stub.client }, 'people.getAll'), {}),
    ).rejects.toThrow(/Invalid API key/)
  })

  test('logs the tool name only, never parameter values', async () => {
    const stub = stubClient(() => page('people', 'person', []))
    const { logs } = await callTool(endpointTool({ client: stub.client }, 'people.search'), {
      search: { lastname: 'Lovelace' },
    })
    expect(logs.join('\n')).not.toContain('Lovelace')
  })
})

describe('endpoint selection', () => {
  test('core omits every financial endpoint, all includes them', () => {
    const financial = endpointIds.filter((id) => id.startsWith('financial.'))
    expect(financial.length).toBeGreaterThan(0)

    for (const id of financial) {
      expect(CORE_ENDPOINTS).not.toContain(id)
      expect(ALL_ENDPOINTS).toContain(id)
    }
  })

  test('core omits what the purpose-built tools already cover', () => {
    expect(CORE_ENDPOINTS).not.toContain('people.search')
    // And the OAuth-only endpoint, which can only fail with an API key.
    expect(CORE_ENDPOINTS).not.toContain('people.currentUser')
  })

  test('false mounts nothing', () => {
    expect(resolveEndpoints(false)).toEqual([])
    expect(endpointTools({ client: stubClient(() => ({})).client }, false)).toEqual([])
  })

  test('an explicit list is honoured verbatim', () => {
    const tools = endpointTools({ client: stubClient(() => ({})).client }, ['groups.getAll'])
    expect(tools.map((tool) => tool.name)).toEqual([toMcpToolName('groups.getAll')])
  })

  test('no generated name collides with a purpose-built tool', async () => {
    // Two tools with the same name is a hard error when Flue assembles the set.
    const { ALL_TOOL_NAMES } = await import('../src/tools/index.ts')
    const generated = new Set(ALL_ENDPOINTS.map((id) => toMcpToolName(id)))
    for (const name of ALL_TOOL_NAMES) {
      expect(generated.has(name), name).toBe(false)
    }
  })
})
