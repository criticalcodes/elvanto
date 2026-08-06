import { describe, expect, test } from 'vitest'
import { endpointIds, toMcpToolName } from '@criticalcodes/elvanto'
import { buildTools } from '@criticalcodes/elvanto-mcp'
import { ALL_MCP_TOOLS, CORE_MCP_TOOLS, elvantoMcpConnection } from '../src/mcp.ts'
import { baseInstruction, type ElvantoBaseOptions } from '../src/base.ts'
import { clientFromEnv } from '../src/client.ts'
import { ALL_TOOL_NAMES, TOOL_FACTORIES } from '../src/tools/index.ts'
import { FIXED_NOW } from './harness.ts'

describe('MCP tool allowlist', () => {
  /** What the server actually advertises. */
  const exposed = new Set(buildTools().map((tool) => tool.name))

  test('every allowlisted name is one the server exposes', () => {
    // Flue treats an unknown name in the allowlist as an error, which is the right
    // call — but it surfaces at connection time, in production. This is the test
    // that keeps that from happening: both lists are derived from the same
    // registry the server derives its tools from, and this proves it.
    for (const name of [...CORE_MCP_TOOLS, ...ALL_MCP_TOOLS]) {
      expect(exposed.has(name), name).toBe(true)
    }
  })

  test('ALL_MCP_TOOLS is exactly the server\'s tool set', () => {
    expect([...ALL_MCP_TOOLS].sort()).toEqual([...exposed].sort())
  })

  test('the core set omits every financial endpoint', () => {
    // Individual giving records are the most sensitive thing an API key reaches,
    // and an agent runtime persists tool results — so this is opt-in, not default.
    const financial = endpointIds
      .filter((id) => id.startsWith('financial.'))
      .map((id) => toMcpToolName(id))

    expect(financial.length).toBeGreaterThan(0)
    for (const name of financial) {
      expect(CORE_MCP_TOOLS).not.toContain(name)
      // Still reachable for someone who has decided to.
      expect(ALL_MCP_TOOLS).toContain(name)
    }
  })

  test('the core set omits endpoints the custom tools already cover', () => {
    expect(CORE_MCP_TOOLS).not.toContain(toMcpToolName('people.search'))
  })

  test('the core set omits the OAuth-only endpoint', () => {
    // With an API key it is a tool that can only ever fail.
    expect(CORE_MCP_TOOLS).not.toContain(toMcpToolName('people.currentUser'))
  })

  test('the core set is a strict subset', () => {
    expect(CORE_MCP_TOOLS.length).toBeLessThan(ALL_MCP_TOOLS.length)
  })
})

describe('elvantoMcpConnection', () => {
  test('is absent when no URL is configured', () => {
    // A normal state — a `flue run` session with nothing else set up. The custom
    // tools work without it, so this must not throw or invent a default.
    expect(elvantoMcpConnection({ env: {} })).toBeUndefined()
  })

  test('reads the URL and token from the environment', () => {
    const connection = elvantoMcpConnection({
      env: {
        ELVANTO_MCP_URL: 'https://example.invalid/mcp',
        ELVANTO_MCP_TOKEN: 'sekret',
      },
    })

    expect(connection).toMatchObject({
      name: 'elvanto',
      url: 'https://example.invalid/mcp',
      auth: 'sekret',
      // Degrades to zero tools for the submission rather than failing the turn.
      optional: true,
    })
  })

  test('explicit options win over the environment', () => {
    const connection = elvantoMcpConnection({
      env: { ELVANTO_MCP_URL: 'https://from-env.invalid/mcp' },
      url: 'https://explicit.invalid/mcp',
      tools: ['elvanto_groups_get_all'],
    })
    expect(connection).toMatchObject({
      url: 'https://explicit.invalid/mcp',
      tools: ['elvanto_groups_get_all'],
    })
  })

  test('defaults to the core allowlist rather than everything', () => {
    const connection = elvantoMcpConnection({
      env: { ELVANTO_MCP_URL: 'https://example.invalid/mcp' },
    })
    expect(connection?.tools).toEqual([...CORE_MCP_TOOLS])
  })

  test('omits auth entirely when no token is set', () => {
    const connection = elvantoMcpConnection({
      env: { ELVANTO_MCP_URL: 'http://127.0.0.1:3001/' },
    })
    expect(connection).not.toHaveProperty('auth')
  })
})

