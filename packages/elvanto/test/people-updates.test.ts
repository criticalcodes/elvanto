import { describe, expect, test } from 'vitest'
import { ElvantoClient } from '../src/client.js'
import { updatePeople } from '../src/people-updates.js'

const ROLES = 'custom_roles'
const EXPIRY = 'custom_expiry'
const NUMBER = 'custom_number'
const ROLE = 'custom_role'
const NOTES = 'custom_notes'

const definitions = [
  {
    id: 'roles',
    name: 'Serving Roles',
    type: 'select_multi',
    values: { value: ['Nursery', 'Kids', 'Youth', 'Music'].map((name) => ({ id: `o-${name}`, name })) },
  },
  { id: 'expiry', name: 'Check Expiry', type: 'datepicker' },
  { id: 'number', name: 'Check Number', type: 'text' },
  { id: 'role', name: 'Music Role', type: 'select', values: { value: [{ id: 'r1', name: 'Leader' }] } },
  { id: 'notes', name: 'Medical Conditions', type: 'textarea' },
]

type Person = Record<string, unknown>

/**
 * An in-memory Elvanto: people/getInfo and people/edit over a map of records,
 * with a multi-select stored and returned the way the live API does. `failEdit`
 * makes edits answer with the database error seen live, optionally after
 * applying them anyway.
 */
function fakeElvanto(
  people: Record<string, Person>,
  options: { failEdit?: 'before' | 'after'; datesAs?: 'dmy'; validate?: 'off' } = {},
) {
  const edits: Record<string, unknown>[] = []
  const fetch = async (input: unknown, init?: RequestInit): Promise<Response> => {
    const path = String(input).replace(/^.*\/v1\//, '').replace(/\.json$/, '')
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
    const json = (value: unknown) => Response.json(value)

    if (path === 'people/customFields/getAll') {
      return json({ status: 'ok', custom_fields: { custom_field: definitions } })
    }
    if (path === 'people/getInfo') {
      const person = people[String(body['id'])]
      if (!person) return json({ status: 'fail', error: { code: 404, message: 'Invalid Person ID.' } })
      const out: Person = { ...person }
      const roles = person[ROLES] as string[] | undefined
      out[ROLES] = roles && roles.length > 0 ? { custom_field: roles.map((name) => ({ id: `o-${name}`, name })) } : ''
      const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(person[EXPIRY] ?? ''))
      if (options.datesAs === 'dmy' && iso) out[EXPIRY] = `${iso[3]}/${iso[2]}/${iso[1]}`
      return json({ status: 'ok', person: [out] })
    }
    if (path === 'people/edit') {
      edits.push(body)
      const fail = () =>
        json({ status: 'fail', error: { code: 500, message: 'Sorry, we\'ve run into a problem when saving to the database.' } })
      if (options.failEdit === 'before') return fail()
      const person = people[String(body['id'])]!
      const { id: _id, fields, ...direct } = body
      Object.assign(person, direct, fields as Person)
      if (options.failEdit === 'after') return fail()
      return json({ status: 'ok', person: { id: body['id'], family_id: '0' } })
    }
    throw new Error(`unexpected ${path}`)
  }
  const client = new ElvantoClient({
    auth: { apiKey: 'k' },
    fetch: fetch as typeof globalThis.fetch,
    maxRetries: 0,
    ...(options.validate ? { validate: options.validate } : {}),
  })
  return { client, edits }
}

const sam = (): Person => ({
  id: 'sam',
  firstname: 'Samuel',
  preferred_name: 'Sam',
  lastname: 'Taylor',
  email: 'sam@example.org',
  category_id: 'cat-1',
  [ROLES]: ['Kids', 'Youth'],
  [EXPIRY]: '2025-01-01',
  [NUMBER]: 'CHK123',
})

describe('dry run', () => {
  test('is the default, reports before and after, and writes nothing', async () => {
    const people = { sam: sam() }
    const { client, edits } = fakeElvanto(people)

    const report = await updatePeople(client, {
      updates: [
        {
          id: 'sam',
          add: { [ROLES]: ['Music'] },
          remove: { [ROLES]: ['Kids'] },
          set: { [EXPIRY]: '2027-03-17', email: 'sam@new.org' },
        },
      ],
    })

    expect(report.applied).toBe(false)
    expect(edits).toHaveLength(0)
    expect(report.results[0]).toMatchObject({
      id: 'sam',
      name: 'Sam Taylor',
      status: 'would-change',
      changes: [
        { field: ROLES, label: 'Serving Roles', before: ['Kids', 'Youth'], after: ['Youth', 'Music'] },
        { field: EXPIRY, label: 'Check Expiry', before: '2025-01-01', after: '2027-03-17' },
        { field: 'email', label: 'Email', before: 'sam@example.org', after: 'sam@new.org' },
      ],
    })
  })

  test('works with validation off, when definitions arrive unflattened', async () => {
    const { client } = fakeElvanto({ sam: sam() }, { validate: 'off' })
    const report = await updatePeople(client, {
      updates: [{ id: 'sam', add: { 'Serving Roles': ['Music'] } }],
    })
    expect(report.results[0]).toMatchObject({ status: 'would-change', problems: [] })
  })

  test('removing one position keeps the others', async () => {
    const { client } = fakeElvanto({ sam: sam() })
    const report = await updatePeople(client, {
      updates: [{ id: 'sam', remove: { 'Serving Roles': ['kids'] } }],
    })
    expect(report.results[0]!.changes[0]!.after).toEqual(['Youth'])
  })

  test('a change that is already true is reported as unchanged', async () => {
    const { client } = fakeElvanto({ sam: sam() })
    const report = await updatePeople(client, {
      updates: [{ id: 'sam', add: { [ROLES]: ['Youth'] }, set: { [NUMBER]: 'CHK123' } }],
    })
    expect(report.results[0]!.status).toBe('unchanged')
  })

  test('reports every mistake in an update rather than guessing', async () => {
    const { client } = fakeElvanto({ sam: sam() })
    const report = await updatePeople(client, {
      updates: [
        {
          id: 'sam',
          add: { [ROLES]: ['Choir'], [NUMBER]: ['x'] },
          set: { [EXPIRY]: '17/03/2027', [NOTES]: 'x', [ROLES]: 'Music', firstname: 'Ann' },
        },
      ],
    })
    const [result] = report.results
    expect(result!.status).toBe('invalid')
    expect(result!.problems.join('\n')).toMatch(/"Choir" is not an option/)
    expect(result!.problems.join('\n')).toMatch(/not a multi-select/)
    expect(result!.problems.join('\n')).toMatch(/YYYY-MM-DD/)
    expect(result!.problems.join('\n')).toMatch(/textarea field/)
    expect(result!.problems.join('\n')).toMatch(/use add\/remove/)
    expect(result!.problems.join('\n')).toMatch(/Unknown field "firstname"/)
  })

  test('an unknown person is an error, and the id is flagged twice in a batch', async () => {
    const { client } = fakeElvanto({ sam: sam() })
    const report = await updatePeople(client, {
      updates: [
        { id: 'nobody', set: { email: 'x@y.z' } },
        { id: 'sam', set: { email: 'a@b.c' } },
        { id: 'sam', add: { [ROLES]: ['Music'] } },
      ],
    })
    expect(report.results.map((r) => r.status)).toEqual(['error', 'invalid', 'invalid'])
  })
})

