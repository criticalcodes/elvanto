import { describe, expect, test, vi } from 'vitest'
import { ElvantoError } from '../src/errors.js'
import {
  createStderrLogger,
  describeParamsForLog,
  parseDebugMode,
  resolveLogging,
  type ElvantoLogEvent,
} from '../src/logging.js'
import * as fixtures from './fixtures.js'
import { testClient } from './helpers.js'

/** Captures log events instead of writing them anywhere. */
function recorder(): { events: ElvantoLogEvent[]; logger: (e: ElvantoLogEvent) => void } {
  const events: ElvantoLogEvent[] = []
  return { events, logger: (event) => events.push(event) }
}

describe('parseDebugMode', () => {
  test('accepts the documented spellings', () => {
    expect(parseDebugMode('1')).toBe('on')
    expect(parseDebugMode('true')).toBe('on')
    expect(parseDebugMode('on')).toBe('on')
    expect(parseDebugMode('verbose')).toBe('verbose')
    expect(parseDebugMode('VERBOSE')).toBe('verbose')
    expect(parseDebugMode('off')).toBe('off')
    expect(parseDebugMode('0')).toBe('off')
  })

  test('treats absent input as unset, not as off', () => {
    // The distinction matters: unset falls through to other config, off overrides it.
    expect(parseDebugMode(undefined)).toBeUndefined()
    expect(parseDebugMode('  ')).toBeUndefined()
  })

  test('rejects nonsense loudly', () => {
    expect(() => parseDebugMode('sometimes')).toThrowError(ElvantoError)
  })
})

describe('resolveLogging', () => {
  test('is off by default', () => {
    expect(resolveLogging(undefined, undefined, {}).enabled).toBe(false)
  })

  test('reads ELVANTO_DEBUG when nothing is passed', () => {
    expect(resolveLogging(undefined, undefined, { ELVANTO_DEBUG: '1' }).enabled).toBe(true)
    expect(resolveLogging(undefined, undefined, { ELVANTO_DEBUG: 'verbose' }).verbose).toBe(true)
  })

  test('an explicit setting overrides the environment', () => {
    expect(resolveLogging(false, undefined, { ELVANTO_DEBUG: 'verbose' }).enabled).toBe(false)
    expect(resolveLogging('on', undefined, { ELVANTO_DEBUG: 'off' }).enabled).toBe(true)
  })

  test('supplying a logger implies logging is wanted', () => {
    const { logger } = recorder()
    expect(resolveLogging(undefined, logger, {}).enabled).toBe(true)
  })

  test('an explicit off beats a supplied logger', () => {
    const { logger } = recorder()
    expect(resolveLogging(false, logger, {}).enabled).toBe(false)
  })

  test('verbose is not implied by on', () => {
    expect(resolveLogging(true, undefined, {}).verbose).toBe(false)
  })
})

describe('describeParamsForLog', () => {
  test('logs parameter names but not values by default', () => {
    const described = describeParamsForLog({ page: 2, fields: ['birthday'] }, false)
    expect(described).toEqual({ params: ['page', 'fields'] })
    expect(JSON.stringify(described)).not.toContain('birthday')
  })

  test('omits the key entirely when there are no parameters', () => {
    expect(describeParamsForLog({}, false)).toEqual({})
  })

  test('includes values when verbose', () => {
    expect(describeParamsForLog({ page: 2 }, true)).toEqual({
      params: '{"page":2}',
    })
  })

  test('handles a search value that is not an object', () => {
    expect(String(describeParamsForLog({ search: null }, true)['params'])).toContain(
      '0 criteria',
    )
  })

  test('redacts credential-shaped parameter names', () => {
    const described = String(
      describeParamsForLog(
        { api_key: 'abc', access_token: 'def', client_secret: 'ghi' },
        true,
      )['params'],
    )
    expect(described).not.toContain('abc')
    expect(described).not.toContain('def')
    expect(described).not.toContain('ghi')
    expect(described).toContain('<redacted>')
  })

  test('does not redact a musical key, which is not a credential', () => {
    // The redaction pattern has to be precise: `chord_chart_key` is a transpose
    // target, and hiding it would make the songs endpoints harder to debug.
    expect(
      String(describeParamsForLog({ chord_chart_key: 'F#' }, true)['params']),
    ).toContain('F#')
  })

  test('never includes search terms, even when verbose', () => {
    // Search values are the most sensitive parameters: a name, email or giving number.
    const described = describeParamsForLog(
      { search: { lastname: 'Smith', email: 'john@johnsmith.com' } },
      true,
    )
    const serialized = JSON.stringify(described)
    expect(serialized).not.toContain('Smith')
    expect(serialized).not.toContain('john@johnsmith.com')
    expect(serialized).toContain('2 criteria')
  })
})

describe('createStderrLogger', () => {
  test('writes one line per event', () => {
    const lines: string[] = []
    const log = createStderrLogger((text) => lines.push(text))
    log({
      level: 'debug',
      event: 'response',
      endpoint: 'people/getAll',
      message: 'HTTP 200',
      data: { durationMs: 12, attempt: 1 },
    })

    expect(lines).toHaveLength(1)
    expect(lines[0]).toBe(
      '[elvanto] response people/getAll — HTTP 200 durationMs=12 attempt=1\n',
    )
  })

  test('renders absent values as a dash rather than "undefined"', () => {
    const lines: string[] = []
    createStderrLogger((text) => lines.push(text))({
      level: 'debug',
      event: 'response',
      message: '',
      data: { generatedIn: undefined },
    })
    expect(lines[0]).toContain('generatedIn=-')
  })

  test('defaults to process.stderr, never stdout', () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true)
    try {
      createStderrLogger()({ level: 'debug', event: 'test', message: 'hello' })
      expect(stderr).toHaveBeenCalledOnce()
      expect(stdout).not.toHaveBeenCalled()
    } finally {
      vi.restoreAllMocks()
    }
  })
})

