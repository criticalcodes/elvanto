import { describe, expect, test } from 'vitest'
import {
  attemptsFor,
  findPerson,
  listCustomFields,
  nextServing,
  roster,
  serviceBrief,
  songHistory,
} from '../src/tools/index.ts'
import {
  callTool,
  fixedClock,
  page,
  rejectsInput,
  stubClient,
  type RecordedRequest,
} from './harness.ts'

/** A person as `people/search` returns one. */
function person(id: string, extra: Record<string, unknown> = {}) {
  return { id, firstname: 'Ada', lastname: 'Lovelace', ...extra }
}

/** A service with a volunteer roster attached. */
function serviceWithRoster(
  id: string,
  date: string,
  people: Array<{ id: string; name: string; department?: string; position?: string }>,
) {
  return {
    id,
    name: 'Sunday Gathering',
    date,
    status: 1,
    volunteers: {
      plan: [
        {
          time_id: 't1',
          positions: {
            position: people.map((p) => ({
              department_name: p.department ?? 'Music',
              position_name: p.position ?? 'Guitar',
              volunteers: {
                volunteer: [{ person: { id: p.id, firstname: p.name }, status: 'Confirmed' }],
              },
            })),
          },
        },
      ],
    },
  }
}

describe('find_person', () => {
  describe('search strategy', () => {
    test('an address goes straight to the email field', () => {
      expect(attemptsFor('ada@example.com')).toEqual([
        { search: { email: 'ada@example.com' }, matchedOn: 'email' },
      ])
    })

    test('a phone number tries mobile before landline', () => {
      const attempts = attemptsFor('0400 123 456')
      expect(attempts.map((a) => a.matchedOn)).toEqual(['mobile', 'phone'])
    })

    test('a single name tries surname first', () => {
      // The more selective field, and the more common way one name gets used.
      expect(attemptsFor('Cuneo').map((a) => a.matchedOn)).toEqual([
        'lastname',
        'firstname',
        'preferred name',
      ])
    })

    test('a full name pairs the fields, then falls back to surname alone', () => {
      const attempts = attemptsFor('Josh Cuneo')
      expect(attempts[0]!.search).toEqual({ firstname: 'Josh', lastname: 'Cuneo' })
      expect(attempts[1]!.search).toEqual({ lastname: 'Cuneo' })
    })

    test('a middle name is ignored, not sent as a third key', () => {
      // Elvanto ANDs the keys, so sending a middle name would exclude everyone
      // whose record omits it.
      expect(attemptsFor('Ada Byron Lovelace')[0]!.search).toEqual({
        firstname: 'Ada',
        lastname: 'Lovelace',
      })
    })

    test('a short number is treated as a name, not a phone number', () => {
      expect(attemptsFor('12345')[0]!.search).toEqual({ lastname: '12345' })
    })

    test('an empty query yields no searches at all', () => {
      expect(attemptsFor('   ')).toEqual([])
    })
  })

  test('returns compact cards, not person records', async () => {
    const { client } = stubClient(() =>
      page('people', 'person', [
        person('p1', {
          email: 'ada@example.com',
          mobile: '0400',
          home_address: '1 Test St',
          giving_number: '4242',
        }),
      ]),
    )

    const { output } = await callTool(findPerson({ client }), { query: 'Lovelace' })
    const result = output as { matches: Array<Record<string, unknown>> }

    expect(result.matches[0]).toEqual({
      id: 'p1',
      name: 'Ada Lovelace',
      email: 'ada@example.com',
      phone: '0400',
      matchedOn: 'lastname',
    })
    // The address and giving number were on the record and must not be here.
    expect(JSON.stringify(result)).not.toContain('Test St')
    expect(JSON.stringify(result)).not.toContain('4242')
  })

  test('stops searching once it has enough matches', async () => {
    const requests: RecordedRequest[] = []
    const stub = stubClient((path, body) => {
      requests.push({ path, body })
      return page('people', 'person', [person('p1')])
    })

    await callTool(findPerson({ client: stub.client }), { query: 'Cuneo', limit: 1 })
    // One hit satisfied limit: 1, so the firstname and preferred-name attempts
    // never ran.
    expect(stub.requests).toHaveLength(1)
  })

  test('merges across attempts and deduplicates by id', async () => {
    let call = 0
    const stub = stubClient(() => {
      call++
      // The same person found by two different strategies, plus a second person.
      return call === 1
        ? page('people', 'person', [person('p1')])
        : page('people', 'person', [person('p1'), person('p2', { firstname: 'Alan' })])
    })

    const { output } = await callTool(findPerson({ client: stub.client }), {
      query: 'Cuneo',
      limit: 10,
    })
    const result = output as { count: number; matches: Array<{ id: string; matchedOn: string }> }

    expect(result.count).toBe(2)
    // First strategy to find them wins the label, since attempts run
    // strongest-first.
    expect(result.matches.find((m) => m.id === 'p1')!.matchedOn).toBe('lastname')
  })

  test('excludes archived people by default, at the query', async () => {
    const stub = stubClient(() => page('people', 'person', []))
    await callTool(findPerson({ client: stub.client }), { query: 'Cuneo' })

    // Narrowed server-side, so archived records never enter the context.
    for (const request of stub.requests) {
      expect((request.body as { search: Record<string, string> }).search['archived']).toBe('no')
    }
  })

  test('includes archived when asked', async () => {
    const stub = stubClient(() => page('people', 'person', []))
    await callTool(findPerson({ client: stub.client }), {
      query: 'Cuneo',
      include_archived: true,
    })
    expect(
      (stub.requests[0]!.body as { search: Record<string, string> }).search,
    ).not.toHaveProperty('archived')
  })

  test('treats no matches as an answer with advice, not an error', async () => {
    // Elvanto answers "nothing matched" with a 404, which paginate must absorb.
    const { client } = stubClient(() => ({
      status: 'fail',
      error: { code: 404, message: 'No records match' },
    }))

    const { output } = await callTool(findPerson({ client }), { query: 'Nobody' })
    const result = output as { matches: unknown[]; advice: string }
    expect(result.matches).toEqual([])
    expect(result.advice).toContain('include_archived')
  })

  test('never logs the query or the names it found', async () => {
    const { client } = stubClient(() =>
      page('people', 'person', [person('p1', { email: 'ada@example.com' })]),
    )
    const { logs } = await callTool(findPerson({ client }), { query: 'Lovelace' })

    const joined = logs.join('\n')
    expect(joined).not.toContain('Lovelace')
    expect(joined).not.toContain('ada@example.com')
    expect(joined).toContain('matched 1')
  })

  test('rejects an empty query before running', () => {
    expect(rejectsInput(findPerson({ client: stubClient(() => ({})).client }), { query: '' })).toBe(
      true,
    )
  })

  test('rejects a limit above the hard ceiling', () => {
    const tool = findPerson({ client: stubClient(() => ({})).client })
    expect(rejectsInput(tool, { query: 'x', limit: 500 })).toBe(true)
  })
})

