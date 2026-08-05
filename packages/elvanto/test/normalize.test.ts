import { describe, expect, test, vi } from 'vitest'
import { ElvantoClient } from '../src/client.js'
import { ElvantoApiError, ElvantoResponseValidationError } from '../src/errors.js'
import { parseElvantoDate } from '../src/zod-helpers.js'
import * as fixtures from './fixtures.js'
import { stubFetch, testClient } from './helpers.js'

describe('paginated collections', () => {
  test('lifts the singular-key wrapper into items plus counters', async () => {
    const { client } = testClient([{ body: fixtures.peopleGetAll }])
    const result = await client.people.getAll()

    expect(result.items).toHaveLength(2)
    expect(result.items[0]!.firstname).toBe('John')
    expect(result.page).toBe(1)
    expect(result.perPage).toBe(2)
    expect(result.onThisPage).toBe(2)
    expect(result.total).toBe(5)
    expect(result.hasMore).toBe(true)
  })

  test('computes hasMore from the final page', async () => {
    const { client } = testClient([
      {
        body: {
          status: 'ok',
          people: { page: 3, per_page: 2, on_this_page: 1, total: 5, person: [{ id: 'x' }] },
        },
      },
    ])
    const result = await client.people.getAll({ page: 3 })
    expect(result.hasMore).toBe(false)
  })

  test('derives counters when an endpoint omits them', async () => {
    const { client } = testClient([
      {
        body: {
          status: 'ok',
          people_flow_step_members: {
            people_flow_step_member: [{ id: 'a' }, { id: 'b' }],
          },
        },
      },
    ])
    const result = await client.peopleFlows.steps.people({ step_id: 's' })
    expect(result.items).toHaveLength(2)
    expect(result.total).toBe(2)
    expect(result.onThisPage).toBe(2)
    expect(result.hasMore).toBe(false)
  })

  test('reads a collection sent as a bare array, with no wrapper at all', async () => {
    // People Flows already dropped the singular-key idiom, so an endpoint
    // dropping the collection wrapper is a live drift direction. Reporting an
    // empty page here would read as "this account has no people".
    const { client } = testClient([
      { body: { status: 'ok', people: [{ id: 'a' }, { id: 'b' }] } },
    ])
    const result = await client.people.getAll()
    expect(result.items.map((p) => p.id)).toEqual(['a', 'b'])
    expect(result.total).toBe(2)
  })

  test('never reports an empty page for a collection it cannot read', async () => {
    // The dangerous failure is a silent zero. A scalar where a collection belongs
    // must be an error, in every mode.
    for (const collection of ['nonsense', 42, true] as const) {
      const { client } = testClient([{ body: { status: 'ok', people: collection } }])
      await expect(client.people.getAll()).rejects.toBeInstanceOf(
        ElvantoResponseValidationError,
      )
    }
  })

  test('reads People Flows plain arrays without a wrapper', async () => {
    const { client } = testClient([{ body: fixtures.peopleFlowsGetAll }])
    const result = await client.peopleFlows.getAll()

    const flow = result.items[0]!
    expect(flow.name).toBe('First Time Giver')
    expect(flow.admins).toEqual(['45a5f2f5-f828-11e4-bd65-06e37142e2e1'])
    expect(flow.steps?.[0]?.name).toBe('Thank You Letter/Email')
    expect(flow.locations).toEqual([])
  })
})

describe('single records', () => {
  test('unwraps a one-element array', async () => {
    const { client } = testClient([{ body: fixtures.peopleGetInfo }])
    const person = await client.people.getInfo({ id: 'b0b0d8d2' })
    expect(person.firstname).toBe('John')
    expect(Array.isArray(person)).toBe(false)
  })

  test('accepts a bare object, as the financial endpoints send', async () => {
    const { client } = testClient([{ body: fixtures.transactionGetInfo }])
    const transaction = await client.financial.transactions.getInfo({ id: '3b63' })
    expect(transaction.person_first_name).toBe('Evelyn')
  })

  test('raises a not-found for every empty form Elvanto uses', async () => {
    // Absent, `""` and `[]` all mean "no record"; each must read as not-found
    // rather than as a schema error.
    for (const person of [[], '', null, undefined]) {
      const { client } = testClient([{ body: { status: 'ok', person } }])
      const error = await client.people.getInfo({ id: 'gone' }).catch((e: unknown) => e)
      expect(error, JSON.stringify(person)).toBeInstanceOf(ElvantoApiError)
      expect((error as ElvantoApiError).isNotFound).toBe(true)
    }
  })

  test('reports a malformed single record as a schema error, not a not-found', async () => {
    // An empty object is a broken record, not an absent one — conflating them
    // would report "no such person" for a real bug.
    const { client } = testClient([{ body: { status: 'ok', person: {} } }])
    await expect(client.people.getInfo({ id: 'x' })).rejects.toBeInstanceOf(
      ElvantoResponseValidationError,
    )
  })

  test('warn mode returns a malformed single record rather than failing', async () => {
    const onWarning = vi.fn()
    const { client } = testClient([{ body: { status: 'ok', person: [{ firstname: 'A' }] } }], {
      validate: 'warn',
      onWarning,
    })
    const person = await client.people.getInfo({ id: 'x' })
    expect((person as { firstname?: string }).firstname).toBe('A')
    expect(onWarning).toHaveBeenCalledTimes(1)
  })
})

