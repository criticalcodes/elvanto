import { describe, expect, test, vi } from 'vitest'
import { ElvantoClient } from '../src/client.js'
import {
  ElvantoApiError,
  ElvantoError,
  ElvantoRequestValidationError,
  ElvantoTransportError,
} from '../src/errors.js'
import {
  backoffMs,
  MAX_BACKOFF_MS,
  parseValidationMode,
  resolveAuth,
} from '../src/http.js'
import * as fixtures from './fixtures.js'
import { stubFetch, testClient } from './helpers.js'

describe('authentication', () => {
  test('sends an API key as HTTP basic with a dummy password', async () => {
    const { client, fetch } = testClient([{ body: fixtures.peopleGetAll }])
    await client.people.getAll()

    const auth = fetch.calls[0]!.headers['authorization']!
    expect(auth.startsWith('Basic ')).toBe(true)
    expect(Buffer.from(auth.slice(6), 'base64').toString()).toBe('test-key:x')
  })

  test('sends an OAuth access token as a bearer token', async () => {
    const { client, fetch } = testClient([{ body: fixtures.peopleGetAll }], {
      auth: { accessToken: 'tok_123' },
    })
    await client.people.getAll()
    expect(fetch.calls[0]!.headers['authorization']).toBe('Bearer tok_123')
  })

  test('calls getAccessToken before every request, so tokens can be refreshed', async () => {
    const getAccessToken = vi
      .fn<() => string>()
      .mockReturnValueOnce('first')
      .mockReturnValueOnce('second')
    const { client, fetch } = testClient(
      [{ body: fixtures.peopleGetAll }],
      { auth: { getAccessToken } },
    )

    await client.people.getAll()
    await client.people.getAll()

    expect(getAccessToken).toHaveBeenCalledTimes(2)
    expect(fetch.calls[0]!.headers['authorization']).toBe('Bearer first')
    expect(fetch.calls[1]!.headers['authorization']).toBe('Bearer second')
  })

  test('falls back to environment variables, preferring the API key', () => {
    expect(resolveAuth(undefined, { ELVANTO_API_KEY: 'k' })).toEqual({ apiKey: 'k' })
    expect(resolveAuth(undefined, { ELVANTO_ACCESS_TOKEN: 't' })).toEqual({
      accessToken: 't',
    })
    expect(
      resolveAuth(undefined, { ELVANTO_API_KEY: 'k', ELVANTO_ACCESS_TOKEN: 't' }),
    ).toEqual({ apiKey: 'k' })
  })

  test('explains how to authenticate when no credentials exist', () => {
    expect(() => resolveAuth(undefined, {})).toThrowError(/ELVANTO_API_KEY/)
  })

  test('rejects empty credentials rather than sending a blank header', () => {
    expect(() => resolveAuth({ apiKey: '' })).toThrowError(/Empty credentials/)
    expect(() => resolveAuth({ accessToken: '' })).toThrowError(/Empty credentials/)
  })

  test('ignores a blank environment variable', () => {
    expect(() => resolveAuth(undefined, { ELVANTO_API_KEY: '   ' })).toThrowError(
      /No Elvanto credentials/,
    )
  })

  test('reports a token provider that returns nothing', async () => {
    const { client } = testClient([{ body: fixtures.peopleGetAll }], {
      auth: { getAccessToken: () => '' },
    })
    await expect(client.people.getAll()).rejects.toThrowError(
      /getAccessToken\(\) returned an empty token/,
    )
  })

  test('reports a missing fetch implementation', () => {
    expect(
      () =>
        new ElvantoClient({
          auth: { apiKey: 'k' },
          fetch: undefined as unknown as typeof globalThis.fetch,
          // Force the check even where a global fetch exists.
          ...({ } as Record<string, never>),
        }),
    ).not.toThrow()
    expect(
      () =>
        new ElvantoClient({
          auth: { apiKey: 'k' },
          fetch: 'not a function' as unknown as typeof globalThis.fetch,
        }),
    ).toThrowError(/No fetch implementation/)
  })

  test('refuses an OAuth-only endpoint when using an API key, without a round trip', async () => {
    const { client, fetch } = testClient([{ body: fixtures.peopleGetInfo }])
    await expect(client.people.currentUser()).rejects.toThrowError(
      /requires OAuth/,
    )
    expect(fetch.calls).toHaveLength(0)
  })

  test('allows the OAuth-only endpoint with a bearer token', async () => {
    const { client } = testClient([{ body: fixtures.peopleGetInfo }], {
      auth: { accessToken: 'tok' },
    })
    await expect(client.people.currentUser()).resolves.toMatchObject({
      firstname: 'John',
    })
  })
})