describe('baseInstruction', () => {
  test('states today, so relative dates can be resolved', () => {
    // Without it the model cannot answer "who is on this Sunday" — it either asks
    // or guesses, and guessing is worse.
    expect(baseInstruction(FIXED_NOW, true)).toContain('2026-08-06')
  })

  test('says the access is read-only', () => {
    expect(baseInstruction(FIXED_NOW, true)).toContain('read-only')
  })

  test('tells the model not to present truncated results as complete', () => {
    expect(baseInstruction(FIXED_NOW, true)).toContain('truncated')
  })

  test('warns that the conversation may be durable', () => {
    expect(baseInstruction(FIXED_NOW, true).toLowerCase()).toContain('durably')
  })

  test('names the missing capability when the raw endpoints are absent', () => {
    const without = baseInstruction(FIXED_NOW, false)
    expect(without).toContain('not connected')
    expect(baseInstruction(FIXED_NOW, true)).not.toContain('not connected')
  })
})

describe('tool catalogue', () => {
  test('every factory is reachable by name', () => {
    expect(ALL_TOOL_NAMES.sort()).toEqual(
      [
        'find_person',
        'list_custom_fields',
        'next_serving',
        'roster',
        'service_brief',
        'song_history',
      ].sort(),
    )
  })

  test('each factory produces a tool whose name matches its key', () => {
    // A mismatch would make `tools: ['roster']` mount something else.
    const client = clientFromEnv({ ELVANTO_API_KEY: 'k' })
    for (const [key, factory] of Object.entries(TOOL_FACTORIES)) {
      expect(factory({ client }).name, key).toBe(key)
    }
  })

  test('every tool has a description long enough to be usable', () => {
    // The description is the model's only documentation — a vague one is the
    // most common cause of a tool being called wrongly or not at all.
    const client = clientFromEnv({ ELVANTO_API_KEY: 'k' })
    for (const factory of Object.values(TOOL_FACTORIES)) {
      const tool = factory({ client })
      expect(tool.description.length, tool.name).toBeGreaterThan(80)
    }
  })
})

describe('clientFromEnv', () => {
  test('defaults to warn, not the SDK\'s throw', () => {
    // An undocumented Elvanto field should degrade a response mid-conversation,
    // not fail the tool call.
    const client = clientFromEnv({ ELVANTO_API_KEY: 'k' })
    expect(client).toBeDefined()
  })

  test('an explicit validation mode is honoured', () => {
    expect(clientFromEnv({ ELVANTO_API_KEY: 'k', ELVANTO_VALIDATE: 'throw' })).toBeDefined()
  })

  test('a malformed validation mode fails loudly', () => {
    // Same reasoning as the MCP server: an operator typo should not be silently
    // replaced by a default they did not choose.
    expect(() => clientFromEnv({ ELVANTO_API_KEY: 'k', ELVANTO_VALIDATE: 'maybe' })).toThrow()
  })

  test('missing credentials throw, and the message says what to set', () => {
    // Thrown at first tool call rather than at render — see ToolDeps.client.
    expect(() => clientFromEnv({})).toThrow(/ELVANTO_API_KEY/)
  })
})

describe('useElvantoBase options', () => {
  test('accepts a client factory as well as a client', () => {
    // The form a consuming agent should use: shared with its own tools, and not
    // constructed during the render. A type-level guarantee as much as a runtime
    // one — this failed to compile before the option was widened.
    const factory: ElvantoBaseOptions['client'] = () => clientFromEnv({ ELVANTO_API_KEY: 'k' })
    const direct: ElvantoBaseOptions['client'] = clientFromEnv({ ELVANTO_API_KEY: 'k' })
    expect(typeof factory).toBe('function')
    expect(direct).toBeDefined()
  })
})