describe('wrapped collections', () => {
  test('flattens a nested collection to an array', async () => {
    const { client } = testClient([{ body: fixtures.peopleGetInfo }])
    const person = await client.people.getInfo({ id: 'x' })
    expect(person.locations).toEqual([
      { id: '8a631195-8914-4136-858c-f160885ab60d', name: 'Central Campus' },
      { id: '9f3aec97-3d61-471d-ab50-5f28070d970d', name: 'North Campus' },
    ])
  })

  test('promotes a lone object to a one-element array', async () => {
    const { client } = testClient([{ body: fixtures.peopleGetAll }])
    const result = await client.people.getAll()
    expect(result.items[1]!.locations).toEqual([{ id: 'north', name: 'North Campus' }])
  })

  test('turns an empty-string collection into an empty array', async () => {
    const { client } = testClient([
      { body: { status: 'ok', person: [{ id: 'x', locations: '' }] } },
    ])
    const person = await client.people.getInfo({ id: 'x' })
    expect(person.locations).toEqual([])
  })

  test('distinguishes "not requested" from "empty"', async () => {
    const { client } = testClient([{ body: { status: 'ok', person: [{ id: 'x' }] } }])
    const person = await client.people.getInfo({ id: 'x' })
    // Absent because `fields` didn't ask for it — not an empty list.
    expect(person.locations).toBeUndefined()
  })

  test('omits an absent optional collection on a custom field', async () => {
    const { client } = testClient([{ body: fixtures.customFieldsGetAll }])
    const result = await client.people.customFields.getAll()
    expect(result.items[0]!.values).toHaveLength(2)
    expect(result.items[1]!.values).toBeUndefined()
  })
})

describe('value normalization', () => {
  test('turns documented 1/0 flags into booleans', async () => {
    const { client } = testClient([{ body: fixtures.peopleGetInfo }])
    const person = await client.people.getInfo({ id: 'x' })
    expect(person.volunteer).toBe(true)
    expect(person.admin).toBe(false)
    expect(person.archived).toBe(false)
  })

  test('accepts quoted booleans, which the calendar endpoint sends', async () => {
    const { client } = testClient([{ body: fixtures.calendarGetAll }])
    const result = await client.calendar.getAll()
    expect(result.items[0]!.members).toBe(true)
    expect(result.items[1]!.members).toBe(false)
    expect(result.items[1]!.published).toBe(true)
  })

  test('normalizes inconsistently quoted money to numbers', async () => {
    const { client } = testClient([{ body: fixtures.transactionGetInfo }])
    const transaction = await client.financial.transactions.getInfo({ id: 'x' })
    expect(transaction.transaction_total).toBe(360)
    expect(transaction.amounts?.[0]?.total).toBe(360)
    expect(transaction.batch?.number).toBe(15)
  })

  test('keeps explicit nulls rather than coercing them', async () => {
    const { client } = testClient([{ body: fixtures.transactionGetInfo }])
    const transaction = await client.financial.transactions.getInfo({ id: 'x' })
    expect(transaction.created_by_first_name).toBeNull()
  })

  test('stringifies an integer id, which people/getInfo returns for family_id', async () => {
    const { client } = testClient([{ body: fixtures.peopleGetInfo }])
    const person = await client.people.getInfo({ id: 'x' })
    expect(person.family_id).toBe('10')
  })

  test('preserves account-specific custom fields', async () => {
    const { client } = testClient([{ body: fixtures.peopleGetInfo }])
    const person = await client.people.getInfo({ id: 'x' })
    expect(person['custom_77493627-aaba-426e-48dc-b0b0d8d24c99']).toBe('Gardner')
  })

  test('leaves Elvanto numeric states alone, since they are not booleans', async () => {
    const { client } = testClient([{ body: fixtures.serviceGetInfo }])
    const service = await client.services.getInfo({ id: 'x' })
    // 1 means "published" here, so coercing it to `true` would lose meaning.
    expect(service.status).toBe(1)
  })
})