describe('roster', () => {
  test('flattens the volunteer tree into readable rows', async () => {
    const { client } = stubClient(() =>
      page('services', 'service', [
        serviceWithRoster('s1', '2026-08-09 09:00:00', [
          { id: 'p1', name: 'Ada', department: 'Music', position: 'Guitar' },
          { id: 'p2', name: 'Alan', department: 'Kids', position: 'Leader' },
        ]),
      ]),
    )

    const { output } = await callTool(roster({ client, now: fixedClock }))
    const result = output as {
      scheduledCount: number
      services: Array<{ entries: Array<Record<string, unknown>> }>
    }

    expect(result.scheduledCount).toBe(2)
    expect(result.services[0]!.entries[0]).toEqual({
      department: 'Music',
      position: 'Guitar',
      person: { id: 'p1', name: 'Ada' },
      status: 'Confirmed',
    })
  })

  test('defaults to a forward window from today', async () => {
    const stub = stubClient(() => page('services', 'service', []))
    await callTool(roster({ client: stub.client, now: fixedClock }))

    expect(stub.requests[0]!.body).toMatchObject({
      start: '2026-08-06',
      end: '2026-08-20',
    })
  })

  test('always passes all:yes, so past dates work', async () => {
    // Without it, services.getAll returns only upcoming services and ignores a
    // past `start` — "who served last Sunday" would answer "nobody".
    const stub = stubClient(() => page('services', 'service', []))
    await callTool(roster({ client: stub.client, now: fixedClock }), {
      start: '2026-01-01',
      end: '2026-01-31',
    })
    expect(stub.requests[0]!.body).toMatchObject({ all: 'yes' })
  })

  test('a single date collapses to a one-day range', async () => {
    const stub = stubClient(() => page('services', 'service', []))
    await callTool(roster({ client: stub.client, now: fixedClock }), { date: '2026-08-09' })
    expect(stub.requests[0]!.body).toMatchObject({ start: '2026-08-09', end: '2026-08-09' })
  })

  test('filters by department, case-insensitively', async () => {
    const { client } = stubClient(() =>
      page('services', 'service', [
        serviceWithRoster('s1', '2026-08-09 09:00:00', [
          { id: 'p1', name: 'Ada', department: 'Music' },
          { id: 'p2', name: 'Alan', department: 'Kids' },
        ]),
      ]),
    )

    const { output } = await callTool(roster({ client, now: fixedClock }), { department: 'kids' })
    const result = output as { services: Array<{ entries: Array<{ person: { name: string } }> }> }
    expect(result.services[0]!.entries.map((e) => e.person.name)).toEqual(['Alan'])
  })

  test('reports an inverted range instead of returning an empty roster', async () => {
    // An empty result would read as "nobody is serving", which is a wrong answer
    // rather than a missing one.
    const { client } = stubClient(() => page('services', 'service', []))
    const { output } = await callTool(roster({ client, now: fixedClock }), {
      start: '2026-08-20',
      end: '2026-08-01',
    })
    expect((output as { error: string }).error).toContain('after end')
  })

  test('says so when no services fall in range', async () => {
    const { client } = stubClient(() => page('services', 'service', []))
    const { output } = await callTool(roster({ client, now: fixedClock }))
    expect((output as { advice: string }).advice).toContain('No services')
  })

  test('rejects a malformed date before running', () => {
    const tool = roster({ client: stubClient(() => ({})).client })
    expect(rejectsInput(tool, { date: '9 August 2026' })).toBe(true)
    expect(rejectsInput(tool, { date: '2026-8-9' })).toBe(true)
  })
})

