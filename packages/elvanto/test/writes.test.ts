import { describe, expect, test, vi } from 'vitest'
import {
  ElvantoApiError,
  ElvantoRequestValidationError,
  ElvantoWriteOutcomeUnknownError,
} from '../src/errors.js'
import { testClient } from './helpers.js'

const retryNow = { 'retry-after': '0' }
const personAck = { status: 'ok', person: { id: 'p-new', family_id: 38 } }

describe('write retries', () => {
  test('a 5xx on a write is not retried, and says the outcome is unknown', async () => {
    const { client, fetch } = testClient(
      [
        { status: 502, body: { status: 'fail' }, headers: retryNow },
        { body: personAck },
      ],
      { maxRetries: 3 },
    )

    const error = await client.people
      .create({ firstname: 'Ada', lastname: 'Lovelace' })
      .catch((e: unknown) => e)

    expect(error).toBeInstanceOf(ElvantoWriteOutcomeUnknownError)
    expect((error as Error).message).toMatch(/may or may not have been applied/)
    expect((error as Error).cause).toBeInstanceOf(ElvantoApiError)
    expect(fetch.calls).toHaveLength(1)
  })

  test('a network failure on a write is not retried', async () => {
    const { client, fetch } = testClient(
      [new TypeError('socket hang up'), { body: personAck }],
      { maxRetries: 3 },
    )

    await expect(
      client.people.create({ firstname: 'Ada', lastname: 'Lovelace' }),
    ).rejects.toBeInstanceOf(ElvantoWriteOutcomeUnknownError)
    expect(fetch.calls).toHaveLength(1)
  })

  test('a 429 on a write is retried, since Elvanto refused before acting', async () => {
    const { client, fetch } = testClient(
      [
        { status: 429, body: { status: 'fail' }, headers: retryNow },
        { body: personAck },
      ],
      { maxRetries: 3 },
    )

    const ack = await client.people.create({ firstname: 'Ada', lastname: 'Lovelace' })
    expect(ack).toEqual({ id: 'p-new', family_id: 38 })
    expect(fetch.calls).toHaveLength(2)
  })

  test('a definite failure on a write is reported as itself', async () => {
    const { client } = testClient([
      { status: 404, body: { status: 'fail', error: { code: 404, message: 'No such person' } } },
    ])

    const error = await client.people.remove({ id: 'missing' }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ElvantoApiError)
    expect(error).not.toBeInstanceOf(ElvantoWriteOutcomeUnknownError)
  })

  test('reads keep retrying a 5xx as before', async () => {
    const { client, fetch } = testClient(
      [
        { status: 503, body: { status: 'fail' }, headers: retryNow },
        { body: { status: 'ok', person: [{ id: 'p' }] } },
      ],
      { maxRetries: 3, validate: 'off' },
    )

    await client.people.getInfo({ id: 'p' })
    expect(fetch.calls).toHaveLength(2)
  })
})

describe('write acknowledgements', () => {
  test('returns the documented payload', async () => {
    const { client, fetch } = testClient([
      { body: { status: 'ok', group: { id: 'g', person_id: 'p' } } },
    ])

    const ack = await client.groups.addPerson({ id: 'g', person_id: 'p', position: 'Leader' })

    expect(ack).toEqual({ id: 'g', person_id: 'p' })
    expect(fetch.calls[0]!.url).toContain('/groups/addPerson.json')
    expect(fetch.calls[0]!.body).toEqual({ id: 'g', person_id: 'p', position: 'Leader' })
  })

  test('falls back to a lone unexpected key', async () => {
    // groups/remove is documented as answering under "person".
    const { client } = testClient([{ body: { status: 'ok', person: { id: 'g' } } }])
    await expect(client.groups.remove({ id: 'g' })).resolves.toEqual({ id: 'g' })
  })

  test('reads an array acknowledgement', async () => {
    const { client } = testClient([{ body: { status: 'ok', step_person: ['sp-1'] } }])
    await expect(
      client.peopleFlows.steps.addPerson({ step_id: 's', person_id: 'p' }),
    ).resolves.toEqual(['sp-1'])
  })

  test('unwraps a one-element array around a record', async () => {
    const { client } = testClient([{ body: { status: 'ok', person: [{ id: 'p' }] } }])
    await expect(client.people.remove({ id: 'p' })).resolves.toEqual({ id: 'p' })
  })

  test('an empty acknowledgement is a success', async () => {
    const { client } = testClient([{ body: { status: 'ok', generated_in: '0.01' } }])
    await expect(client.people.remove({ id: 'p' })).resolves.toEqual({})
  })

  test('a surprising acknowledgement warns rather than throws, even under throw', async () => {
    const onWarning = vi.fn()
    const { client } = testClient(
      [{ body: { status: 'ok', person: { unexpected: true } } }],
      { validate: 'throw', onWarning },
    )

    const ack = await client.people.create({ firstname: 'Ada', lastname: 'Lovelace' })

    expect(ack).toEqual({ unexpected: true })
    expect(onWarning).toHaveBeenCalledOnce()
  })
})

describe('write parameters', () => {
  test('create requires both names', async () => {
    const { client, fetch } = testClient([{ body: personAck }])
    await expect(
      client.people.create({ firstname: 'Ada' } as never),
    ).rejects.toBeInstanceOf(ElvantoRequestValidationError)
    expect(fetch.calls).toHaveLength(0)
  })

  test('family_id accepts an id, "new", or an explicit blank', async () => {
    for (const family_id of [38, '38', 'new', '']) {
      const { client, fetch } = testClient([{ body: personAck }])
      await client.people.edit({ id: 'p', family_id })
      expect(fetch.calls[0]!.body).toMatchObject({ family_id })
    }
  })

  test('family_id rejects anything else', async () => {
    const { client } = testClient([{ body: personAck }])
    await expect(
      client.people.edit({ id: 'p', family_id: 'the smiths' }),
    ).rejects.toBeInstanceOf(ElvantoRequestValidationError)
  })

  test('fields sends a name-to-value object', async () => {
    const { client, fetch } = testClient([{ body: personAck }])
    await client.people.edit({
      id: 'p',
      fields: { gender: 'Female', custom_abc: 'x', access_permissions: ['Leaders'] },
    })
    expect(fetch.calls[0]!.body).toEqual({
      id: 'p',
      fields: { gender: 'Female', custom_abc: 'x', access_permissions: ['Leaders'] },
    })
  })
})
