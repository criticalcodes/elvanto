import type { ToolDefinition } from '@flue/runtime'
import { ElvantoClient } from '@criticalcodes/elvanto'
import * as v from 'valibot'

/**
 * Calling a tool without an agent session.
 *
 * Flue parses model arguments against the `input` schema before `run` sees them,
 * so these helpers parse too — otherwise the tests would exercise `run` with
 * inputs the runtime would have rejected, and the schemas would go unverified.
 *
 * Nothing here touches the network: the Elvanto client takes an injected `fetch`,
 * as the SDK, CLI and MCP tests all do.
 */

export interface RecordedRequest {
  path: string
  body: Record<string, unknown>
}

export interface Stub {
  client: ElvantoClient
  requests: RecordedRequest[]
}

/**
 * An Elvanto client answered locally.
 *
 * `validate: 'throw'` deliberately, against the agent's own `'warn'` default: a
 * fixture that no longer matches the schema should fail the test rather than
 * quietly degrade, which is the trade the README describes.
 */
export function stubClient(
  respond: (path: string, body: Record<string, unknown>) => unknown,
): Stub {
  const requests: RecordedRequest[] = []

  const client = new ElvantoClient({
    auth: { apiKey: 'test-key' },
    maxRetries: 0,
    minRequestIntervalMs: 0,
    validate: 'throw',
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
  })

  return { client, requests }
}

export interface ToolCall {
  output: unknown
  logs: string[]
}

/** Parses `args` with the tool's own schema, then runs it. */
export async function callTool(tool: ToolDefinition, args: unknown = {}): Promise<ToolCall> {
  const data = tool.input ? v.parse(tool.input, args) : args
  const logs: string[] = []

  // The real context carries a harness and a durable step surface that none of
  // these tools declare, so a full one cannot be built without a session. The
  // fields below are every field they actually read. Taken from `run`'s own
  // parameter rather than naming `ToolContext`, whose type arguments are an
  // implementation detail this harness has no reason to track.
  const context = {
    data,
    toolCallId: 'test-call',
    log: {
      info: (message: string) => logs.push(message),
      warn: (message: string) => logs.push(message),
      error: (message: string) => logs.push(message),
    },
  } as unknown as Parameters<ToolDefinition['run']>[0]

  const result = await tool.run(context)
  const output =
    result && typeof result === 'object' && 'output' in result ? result.output : result
  return { output, logs }
}

/** Asserts the input schema rejects `args`, which the runtime would do first. */
export function rejectsInput(tool: ToolDefinition, args: unknown): boolean {
  if (!tool.input) return false
  return !v.safeParse(tool.input, args).success
}

/** A fixed clock — every date-defaulting tool needs one to be testable. */
export const FIXED_NOW = new Date('2026-08-06T09:00:00Z')
export const fixedClock = () => FIXED_NOW

/** Wraps records in Elvanto's paginated envelope. */
export function page(
  collectionKey: string,
  itemKey: string,
  items: unknown[],
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    status: 'ok',
    [collectionKey]: {
      page: 1,
      per_page: 1000,
      on_this_page: items.length,
      total: items.length,
      [itemKey]: items,
      ...extra,
    },
  }
}