describe('request shape', () => {
  test('POSTs JSON to the documented URL', async () => {
    const { client, fetch } = testClient([{ body: fixtures.peopleGetAll }])
    await client.people.getAll({ page: 2, page_size: 100 })

    const call = fetch.calls[0]!
    expect(call.url).toBe('https://api.elvanto.com/v1/people/getAll.json')
    expect(call.method).toBe('POST')
    expect(call.headers['content-type']).toBe('application/json')
    expect(call.body).toEqual({ page: 2, page_size: 100 })
  })

  test('omits unset parameters rather than sending nulls', async () => {
    const { client, fetch } = testClient([{ body: fixtures.peopleGetAll }])
    await client.people.getAll({ page: 1 })
    expect(fetch.calls[0]!.body).toEqual({ page: 1 })
  })

  test('identifies itself with a User-Agent', async () => {
    const { client, fetch } = testClient([{ body: fixtures.peopleGetAll }], {
      userAgent: 'my-app/2.0',
    })
    await client.people.getAll()
    expect(fetch.calls[0]!.headers['user-agent']).toContain('elvanto-js/')
    expect(fetch.calls[0]!.headers['user-agent']).toContain('my-app/2.0')
  })

  test('honours a custom base URL', async () => {
    const { client, fetch } = testClient([{ body: fixtures.calendarGetAll }], {
      baseUrl: 'https://stub.local/v1/',
    })
    await client.calendar.getAll()
    expect(fetch.calls[0]!.url).toBe('https://stub.local/v1/calendar/getAll.json')
  })
})

describe('parameter validation', () => {
  test('rejects a bad page size before sending anything', async () => {
    const { client, fetch } = testClient([{ body: fixtures.peopleGetAll }])
    await expect(client.people.getAll({ page_size: 5000 })).rejects.toBeInstanceOf(
      ElvantoRequestValidationError,
    )
    expect(fetch.calls).toHaveLength(0)
  })

  test('rejects a malformed date parameter', async () => {
    const { client } = testClient([{ body: fixtures.peopleGetAll }])
    await expect(
      client.calendar.events.getAll({ start: '30/12/2026', end: '2026-12-31' }),
    ).rejects.toThrowError(/YYYY-MM-DD/)
  })

  test('names the offending parameter in the error', async () => {
    const { client } = testClient([{ body: fixtures.peopleGetAll }])
    await expect(
      client.songs.arrangements.getAll({ song_id: '' }),
    ).rejects.toThrowError(/song_id/)
  })
})

describe('error mapping', () => {
  test('maps an HTTP 401 to an auth error', async () => {
    const { client } = testClient([
      { status: 401, body: { status: 'fail', error: { code: 401, message: 'Unauthorised' } } },
    ])
    const error = await client.people.getAll().catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ElvantoApiError)
    expect((error as ElvantoApiError).isAuthError).toBe(true)
    expect((error as ElvantoApiError).endpoint).toBe('people/getAll')
  })

  test('treats status:"fail" on an HTTP 200 as an error', async () => {
    const { client } = testClient([{ status: 200, body: fixtures.failEnvelope }])
    const error = await client.people.getAll().catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ElvantoApiError)
    expect((error as ElvantoApiError).code).toBe(250)
    expect((error as ElvantoApiError).message).toContain('Invalid page size')
  })

  test('promotes an HTTP-like body code so isNotFound works on a 200', async () => {
    const { client } = testClient([{ status: 200, body: fixtures.notFoundEnvelope }])
    const error = await client.people.getAll().catch((e: unknown) => e)
    expect((error as ElvantoApiError).isNotFound).toBe(true)
    expect((error as ElvantoApiError).httpStatus).toBe(404)
  })

  test('reports a non-JSON body rather than crashing on the parse', async () => {
    const { client } = testClient([
      { status: 200, body: '<html>Maintenance</html>', headers: { 'content-type': 'text/html' } },
    ])
    await expect(client.people.getAll()).rejects.toThrowError(/expected JSON/)
  })

  test('describes an empty body rather than saying "undefined"', async () => {
    const { client } = testClient([{ status: 200, body: '' }])
    await expect(client.people.getAll()).rejects.toThrowError(/an empty response/)
  })

  test('includes the offending body snippet, truncated', async () => {
    const { client } = testClient([
      { status: 200, body: 'x'.repeat(5_000), headers: { 'content-type': 'text/plain' } },
    ])
    const error = await client.people.getAll().catch((e: unknown) => e)
    // Enough to identify the problem, not so much that it floods a terminal.
    expect((error as Error).message.length).toBeLessThan(400)
  })

  test('wraps a network failure as a transport error', async () => {
    const { client } = testClient([new TypeError('fetch failed')])
    const error = await client.people.getAll().catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ElvantoTransportError)
    expect((error as ElvantoTransportError).message).toContain('fetch failed')
  })

  test('surfaces a timeout as a transport error naming the limit', async () => {
    const client = new ElvantoClient({
      auth: { apiKey: 'k' },
      maxRetries: 0,
      timeoutMs: 10,
      fetch: (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const error = new Error('aborted')
            error.name = 'TimeoutError'
            reject(error)
          })
        }),
    })
    await expect(client.people.getAll()).rejects.toThrowError(/timed out after 10ms/)
  })
})

