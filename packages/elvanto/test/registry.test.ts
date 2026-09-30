import { describe, expect, test } from 'vitest'
import { z } from 'zod'
import { ElvantoClient } from '../src/client.js'
import {
  endpointIds,
  endpoints,
  getEndpoint,
  readEndpointIds,
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

  test('an endpoint reads exactly when its name says it reads', () => {
    // The effect decides what a model is allowed to call, so a write mislabelled
    // as a read would slip past every opt-in. The action name is the independent
    // check: Elvanto's read verbs are a small closed set.
    const readVerbs = ['getAll', 'getInfo', 'search', 'currentUser', 'people']
    const all: EndpointDefinition[] = Object.values(endpoints)
    for (const endpoint of all) {
      const action = endpoint.id.split('.').pop()!
      expect(endpoint.effect === 'read', endpoint.id).toBe(readVerbs.includes(action))
    }
  })

  test('records exactly which endpoints are destructive', () => {
    // Pinned: moving an endpoint out of this list lets a model reach it under
    // ELVANTO_MCP_WRITES=write, so that has to be a decision, not a side effect.
    const all: EndpointDefinition[] = Object.values(endpoints)
    const destructive = all.filter((e) => e.effect === 'destructive').map((e) => e.id).sort()
    expect(destructive).toEqual([
      'groups.remove',
      'groups.removePerson',
      // A blank family_id detaches the person from their family.
      'people.edit',
      'people.remove',
    ])
  })

  test('readEndpointIds holds the reads and nothing else', () => {
    expect(readEndpointIds.length).toBe(25)
    for (const id of readEndpointIds) expect(getEndpoint(id).effect, id).toBe('read')
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

  test('every endpoint declares how far it has been verified', () => {
    const all: EndpointDefinition[] = Object.values(endpoints)
    for (const endpoint of all) {
      expect(['docs', 'live'], endpoint.id).toContain(endpoint.verified)
    }
  })

  test('records exactly which endpoints have met real data', () => {
    // Pinned deliberately. This is the honest record of what a live sweep has
    // actually exercised, and it should only ever move in one direction — so a
    // change here needs a real sweep behind it, not a hopeful edit.
    const all: EndpointDefinition[] = Object.values(endpoints)
    const docsOnly = all.filter((e) => e.verified === 'docs').map((e) => e.id).sort()

    expect(docsOnly).toEqual([
      // No chart of accounts or transactions in the account swept.
      'financial.categories.getAll',
      'financial.transactions.getAll',
      'financial.transactions.getInfo',
      // Requires OAuth, which has not been exercised live either.
      'people.currentUser',
      // Not exercised live: adding a throwaway person to a real step could
      // notify the step's admins.
      'peopleFlows.steps.addPerson',
      // The endpoint answered, but no member records existed to shape-check.
      'peopleFlows.steps.people',
      // No songs in the account swept, so nothing downstream could be reached.
      'songs.arrangements.getAll',
      'songs.arrangements.getInfo',
      'songs.getAll',
      'songs.getInfo',
      'songs.keys.getAll',
      'songs.keys.getInfo',
    ])
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