describe('nested service structures', () => {
  test('normalizes plans, items and the songs inside them', async () => {
    const { client } = testClient([{ body: fixtures.serviceGetInfo }])
    const service = await client.services.getInfo({ id: 'x', fields: ['plans'] })

    const plan = service.plans![0]!
    expect(plan.service_length).toBe(5400)
    expect(plan.items).toHaveLength(2)
    // An empty-string song becomes undefined rather than a bogus object.
    expect(plan.items![0]!.song).toBeUndefined()
    expect(plan.items![0]!.heading).toBe(false)
    expect(plan.items![1]!.song?.title).toBe('How Great Is Our God')
    expect(plan.items![1]!.song?.arrangement?.key).toBe('G')
  })

  test('normalizes the volunteer roster three levels deep', async () => {
    const { client } = testClient([{ body: fixtures.serviceGetInfo }])
    const service = await client.services.getInfo({ id: 'x', fields: ['volunteers'] })

    const position = service.volunteers![0]!.positions![0]!
    expect(position.department_name).toBe('Music')
    expect(position.volunteers![0]!.person?.lastname).toBe('Smith')
    expect(position.volunteers![0]!.status).toBe('Confirmed')
  })

  test('handles service times, files and notes', async () => {
    const { client } = testClient([{ body: fixtures.serviceGetInfo }])
    const service = await client.services.getInfo({ id: 'x' })

    expect(service.service_times![0]!.name).toBe('First Service')
    expect(service.files![0]!.html).toBe(false)
    expect(service.notes![0]!.note).toBe('<p>A random note!</p>')
    expect(service.songs![0]!.title).toBe('All I Need Is You')
  })
})

describe('validation modes', () => {
  const badPayload = {
    status: 'ok',
    people: { total: 1, page: 1, per_page: 1, on_this_page: 1, person: [{ id: 42 }] },
  }
  const wrongShape = {
    status: 'ok',
    people: { total: 1, page: 1, per_page: 1, on_this_page: 1, person: [{ firstname: 'John' }] },
  }

  test('throws by default when the shape is wrong', async () => {
    const { client } = testClient([{ body: wrongShape }])
    const error = await client.people.getAll().catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ElvantoResponseValidationError)
    // The unvalidated payload is still reachable for debugging.
    expect((error as ElvantoResponseValidationError).data).toBeDefined()
    expect((error as ElvantoResponseValidationError).issues[0]!.path).toContain('people')
  })

  test('points at the documentation mismatch in the message', async () => {
    const { client } = testClient([{ body: wrongShape }])
    await expect(client.people.getAll()).rejects.toThrowError(
      /differs from its documentation/,
    )
  })

  test('warn mode returns the data and reports once', async () => {
    const onWarning = vi.fn()
    const { client } = testClient([{ body: wrongShape }], {
      validate: 'warn',
      onWarning,
    })

    const result = await client.people.getAll()
    expect(result.items).toHaveLength(1)
    expect(onWarning).toHaveBeenCalledTimes(1)
    expect(onWarning.mock.calls[0]![0].endpoint).toBe('people.getAll')
  })

  test('off mode skips field validation but still normalizes structure', async () => {
    const { client } = testClient([{ body: badPayload }], { validate: 'off' })
    const result = await client.people.getAll()
    // Structure is normalized...
    expect(result.total).toBe(1)
    expect(result.items).toHaveLength(1)
    // ...but the field is passed through unchecked.
    expect((result.items[0] as { id: unknown }).id).toBe(42)
  })

  test('a per-call override beats the client default', async () => {
    const { client } = testClient([{ body: wrongShape }], { validate: 'throw' })
    await expect(
      client.people.getAll(undefined, { validate: 'off' }),
    ).resolves.toMatchObject({ total: 1 })
  })

  test('flags a missing collection key, which would mean our registry is wrong', async () => {
    const { client } = testClient([{ body: { status: 'ok', humans: {} } }])
    await expect(client.people.getAll()).rejects.toThrowError(
      /expected a "people" collection/,
    )
  })

  test('warn mode degrades a missing collection to an empty page', async () => {
    const onWarning = vi.fn()
    const { client } = testClient([{ body: { status: 'ok', humans: {} } }], {
      validate: 'warn',
      onWarning,
    })
    const result = await client.people.getAll()
    expect(result.items).toEqual([])
    expect(result.total).toBe(0)
    expect(onWarning).toHaveBeenCalledTimes(1)
  })
})