describe('what the client logs', () => {
  test('logs the request, response and result of a call', async () => {
    const { events, logger } = recorder()
    const { client } = testClient([{ body: fixtures.peopleGetAll }], { logger })

    await client.people.getAll({ page_size: 100 })

    expect(events.map((event) => event.event)).toEqual(['request', 'response', 'result'])
    expect(events[0]!.data).toMatchObject({ params: ['page_size'] })
    expect(events[1]!.message).toBe('HTTP 200')
    expect(events[2]!.data).toMatchObject({ returned: 2, total: 5, hasMore: true })
  })

  /**
   * Run the credential checks at both levels and for every auth mechanism. The
   * leak that matters would appear in verbose mode, or via a code path that only
   * one auth type takes — asserting only the apiKey/normal case proves little.
   */
  test.each([
    ['apiKey, normal', { apiKey: 'super-secret-key' }, false],
    ['apiKey, verbose', { apiKey: 'super-secret-key' }, true],
    ['accessToken, verbose', { accessToken: 'super-secret-key' }, true],
    ['getAccessToken, verbose', { getAccessToken: () => 'super-secret-key' }, true],
  ] as const)('never logs credentials (%s)', async (_label, auth, verbose) => {
    const { events, logger } = recorder()
    const { client } = testClient([{ body: fixtures.peopleGetAll }], {
      auth,
      logger,
      ...(verbose ? { debug: 'verbose' as const } : {}),
    })

    await client.people.getAll({ page_size: 100 })

    const serialized = JSON.stringify(events)
    expect(serialized).not.toContain('super-secret-key')
    expect(serialized).not.toContain('Authorization')
    expect(serialized).not.toContain('Basic ')
    expect(serialized).not.toContain('Bearer ')
    // Not even base64-encoded.
    expect(serialized).not.toContain(
      Buffer.from('super-secret-key:x').toString('base64'),
    )
  })

  test('does not log a credential smuggled in through extraParams', async () => {
    const { events, logger } = recorder()
    const { client } = testClient([{ body: fixtures.peopleGetAll }], {
      logger,
      debug: 'verbose',
    })

    // extraParams bypass validation, so they must not bypass redaction either.
    await client.people.getAll(undefined, {
      extraParams: { api_key: 'leaked-via-extra-params' },
    })

    expect(JSON.stringify(events)).not.toContain('leaked-via-extra-params')
  })

  test('never logs member data from parameter values, even verbose', async () => {
    const { events, logger } = recorder()
    const { client } = testClient([{ body: fixtures.peopleGetAll }], {
      logger,
      debug: 'verbose',
    })

    await client.people.search({
      search: { lastname: 'Okonkwo', email: 'amara@example.com' },
    })

    const serialized = JSON.stringify(events)
    expect(serialized).not.toContain('Okonkwo')
    expect(serialized).not.toContain('amara@example.com')
  })

  test('never logs the returned records', async () => {
    const { events, logger } = recorder()
    const { client } = testClient([{ body: fixtures.peopleGetInfo }], { logger })

    await client.people.getInfo({ id: 'b0b0d8d2' })

    const serialized = JSON.stringify(events)
    // Counts and timings, yes; a member's name, email or custom field, no.
    expect(serialized).not.toContain('Jonny')
    expect(serialized).not.toContain('john@johnsmith.com')
    expect(serialized).not.toContain('Gardner')
  })

  test('logs a retry with the reason and the wait, but no response body', async () => {
    const { events, logger } = recorder()
    const { client } = testClient(
      [
        { status: 503, body: { status: 'fail', error: { message: 'unavailable' } }, headers: { 'retry-after': '0' } },
        { body: fixtures.peopleGetAll },
      ],
      { logger, maxRetries: 1 },
    )

    await client.people.getAll()

    const retry = events.find((event) => event.event === 'retry')!
    expect(retry.data).toMatchObject({ after: 'HTTP 503', waitMs: 0 })
    expect(JSON.stringify(retry)).not.toContain('unavailable')
  })

  test('logs a transport failure with its duration', async () => {
    const { events, logger } = recorder()
    const { client } = testClient([new TypeError('fetch failed')], { logger })

    await expect(client.people.getAll()).rejects.toThrow()

    const failure = events.find((event) => event.event === 'transport-error')!
    expect(failure.message).toContain('fetch failed')
    expect(failure.data).toHaveProperty('durationMs')
  })

  test('logs schema mismatch paths but not the offending values', async () => {
    const { events, logger } = recorder()
    const { client } = testClient(
      [
        {
          body: {
            status: 'ok',
            people: { page: 1, per_page: 1, on_this_page: 1, total: 1, person: [{ firstname: 'Naomi' }] },
          },
        },
      ],
      { logger, validate: 'warn', onWarning: () => {} },
    )

    await client.people.getAll()

    const mismatch = events.find((event) => event.event === 'schema-mismatch')!
    expect(mismatch.level).toBe('warn')
    expect(mismatch.data!['paths']).toContain('people.items.0.id')
    expect(JSON.stringify(mismatch)).not.toContain('Naomi')
  })

  test('stays silent when logging is off', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    try {
      const { client } = testClient([{ body: fixtures.peopleGetAll }])
      await client.people.getAll()
      expect(stderr).not.toHaveBeenCalled()
    } finally {
      vi.restoreAllMocks()
    }
  })
})
