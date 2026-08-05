import { ElvantoClient } from '../src/client.js'
import type { ElvantoClientOptions } from '../src/http.js'

export interface RecordedCall {
  url: string
  method: string
  headers: Record<string, string>
  body: unknown
}

export interface StubFetch {
  (
    input: Parameters<typeof globalThis.fetch>[0],
    init?: RequestInit,
  ): Promise<Response>
  calls: RecordedCall[]
}

/** A `fetch` stub that replays the given responses in order and records requests. */
export function stubFetch(
  responses: Array<
    | { status?: number; body: unknown; headers?: Record<string, string> }
    | Error
  >,
): StubFetch {
  const queue = [...responses]
  const calls: RecordedCall[] = []

  const impl = async (
    input: Parameters<typeof globalThis.fetch>[0],
    init?: RequestInit,
  ): Promise<Response> => {
    const headers: Record<string, string> = {}
    for (const [k, v] of Object.entries(
      (init?.headers ?? {}) as Record<string, string>,
    )) {
      headers[k.toLowerCase()] = v
    }
    calls.push({
      url: String(input),
      method: init?.method ?? 'GET',
      headers,
      body:
        typeof init?.body === 'string' && init.body.length > 0
          ? JSON.parse(init.body)
          : undefined,
    })

    const next = queue.length > 1 ? queue.shift()! : queue[0]
    if (next === undefined) {
      throw new Error('stubFetch: no response configured')
    }
    if (next instanceof Error) throw next
    return new Response(
      typeof next.body === 'string' ? next.body : JSON.stringify(next.body),
      {
        status: next.status ?? 200,
        headers: { 'content-type': 'application/json', ...next.headers },
      },
    )
  }

  return Object.assign(impl, { calls })
}

/** A client wired to a stub, with retries off unless a test asks for them. */
export function testClient(
  responses: Parameters<typeof stubFetch>[0],
  options: Partial<ElvantoClientOptions> = {},
): { client: ElvantoClient; fetch: StubFetch } {
  const fetchStub = stubFetch(responses)
  const client = new ElvantoClient({
    auth: { apiKey: 'test-key' },
    fetch: fetchStub,
    maxRetries: 0,
    ...options,
  })
  return { client, fetch: fetchStub }
}
