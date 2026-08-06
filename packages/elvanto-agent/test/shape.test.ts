import { describe, expect, test } from 'vitest'
import { serviceSchema } from '@criticalcodes/elvanto'
import {
  addDays,
  daysBetween,
  displayName,
  isoDate,
  laterOf,
  personCard,
  rosterEntries,
  serviceHeader,
} from '../src/shape.ts'

describe('displayName', () => {
  test('prefers the preferred name over the first name', () => {
    // The whole point of the field: someone recorded as Jonathan who goes by
    // Josh should be called Josh.
    expect(
      displayName({ firstname: 'Jonathan', preferred_name: 'Josh', lastname: 'Cuneo' }),
    ).toBe('Josh Cuneo')
  })

  test('falls back through firstname to a placeholder', () => {
    expect(displayName({ firstname: 'Ada', lastname: 'Lovelace' })).toBe('Ada Lovelace')
    expect(displayName({ lastname: 'Lovelace' })).toBe('Lovelace')
    expect(displayName({ firstname: 'Ada' })).toBe('Ada')
    expect(displayName({})).toBe('(unnamed)')
  })

  test('ignores whitespace-only names', () => {
    expect(displayName({ firstname: '  ', preferred_name: '', lastname: 'Smith' })).toBe('Smith')
  })
})

describe('personCard', () => {
  test('keeps one contact number, preferring mobile', () => {
    const card = personCard({ id: 'p1', firstname: 'Ada', mobile: '0400', phone: '9999' })
    expect(card.phone).toBe('0400')
  })

  test('omits absent contact details rather than emitting empty strings', () => {
    const card = personCard({ id: 'p1', firstname: 'Ada' })
    expect(card).toEqual({ id: 'p1', name: 'Ada' })
  })

  test('drops the fields a compact card has no business carrying', () => {
    // The privacy half of the reshaping: an address or giving number on the
    // record must not reach the model just because it was requested.
    const card = personCard({
      id: 'p1',
      firstname: 'Ada',
      home_address: '1 Test St',
      giving_number: '4242',
      security_code: '9999',
    } as never)
    expect(Object.keys(card).sort()).toEqual(['id', 'name'])
  })

  test('flags archived and volunteer only when true', () => {
    expect(personCard({ id: 'p1', archived: false, volunteer: true })).toMatchObject({
      volunteer: true,
    })
    expect(personCard({ id: 'p1', archived: false, volunteer: false })).not.toHaveProperty(
      'volunteer',
    )
  })
})

describe('rosterEntries', () => {
  /** The four-level structure Elvanto actually returns, as the live sweep saw it. */
  const service = serviceSchema.parse({
    id: 's1',
    name: 'Sunday Gathering',
    date: '2026-08-09 09:00:00',
    volunteers: {
      plan: [
        {
          time_id: 't1',
          positions: {
            position: [
              {
                department_id: 'd1',
                department_name: 'Music',
                sub_department_id: 'sd1',
                sub_department_name: 'Band',
                position_id: 'pos1',
                position_name: 'Acoustic Guitar',
                volunteers: {
                  volunteer: [
                    {
                      // A bare object, not a one-element array — this is the
                      // shape a live account returns.
                      person: { id: 'p1', firstname: 'Ada', lastname: 'Lovelace' },
                      status: 'Confirmed',
                    },
                    {
                      person: { id: 'p2', firstname: 'Alan', lastname: 'Turing' },
                      status: 'Unconfirmed',
                    },
                  ],
                },
              },
              {
                department_name: 'Kids',
                position_name: 'Leader',
                volunteers: { volunteer: [{ person: { id: 'p3', firstname: 'Grace' } }] },
              },
            ],
          },
        },
      ],
    },
  })

  test('flattens to one row per scheduled person', () => {
    const entries = rosterEntries(service)
    expect(entries).toHaveLength(3)
    expect(entries[0]).toEqual({
      department: 'Music',
      subDepartment: 'Band',
      position: 'Acoustic Guitar',
      person: { id: 'p1', name: 'Ada Lovelace' },
      status: 'Confirmed',
    })
  })

  test('carries Elvanto\'s own confirmation wording through untranslated', () => {
    expect(rosterEntries(service).map((e) => e.status)).toEqual([
      'Confirmed',
      'Unconfirmed',
      undefined,
    ])
  })

  test('returns nothing when volunteers were not requested', () => {
    // The important distinction: a service fetched without `fields: ['volunteers']`
    // has no roster, which must not read as "nobody is serving".
    const bare = serviceSchema.parse({ id: 's2' })
    expect(rosterEntries(bare)).toEqual([])
  })

  test('skips a position with no one assigned', () => {
    const empty = serviceSchema.parse({
      id: 's3',
      volunteers: { plan: [{ positions: { position: [{ position_name: 'Sound' }] } }] },
    })
    expect(rosterEntries(empty)).toEqual([])
  })
})

describe('serviceHeader', () => {
  test('translates only the two documented status values', () => {
    expect(serviceHeader(serviceSchema.parse({ id: 's1', status: 1 })).status).toBe('published')
    expect(serviceHeader(serviceSchema.parse({ id: 's1', status: 0 })).status).toBe('draft')
    // An unknown numeric state is left off rather than mislabelled.
    expect(serviceHeader(serviceSchema.parse({ id: 's1', status: 7 })).status).toBeUndefined()
  })

  test('reads the nested reference objects', () => {
    const header = serviceHeader(
      serviceSchema.parse({
        id: 's1',
        service_type: { id: 'st1', name: 'Sunday' },
        location: { id: 'l1', name: 'Main Hall' },
      }),
    )
    expect(header).toMatchObject({ type: 'Sunday', location: 'Main Hall' })
  })
})

describe('date helpers', () => {
  test('isoDate emits the only format Elvanto filters accept', () => {
    expect(isoDate(new Date('2026-08-06T23:30:00Z'))).toBe('2026-08-06')
  })

  test('addDays crosses month and year boundaries', () => {
    expect(isoDate(addDays(new Date('2026-08-30T00:00:00Z'), 3))).toBe('2026-09-02')
    expect(isoDate(addDays(new Date('2026-12-31T00:00:00Z'), 1))).toBe('2027-01-01')
    expect(isoDate(addDays(new Date('2026-03-01T00:00:00Z'), -1))).toBe('2026-02-28')
  })

  test('laterOf compares Elvanto date strings without parsing them', () => {
    // They are zero-padded and most-significant-first, so string order is date
    // order — worth asserting, since the whole aggregation relies on it.
    expect(laterOf('2026-01-09 09:00:00', '2026-01-10 09:00:00')).toBe('2026-01-10 09:00:00')
    expect(laterOf(undefined, '2026-01-10 09:00:00')).toBe('2026-01-10 09:00:00')
    expect(laterOf('2026-01-10 09:00:00', undefined)).toBe('2026-01-10 09:00:00')
    expect(laterOf(undefined, undefined)).toBeUndefined()
  })

  test('daysBetween is signed', () => {
    expect(daysBetween(new Date('2026-08-06T00:00:00Z'), new Date('2026-09-14T00:00:00Z'))).toBe(39)
    expect(daysBetween(new Date('2026-09-14T00:00:00Z'), new Date('2026-08-06T00:00:00Z'))).toBe(-39)
  })
})