describe('next_serving', () => {
  test('finds one person across several services', async () => {
    const { client } = stubClient(() =>
      page('services', 'service', [
        serviceWithRoster('s1', '2026-08-09 09:00:00', [
          { id: 'p1', name: 'Ada', position: 'Guitar' },
          { id: 'p2', name: 'Alan' },
        ]),
        serviceWithRoster('s2', '2026-08-16 09:00:00', [{ id: 'p2', name: 'Alan' }]),
        serviceWithRoster('s3', '2026-08-23 09:00:00', [
          { id: 'p1', name: 'Ada', position: 'Vocals' },
        ]),
      ]),
    )

    const { output } = await callTool(nextServing({ client, now: fixedClock }), {
      person_id: 'p1',
    })
    const result = output as {
      count: number
      assignments: Array<{ position: string; service: { id: string } }>
    }

    expect(result.count).toBe(2)
    expect(result.assignments.map((a) => a.service.id)).toEqual(['s1', 's3'])
    expect(result.assignments.map((a) => a.position)).toEqual(['Guitar', 'Vocals'])
  })

  test('advises when the person is not rostered', async () => {
    const { client } = stubClient(() =>
      page('services', 'service', [
        serviceWithRoster('s1', '2026-08-09 09:00:00', [{ id: 'p2', name: 'Alan' }]),
      ]),
    )
    const { output } = await callTool(nextServing({ client, now: fixedClock }), {
      person_id: 'p1',
    })
    const result = output as { count: number; advice: string }
    expect(result.count).toBe(0)
    expect(result.advice).toContain('raise days')
  })

  test('requires a person id rather than accepting a name', () => {
    const tool = nextServing({ client: stubClient(() => ({})).client })
    expect(rejectsInput(tool, {})).toBe(true)
    expect(rejectsInput(tool, { person_id: '' })).toBe(true)
  })
})