describe('apply', () => {
  test('writes the merged set and confirms it by reading back', async () => {
    const people = { sam: sam() }
    const { client, edits } = fakeElvanto(people)

    const report = await updatePeople(client, {
      apply: true,
      updates: [{ id: 'sam', add: { [ROLES]: ['Music'] }, remove: { [ROLES]: ['Kids'] }, set: { [ROLE]: 'leader' } }],
    })

    // A drop-down goes as a string: a live account rejects the array its docs ask for.
    expect(edits).toEqual([{ id: 'sam', fields: { [ROLES]: ['Youth', 'Music'], [ROLE]: 'Leader' } }])
    expect(people.sam[ROLES]).toEqual(['Youth', 'Music'])
    expect(report.applied).toBe(true)
    expect(report.results[0]!.status).toBe('applied')
    expect(report.results[0]!.changes.every((c) => c.landed)).toBe(true)
  })

  test('removing the last option clears the checkbox with "", since [] changes nothing', async () => {
    const people = { sam: sam() }
    const { client, edits } = fakeElvanto(people)
    await updatePeople(client, {
      apply: true,
      updates: [{ id: 'sam', remove: { [ROLES]: ['Kids', 'Youth'] } }],
    })
    expect(edits).toEqual([{ id: 'sam', fields: { [ROLES]: '' } }])
  })

  test('merges against the record as it is now, not as a dry run saw it', async () => {
    const people = { sam: sam() }
    const { client } = fakeElvanto(people)
    await updatePeople(client, { updates: [{ id: 'sam', add: { [ROLES]: ['Music'] } }] })
    ;(people.sam[ROLES] as string[]).push('Nursery')

    const report = await updatePeople(client, { apply: true, updates: [{ id: 'sam', add: { [ROLES]: ['Music'] } }] })
    expect(report.results[0]!.changes[0]!.after).toEqual(['Nursery', 'Kids', 'Youth', 'Music'])
  })

  test('writes nothing when any update in the batch is invalid', async () => {
    const people = { sam: sam(), tom: { ...sam(), id: 'tom' } }
    const { client, edits } = fakeElvanto(people)

    const report = await updatePeople(client, {
      apply: true,
      updates: [
        { id: 'sam', add: { [ROLES]: ['Music'] } },
        { id: 'tom', add: { [ROLES]: ['Choir'] } },
      ],
    })

    expect(edits).toHaveLength(0)
    expect(report.applied).toBe(false)
    expect(report.refused).toMatch(/nothing was written/)
  })

  test('a failed write is checked, not assumed: not applied', async () => {
    const { client } = fakeElvanto({ sam: sam() }, { failEdit: 'before' })
    const report = await updatePeople(client, { apply: true, updates: [{ id: 'sam', add: { [ROLES]: ['Music'] } }] })

    const [result] = report.results
    expect(result!.status).toBe('not-applied')
    expect(result!.problems[0]).toMatch(/problem when saving/)
    expect(result!.changes[0]).toMatchObject({ landed: false, found: ['Kids', 'Youth'] })
  })

  test('a failed write that landed anyway is reported as applied', async () => {
    const { client } = fakeElvanto({ sam: sam() }, { failEdit: 'after' })
    const report = await updatePeople(client, { apply: true, updates: [{ id: 'sam', add: { [ROLES]: ['Music'] } }] })
    expect(report.results[0]!.status).toBe('applied')
    expect(report.results[0]!.problems[0]).toMatch(/problem when saving/)
  })

  test('dates compare as dates on read-back, whatever format comes back', async () => {
    const { client } = fakeElvanto({ sam: sam() }, { datesAs: 'dmy' })

    const report = await updatePeople(client, { apply: true, updates: [{ id: 'sam', set: { [EXPIRY]: '2027-03-17' } }] })
    expect(report.results[0]!.status).toBe('applied')
  })
})
