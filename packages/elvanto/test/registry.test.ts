import { describe, expect, test } from 'vitest'
import { z } from 'zod'
import { ElvantoClient } from '../src/client.js'
import {
  endpointIds,
  endpoints,
  getEndpoint,
  type EndpointDefinition,
} from '../src/registry.js'
import { toCliPath, toKebabCase, toMcpToolName, toSnakeCase } from '../src/naming.js'
import { testClient } from './helpers.js'

describe('naming derivation', () => {
  test('produces kebab-case for the CLI', () => {
    expect(toKebabCase('getAll')).toBe('get-all')
    expect(toKebabCase('peopleFlows')).toBe('people-flows')
    expect(toKebabCase('customFields')).toBe('custom-fields')
    expect(toKebabCase('people')).toBe('people')
  })

  test('produces snake_case for MCP', () => {
    expect(toSnakeCase('getAll')).toBe('get_all')
    expect(toSnakeCase('peopleFlows')).toBe('people_flows')
    expect(toSnakeCase('customFields')).toBe('custom_fields')
  })

  test('never mixes conventions inside one name', () => {
    for (const id of endpointIds) {
      const tool = toMcpToolName(id)
      expect(tool, `${id} -> ${tool}`).toMatch(/^[a-z][a-z0-9_]*$/)
      expect(tool).not.toMatch(/[A-Z-]/)

      const cli = toCliPath(id).join(' ')
      expect(cli, `${id} -> ${cli}`).toMatch(/^[a-z][a-z0-9 -]*$/)
      expect(cli).not.toMatch(/[A-Z_]/)
    }
  })

  test('derives the documented example names', () => {
    expect(toMcpToolName('peopleFlows.steps.getAll')).toBe(
      'elvanto_people_flows_steps_get_all',
    )
    expect(toCliPath('songs.arrangements.getInfo')).toEqual([
      'songs',
      'arrangements',
      'get-info',
    ])
  })

  test('keeps tool names unique and within the 64-character MCP limit', () => {
    const names = endpointIds.map((id) => toMcpToolName(id))
    expect(new Set(names).size).toBe(names.length)
    for (const name of names) {
      expect(name.length, name).toBeLessThanOrEqual(64)
    }
  })
})

describe('registry integrity', () => {
  test('every id matches its own key and its API path', () => {
    for (const [key, endpoint] of Object.entries(endpoints)) {
      expect(endpoint.id).toBe(key)
      expect(endpoint.path).toBe(key.split('.').join('/'))
    }
  })

  test('every endpoint is read-only', () => {
    for (const endpoint of Object.values(endpoints)) {
      const action = endpoint.id.split('.').pop()!
      expect(
        ['getAll', 'getInfo', 'search', 'currentUser', 'people'],
        `${endpoint.id} looks like a mutation`,
      ).toContain(action)
    }
  })

  test('every endpoint documents itself', () => {
    for (const endpoint of Object.values(endpoints)) {
      expect(endpoint.summary.length, endpoint.id).toBeGreaterThan(0)
      expect(endpoint.docs, endpoint.id).toMatch(/^https:\/\/www\.elvanto\.com\/api\//)
    }
  })

  test('every parameter carries a description, since they become tool schemas', () => {
    for (const endpoint of Object.values(endpoints)) {
      for (const [name, schema] of Object.entries(endpoint.params.shape)) {
        const description = (schema as z.ZodType).description ?? unwrapDescription(schema as z.ZodType)
        expect(description, `${endpoint.id}.${name}`).toBeTruthy()
      }
    }
  })

  test('every parameter schema converts to JSON Schema for MCP', () => {
    for (const endpoint of Object.values(endpoints)) {
      expect(() =>
        z.toJSONSchema(endpoint.params, { io: 'input' }),
      ).not.toThrow()
    }
  })

  test('getEndpoint lists the valid ids when given a bad one', () => {
    expect(() => getEndpoint('people.nope')).toThrowError(/Known ids/)
  })

  test('every endpoint shape is confirmed against the documentation', () => {
    // The `unverified` flag stays in the model for endpoints added from
    // incomplete docs, but every endpoint currently registered has had its
    // parameters and response shape checked against Elvanto's published example.
    const all: EndpointDefinition[] = Object.values(endpoints)
    expect(all.filter((e) => e.unverified).map((e) => e.id)).toEqual([])
  })
})

describe('client covers the registry', () => {
  test('every endpoint is reachable as a namespaced method', () => {
    const { client } = testClient([{ body: { status: 'ok' } }])
    for (const id of endpointIds) {
      const method = id.split('.').reduce<unknown>(
        (node, segment) => (node as Record<string, unknown>)?.[segment],
        client,
      )
      expect(typeof method, `client.${id} is missing`).toBe('function')
    }
  })

  test('the namespaced method hits the same path as the registry', async () => {
    const { client, fetch } = testClient([
      { body: { status: 'ok', keys: { key: [{ id: 'k' }] } } },
    ])
    await client.songs.keys.getAll({ arrangement_id: 'a' })
    expect(fetch.calls[0]!.url).toContain('/songs/keys/getAll.json')
  })

  test('call() and the namespaced method are equivalent', async () => {
    const body = { status: 'ok', calendars: { calendar: [{ id: 'c', name: 'Main' }] } }
    const viaNamespace = await testClient([{ body }]).client.calendar.getAll()
    const viaCall = await testClient([{ body }]).client.call('calendar.getAll')
    expect(viaNamespace).toEqual(viaCall)
  })
})

/** Descriptions can sit on the inner schema when wrapped by `.optional()`. */
function unwrapDescription(schema: z.ZodType): string | undefined {
  let current: unknown = schema
  for (let i = 0; i < 5; i++) {
    const def = (current as { _zod?: { def?: { innerType?: unknown } } })._zod?.def
    const inner = def?.innerType
    if (!inner) break
    const description = (inner as z.ZodType).description
    if (description) return description
    current = inner
  }
  return undefined
}