describe('service_brief', () => {
  const service = {
    id: 's1',
    name: 'Sunday Gathering',
    date: '2026-08-09 09:00:00',
    status: 1,
    series_name: 'Summer',
    service_times: { service_time: [{ id: 't1', name: 'Morning', starts: '2026-08-09 09:00:00' }] },
    songs: {
      song: [
        {
          id: 'song1',
          title: 'All I Need Is You',
          artist: 'Hillsong',
          arrangement: { id: 'a1', key_name: 'G', bpm: '120' },
        },
      ],
    },
    plans: {
      plan: [
        {
          time_id: 't1',
          items: {
            item: [
              { heading: 1, title: 'Welcome' },
              { title: 'Song', duration: '5:00', when: 'during' },
            ],
          },
        },
      ],
    },
    volunteers: {
      plan: [
        {
          time_id: 't1',
          positions: {
            position: [
              {
                department_name: 'Music',
                sub_department_name: 'Band',
                position_name: 'Guitar',
                volunteers: { volunteer: [{ person: { id: 'p1', firstname: 'Ada' } }] },
              },
            ],
          },
        },
      ],
    },
    notes: { note: [{ id: 'n1', note: 'Bring the extra music stand.' }] },
  }

  test('assembles everything in one request', async () => {
    const stub = stubClient(() => ({ status: 'ok', service }))
    const { output } = await callTool(serviceBrief({ client: stub.client, now: fixedClock }), {
      service_id: 's1',
    })

    expect(stub.requests).toHaveLength(1)
    // Every optional section requested at once — a model that asks piecemeal
    // concludes a service has no songs when it simply did not ask.
    expect(stub.requests[0]!.body['fields']).toEqual([
      'series_name',
      'service_times',
      'plans',
      'volunteers',
      'songs',
      'notes',
    ])

    const result = output as {
      songs: Array<{ title: string; key: string }>
      volunteers: Record<string, string[]>
      notes: string[]
      status: string
    }
    expect(result.status).toBe('published')
    expect(result.songs[0]).toMatchObject({ title: 'All I Need Is You', key: 'G' })
    expect(result.volunteers['Music / Band']).toEqual(['Ada (Guitar)'])
    expect(result.notes).toEqual(['Bring the extra music stand.'])
  })

  test('falls back to the first service on a date', async () => {
    const stub = stubClient(() => page('services', 'service', [service]))
    const { output } = await callTool(serviceBrief({ client: stub.client, now: fixedClock }), {
      date: '2026-08-09',
    })
    expect(stub.requests[0]!.body).toMatchObject({ start: '2026-08-09', end: '2026-08-09' })
    expect((output as { id: string }).id).toBe('s1')
  })

  test('advises when a date has no service', async () => {
    const { client } = stubClient(() => page('services', 'service', []))
    const { output } = await callTool(serviceBrief({ client, now: fixedClock }), {
      date: '2026-08-10',
    })
    expect((output as { advice: string }).advice).toContain('No service found')
  })

  test('truncates a very long note rather than dropping or passing it whole', async () => {
    const longNote = 'x'.repeat(2000)
    const { client } = stubClient(() => ({
      status: 'ok',
      service: { ...service, notes: { note: [{ id: 'n1', note: longNote }] } },
    }))

    const { output } = await callTool(serviceBrief({ client, now: fixedClock }), {
      service_id: 's1',
    })
    const notes = (output as { notes: string[] }).notes
    expect(notes[0]!.length).toBeLessThan(600)
    expect(notes[0]).toContain('(truncated)')
  })
})