describe('pagination', () => {
  test('walks every page and yields each record', async () => {
    const page = (n: number, ids: string[], total: number) => ({
      body: {
        status: 'ok',
        people: {
          page: n,
          per_page: 2,
          on_this_page: ids.length,
          total,
          person: ids.map((id) => ({ id })),
        },
      },
    })
    const fetchStub = stubFetch([
      page(1, ['a', 'b'], 5),
      page(2, ['c', 'd'], 5),
      page(3, ['e'], 5),
    ])
    const client = new ElvantoClient({ auth: { apiKey: 'k' }, fetch: fetchStub })

    const ids: string[] = []
    for await (const person of client.paginate('people.getAll', { page_size: 10 })) {
      ids.push(person.id)
    }

    expect(ids).toEqual(['a', 'b', 'c', 'd', 'e'])
    expect(fetchStub.calls.map((c) => (c.body as { page: number }).page)).toEqual([1, 2, 3])
  })

  test('treats Elvanto\'s "nothing matched" 404 as an empty result', async () => {
    const fetchStub = stubFetch([
      { status: 404, body: { status: 'fail', error: { code: 404, message: 'No people match your criteria' } } },
    ])
    const client = new ElvantoClient({ auth: { apiKey: 'k' }, fetch: fetchStub, maxRetries: 0 })

    await expect(client.fetchAll('people.getAll')).resolves.toEqual([])
  })

  test('still propagates a real error while iterating', async () => {
    const fetchStub = stubFetch([
      { status: 401, body: { status: 'fail', error: { code: 401, message: 'Unauthorised' } } },
    ])
    const client = new ElvantoClient({ auth: { apiKey: 'k' }, fetch: fetchStub, maxRetries: 0 })
    await expect(client.fetchAll('people.getAll')).rejects.toBeInstanceOf(ElvantoApiError)
  })

  test('respects maxRecords and stops fetching', async () => {
    const fetchStub = stubFetch([
      {
        body: {
          status: 'ok',
          people: { page: 1, per_page: 2, on_this_page: 2, total: 100, person: [{ id: 'a' }, { id: 'b' }] },
        },
      },
    ])
    const client = new ElvantoClient({ auth: { apiKey: 'k' }, fetch: fetchStub })

    const collected = await client.fetchAll('people.getAll', undefined, { maxRecords: 3 })
    expect(collected).toHaveLength(3)
    // Two pages were enough to reach the cap; it did not keep going to page 50.
    expect(fetchStub.calls).toHaveLength(2)
  })

  test('respects maxPages', async () => {
    const fetchStub = stubFetch([
      {
        body: {
          status: 'ok',
          people: { page: 1, per_page: 1, on_this_page: 1, total: 100, person: [{ id: 'a' }] },
        },
      },
    ])
    const client = new ElvantoClient({ auth: { apiKey: 'k' }, fetch: fetchStub })
    const collected = await client.fetchAll('people.getAll', undefined, { maxPages: 2 })
    expect(collected).toHaveLength(2)
    expect(fetchStub.calls).toHaveLength(2)
  })

  test('starts from an explicit page when given one', async () => {
    const fetchStub = stubFetch([
      {
        body: {
          status: 'ok',
          people: { page: 4, per_page: 2, on_this_page: 1, total: 7, person: [{ id: 'g' }] },
        },
      },
    ])
    const client = new ElvantoClient({ auth: { apiKey: 'k' }, fetch: fetchStub })
    await client.fetchAll('people.getAll', { page: 4 })
    expect((fetchStub.calls[0]!.body as { page: number }).page).toBe(4)
  })
})

describe('parseElvantoDate', () => {
  test('reads a space-separated timestamp as UTC, not local time', () => {
    expect(parseElvantoDate('2026-02-24 11:56:22')?.toISOString()).toBe(
      '2026-02-24T11:56:22.000Z',
    )
  })

  test('reads a date-only value as midnight UTC', () => {
    expect(parseElvantoDate('1989-04-23')?.toISOString()).toBe(
      '1989-04-23T00:00:00.000Z',
    )
  })

  test('passes an ISO string through', () => {
    expect(parseElvantoDate('2026-07-25T20:44:00+00:00')?.toISOString()).toBe(
      '2026-07-25T20:44:00.000Z',
    )
  })

  test('treats Elvanto\'s empty and zero dates as unset', () => {
    expect(parseElvantoDate('')).toBeUndefined()
    expect(parseElvantoDate(undefined)).toBeUndefined()
    expect(parseElvantoDate('0000-00-00 00:00:00')).toBeUndefined()
  })

  test('returns undefined for junk rather than an Invalid Date', () => {
    expect(parseElvantoDate('not a date')).toBeUndefined()
  })

  test('rejects a date that does not exist instead of rolling it over', () => {
    // `new Date('2026-02-31')` silently becomes 3 March, which would put a
    // birthday or transaction in the wrong month.
    expect(parseElvantoDate('2026-02-31')).toBeUndefined()
    expect(parseElvantoDate('2026-13-01')).toBeUndefined()
    expect(parseElvantoDate('2026-02-30 10:00:00')).toBeUndefined()
    // A real leap day still parses.
    expect(parseElvantoDate('2024-02-29')?.toISOString()).toBe('2024-02-29T00:00:00.000Z')
  })
})