describe('retries', () => {
  test('retries a 500 and returns the eventual success', async () => {
    const fetchStub = stubFetch([
      { status: 500, body: { status: 'fail', error: { message: 'boom' } }, headers: { 'retry-after': '0' } },
      { body: fixtures.peopleGetAll },
    ])
    const client = new ElvantoClient({
      auth: { apiKey: 'k' },
      fetch: fetchStub,
      maxRetries: 2,
    })

    const result = await client.people.getAll()
    expect(result.total).toBe(5)
    expect(fetchStub.calls).toHaveLength(2)
  })

  test('retries a 429 honouring Retry-After', async () => {
    const fetchStub = stubFetch([
      { status: 429, body: { status: 'fail' }, headers: { 'retry-after': '0' } },
      { body: fixtures.peopleGetAll },
    ])
    const client = new ElvantoClient({
      auth: { apiKey: 'k' },
      fetch: fetchStub,
      maxRetries: 1,
    })
    await expect(client.people.getAll()).resolves.toMatchObject({ total: 5 })
    expect(fetchStub.calls).toHaveLength(2)
  })

  /**
   * These measure the actual delay. Asserting only that a retry happened would
   * pass even with the whole Retry-After block deleted, since the exponential
   * fallback also retries — the wait is the behaviour worth pinning, because
   * getting it wrong either hammers Elvanto or hangs the caller.
   */
  describe('backoff timing', () => {
    /** Waits for a retry, reporting how long the client delayed before it. */
    async function measureRetry(
      headers: Record<string, string>,
      maxRetries = 1,
    ): Promise<{ waits: number[]; calls: number }> {
      const timestamps: number[] = []
      let served = 0
      const client = new ElvantoClient({
        auth: { apiKey: 'k' },
        maxRetries,
        fetch: async () => {
          timestamps.push(Date.now())
          served++
          // Fail every attempt but the last, so each gap is a measured backoff.
          if (served <= maxRetries) {
            return new Response(JSON.stringify({ status: 'fail' }), {
              status: 503,
              headers: { 'content-type': 'application/json', ...headers },
            })
          }
          return new Response(JSON.stringify(fixtures.peopleGetAll), {
            headers: { 'content-type': 'application/json' },
          })
        },
      })

      await client.people.getAll()
      const waits = timestamps
        .slice(1)
        .map((time, index) => time - timestamps[index]!)
      return { waits, calls: timestamps.length }
    }

    test('waits the number of seconds Retry-After specifies', async () => {
      const { waits } = await measureRetry({ 'retry-after': '1' })
      expect(waits[0]).toBeGreaterThanOrEqual(950)
      expect(waits[0]).toBeLessThan(1_500)
    })

    // The HTTP-date form is pinned precisely in the `backoffMs` unit tests
    // below. Measuring it end-to-end is inherently imprecise, because
    // `toUTCString()` truncates to whole seconds.

    test('falls back to exponential backoff when Retry-After is absent', async () => {
      const { waits } = await measureRetry({}, 2)
      // 500ms then 1000ms, each plus up to 250ms of jitter.
      expect(waits[0]).toBeGreaterThanOrEqual(450)
      expect(waits[0]).toBeLessThan(800)
      expect(waits[1]).toBeGreaterThanOrEqual(950)
      expect(waits[1]).toBeLessThan(1_300)
    }, 15_000)

    test('ignores a garbage Retry-After and backs off instead', async () => {
      const { waits } = await measureRetry({ 'retry-after': 'soon' })
      expect(waits[0]).toBeGreaterThanOrEqual(450)
      expect(waits[0]).toBeLessThan(800)
    })
  })

  /**
   * The calculation itself, unit-tested. The clamp in particular cannot be proven
   * through the transport without actually waiting out the delay, which is the
   * failure it exists to prevent.
   */
  describe('backoffMs', () => {
    const response = (headers: Record<string, string>) =>
      new Response('', { status: 503, headers })

    test('reads Retry-After in seconds', () => {
      expect(backoffMs(1, response({ 'retry-after': '2' }))).toBe(2_000)
    })

    test('reads Retry-After as an HTTP date', () => {
      const when = new Date(Date.now() + 5_000).toUTCString()
      const wait = backoffMs(1, response({ 'retry-after': when }))
      expect(wait).toBeGreaterThan(3_500)
      expect(wait).toBeLessThanOrEqual(5_000)
    })

    test('clamps a hostile Retry-After to one minute', () => {
      expect(backoffMs(1, response({ 'retry-after': '3600' }))).toBe(MAX_BACKOFF_MS)
      const distant = new Date(Date.now() + 86_400_000).toUTCString()
      expect(backoffMs(1, response({ 'retry-after': distant }))).toBe(MAX_BACKOFF_MS)
    })

    test('treats a past Retry-After date as no delay', () => {
      const past = new Date(Date.now() - 60_000).toUTCString()
      expect(backoffMs(1, response({ 'retry-after': past }))).toBe(0)
    })

    test('ignores a negative or unparseable Retry-After', () => {
      // Falls through to exponential backoff: 500ms plus jitter.
      expect(backoffMs(1, response({ 'retry-after': '-5' }))).toBeGreaterThanOrEqual(500)
      expect(backoffMs(1, response({ 'retry-after': 'soon' }))).toBeGreaterThanOrEqual(500)
    })

    test('backs off exponentially, with jitter, up to a ceiling', () => {
      for (const [attempt, base] of [[1, 500], [2, 1_000], [3, 2_000], [4, 4_000], [5, 8_000]] as const) {
        const wait = backoffMs(attempt, undefined)
        expect(wait, `attempt ${attempt}`).toBeGreaterThanOrEqual(base)
        expect(wait, `attempt ${attempt}`).toBeLessThan(base + 250)
      }
      // Ceiling holds however many attempts are made.
      expect(backoffMs(20, undefined)).toBeLessThan(8_250)
    })
  })

  test('retries a network fault, not just an HTTP error', async () => {
    let attempts = 0
    const client = new ElvantoClient({
      auth: { apiKey: 'k' },
      maxRetries: 1,
      fetch: async () => {
        attempts++
        if (attempts === 1) throw new TypeError('fetch failed')
        return new Response(JSON.stringify(fixtures.peopleGetAll), {
          headers: { 'content-type': 'application/json' },
        })
      },
    })

    await expect(client.people.getAll()).resolves.toMatchObject({ total: 5 })
    expect(attempts).toBe(2)
  }, 15_000)

  test('gives up after the configured number of retries', async () => {
    const fetchStub = stubFetch([
      { status: 503, body: { status: 'fail', error: { message: 'unavailable' } }, headers: { 'retry-after': '0' } },
    ])
    const client = new ElvantoClient({
      auth: { apiKey: 'k' },
      fetch: fetchStub,
      maxRetries: 2,
    })
    await expect(client.people.getAll()).rejects.toBeInstanceOf(ElvantoApiError)
    expect(fetchStub.calls).toHaveLength(3)
  })

  test('does not retry a 4xx, which will not fix itself', async () => {
    const fetchStub = stubFetch([
      { status: 404, body: { status: 'fail', error: { code: 404, message: 'Invalid Person ID' } } },
    ])
    const client = new ElvantoClient({
      auth: { apiKey: 'k' },
      fetch: fetchStub,
      maxRetries: 3,
    })
    await expect(client.people.getInfo({ id: 'nope' })).rejects.toBeInstanceOf(
      ElvantoApiError,
    )
    expect(fetchStub.calls).toHaveLength(1)
  })

  test('stops immediately when the caller aborts, without burning retries', async () => {
    const controller = new AbortController()
    let attempts = 0
    const client = new ElvantoClient({
      auth: { apiKey: 'k' },
      maxRetries: 3,
      fetch: (_input, init) => {
        attempts++
        const abortError = () =>
          Object.assign(new Error('aborted'), { name: 'AbortError' })
        // Real fetch rejects straight away on an already-aborted signal, which
        // is the case here: the abort lands while the auth header is awaited.
        if (init?.signal?.aborted) return Promise.reject(abortError())
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(abortError()))
        })
      },
    })

    const promise = client.people.getAll(undefined, { signal: controller.signal })
    controller.abort()
    await expect(promise).rejects.toThrowError(/aborted by caller/)
    expect(attempts).toBe(1)
  })
})

describe('parseValidationMode', () => {
  test('accepts the documented spellings', () => {
    expect(parseValidationMode('throw')).toBe('throw')
    expect(parseValidationMode('strict')).toBe('throw')
    expect(parseValidationMode('warn')).toBe('warn')
    expect(parseValidationMode('off')).toBe('off')
    expect(parseValidationMode('OFF')).toBe('off')
  })

  test('treats absent input as unset rather than a default', () => {
    expect(parseValidationMode(undefined)).toBeUndefined()
    expect(parseValidationMode('')).toBeUndefined()
  })

  test('rejects nonsense loudly', () => {
    expect(() => parseValidationMode('maybe')).toThrowError(ElvantoError)
  })
})