describe('song_history', () => {
  function serviceWithSongs(id: string, date: string, songs: Array<[string, string, string?]>) {
    return {
      id,
      date,
      songs: {
        song: songs.map(([songId, title, key]) => ({
          id: songId,
          title,
          artist: 'Hillsong',
          ...(key ? { arrangement: { id: `arr-${songId}`, key_name: key } } : {}),
        })),
      },
    }
  }

  test('aggregates counts, dates and keys per song', async () => {
    const { client } = stubClient(() =>
      page('services', 'service', [
        serviceWithSongs('s1', '2026-07-05 09:00:00', [['song1', 'Cornerstone', 'G']]),
        serviceWithSongs('s2', '2026-08-02 09:00:00', [
          ['song1', 'Cornerstone', 'A'],
          ['song2', 'Amazing Grace', 'D'],
        ]),
      ]),
    )

    const { output } = await callTool(songHistory({ client, now: fixedClock }))
    const result = output as {
      servicesScanned: number
      songs: Array<{ title: string; count: number; lastUsed: string; keys: string[] }>
    }

    expect(result.servicesScanned).toBe(2)
    const cornerstone = result.songs.find((s) => s.title === 'Cornerstone')!
    expect(cornerstone.count).toBe(2)
    expect(cornerstone.lastUsed).toBe('2026-08-02 09:00:00')
    // Both keys, deduplicated — genuinely useful for a worship planner.
    expect(cornerstone.keys).toEqual(['G', 'A'])
  })

  test('defaults to the trailing year and asks only for songs', async () => {
    const stub = stubClient(() => page('services', 'service', []))
    await callTool(songHistory({ client: stub.client, now: fixedClock }))

    expect(stub.requests[0]!.body).toMatchObject({
      start: '2025-08-06',
      end: '2026-08-06',
      all: 'yes',
      fields: ['songs'],
    })
  })

  test('sorts by most recent, or by frequency on request', async () => {
    const { client } = stubClient(() =>
      page('services', 'service', [
        serviceWithSongs('s1', '2026-01-04 09:00:00', [['often', 'Often Sung']]),
        serviceWithSongs('s2', '2026-02-01 09:00:00', [['often', 'Often Sung']]),
        serviceWithSongs('s3', '2026-08-02 09:00:00', [['recent', 'Sung Once Recently']]),
      ]),
    )
    const deps = { client, now: fixedClock }

    const byRecent = await callTool(songHistory(deps))
    expect((byRecent.output as { songs: Array<{ title: string }> }).songs[0]!.title).toBe(
      'Sung Once Recently',
    )

    const byFrequency = await callTool(songHistory(deps), { sort: 'frequency' })
    expect((byFrequency.output as { songs: Array<{ title: string }> }).songs[0]!.title).toBe(
      'Often Sung',
    )
  })

  test('filters by title without asking Elvanto to', async () => {
    const { client } = stubClient(() =>
      page('services', 'service', [
        serviceWithSongs('s1', '2026-08-02 09:00:00', [
          ['song1', 'Cornerstone'],
          ['song2', 'Amazing Grace'],
        ]),
      ]),
    )
    const { output } = await callTool(songHistory({ client, now: fixedClock }), {
      title: 'grace',
    })
    const songs = (output as { songs: Array<{ title: string }> }).songs
    expect(songs.map((s) => s.title)).toEqual(['Amazing Grace'])
  })

  test('distinguishes "nothing recorded" from "nothing sung"', async () => {
    // The songs sub-structure is documentation-derived, so an empty result is
    // ambiguous and must not be reported as fact.
    const { client } = stubClient(() => page('services', 'service', []))
    const { output } = await callTool(songHistory({ client, now: fixedClock }))
    expect((output as { advice: string }).advice).toContain('not attached')
  })
})

describe('list_custom_fields', () => {
  test('returns the custom_<uuid> key, not just the id', async () => {
    const { client } = stubClient(() =>
      page('custom_fields', 'custom_field', [
        { id: 'abc-123', name: 'WWCC Expiry', type: 'date' },
        {
          id: 'def-456',
          name: 'Training Status',
          type: 'select',
          values: { value: [{ id: 'v1', name: 'Complete' }, { id: 'v2', name: 'Pending' }] },
        },
      ]),
    )

    const { output } = await callTool(listCustomFields({ client }))
    const result = output as {
      fields: Array<{ key: string; name: string; values?: string[] }>
    }

    // The key is the whole reason to call this — it is what `fields` and
    // `search` accept.
    expect(result.fields[0]).toMatchObject({ key: 'custom_abc-123', name: 'WWCC Expiry' })
    expect(result.fields[1]!.values).toEqual(['Complete', 'Pending'])
  })

  test('filters by name', async () => {
    const { client } = stubClient(() =>
      page('custom_fields', 'custom_field', [
        { id: 'a', name: 'WWCC Expiry', type: 'date' },
        { id: 'b', name: 'Shirt Size', type: 'text' },
      ]),
    )
    const { output } = await callTool(listCustomFields({ client }), { name: 'wwcc' })
    expect((output as { count: number }).count).toBe(1)
  })
})

describe('lazy client construction', () => {
  test('a tool is built without touching the client', () => {
    // The render-time guarantee: building the tool set must not construct a
    // client, or a missing API key kills the agent before it can explain itself.
    let built = 0
    const tool = findPerson({
      client: () => {
        built++
        throw new Error('should not be constructed at build time')
      },
    })
    expect(tool.name).toBe('find_person')
    expect(built).toBe(0)
  })

  test('the client is built once, not per call', async () => {
    let built = 0
    const stub = stubClient(() => page('people', 'person', []))
    const tool = findPerson({
      client: () => {
        built++
        return stub.client
      },
    })

    await callTool(tool, { query: 'a' })
    await callTool(tool, { query: 'b' })
    // One client, so the request pacing it owns actually applies across calls.
    expect(built).toBe(1)
  })
})
