import { describe, expect, test } from 'vitest'
import { z } from 'zod'
import {
  flag,
  numeric,
  numericOptional,
  optionalReference,
  reference,
  wrapped,
} from '../src/zod-helpers.js'

/**
 * Direct tests for the preprocess helpers. These were previously exercised only
 * indirectly through fixtures, which left the degenerate inputs — the whole
 * reason the helpers exist — unproven.
 */

describe('wrapped', () => {
  const locations = wrapped('location', reference)

  test('flattens the singular-key wrapper', () => {
    expect(locations.parse({ location: [{ id: 'a' }, { id: 'b' }] })).toEqual([
      { id: 'a' },
      { id: 'b' },
    ])
  })

  test('promotes a lone object to a one-element array', () => {
    expect(locations.parse({ location: { id: 'a' } })).toEqual([{ id: 'a' }])
  })

  test('accepts a plain array, as the People Flows endpoints send', () => {
    expect(locations.parse([{ id: 'a' }])).toEqual([{ id: 'a' }])
  })

  test('treats every empty form as an empty array', () => {
    expect(locations.parse('')).toEqual([])
    expect(locations.parse(null)).toEqual([])
    expect(locations.parse([])).toEqual([])
    expect(locations.parse({ location: '' })).toEqual([])
    expect(locations.parse({ location: null })).toEqual([])
    expect(locations.parse({})).toEqual([])
  })

  describe('when the guessed singular key is wrong', () => {
    test('falls back to the sole key present', () => {
      // Several singular keys are inferred from field names the docs never show
      // populated, so a near-miss must still yield the data.
      expect(locations.parse({ campus: [{ id: 'a' }] })).toEqual([{ id: 'a' }])
    })

    test('fails loudly rather than silently returning nothing', () => {
      // Two candidate keys: guessing would be worse than reporting the real shape.
      expect(
        locations.safeParse({ alpha: [{ id: 'a' }], beta: [{ id: 'b' }] }).success,
      ).toBe(false)
    })

    test('fails on a scalar, which cannot be a collection', () => {
      expect(locations.safeParse('nonsense').success).toBe(false)
      expect(locations.safeParse(42).success).toBe(false)
    })
  })

  test('still validates the items it unwraps', () => {
    expect(locations.safeParse({ location: [{ notAnId: true }] }).success).toBe(false)
  })
})

describe('flag', () => {
  test('normalizes the 1/0 form', () => {
    expect(flag.parse(1)).toBe(true)
    expect(flag.parse(0)).toBe(false)
  })

  test('normalizes the Yes/No form, which the search parameters document', () => {
    expect(flag.parse('Yes')).toBe(true)
    expect(flag.parse('No')).toBe(false)
    expect(flag.parse('yes')).toBe(true)
    expect(flag.parse('NO')).toBe(false)
  })

  test('normalizes the quoted-boolean form the calendar endpoint sends', () => {
    expect(flag.parse('true')).toBe(true)
    expect(flag.parse('false')).toBe(false)
  })

  test('accepts real booleans', () => {
    expect(flag.parse(true)).toBe(true)
    expect(flag.parse(false)).toBe(false)
  })

  test('treats empty and absent as false', () => {
    expect(flag.parse('')).toBe(false)
    expect(flag.parse(null)).toBe(false)
    expect(flag.parse(undefined)).toBe(false)
  })

  test('rejects an unrecognised value rather than guessing', () => {
    // Guessing here would invent a boolean from data we don't understand.
    expect(flag.safeParse('maybe').success).toBe(false)
    expect(flag.safeParse({}).success).toBe(false)
  })
})

describe('numeric', () => {
  test('accepts a number unchanged', () => {
    expect(numeric.parse(125)).toBe(125)
    expect(numeric.parse(0)).toBe(0)
    expect(numeric.parse(-1.5)).toBe(-1.5)
  })

  test('unquotes the string form Elvanto mixes in', () => {
    expect(numeric.parse('360.00')).toBe(360)
    expect(numeric.parse(' 42 ')).toBe(42)
  })

  test('rejects a non-numeric string rather than coercing it to NaN', () => {
    expect(numeric.safeParse('abc').success).toBe(false)
    // Thousands separators are not stripped — silently reading "1,200" as 1 would
    // be far worse than failing.
    expect(numeric.safeParse('1,200.00').success).toBe(false)
  })

  test('treats an empty string as absent, which the optional form allows', () => {
    expect(numeric.safeParse('').success).toBe(false)
    expect(numericOptional.parse('')).toBeUndefined()
    expect(numericOptional.parse('   ')).toBeUndefined()
    expect(numericOptional.parse(undefined)).toBeUndefined()
  })

  test('parses the JavaScript numeric forms consistently', () => {
    // Documented so the behaviour is deliberate rather than incidental.
    expect(numeric.parse('1e3')).toBe(1000)
    expect(numeric.parse('0x10')).toBe(16)
  })
})

describe('optionalReference', () => {
  const song = optionalReference(z.looseObject({ id: z.string() }))

  test('passes a present object through', () => {
    expect(song.parse({ id: 'a' })).toEqual({ id: 'a' })
  })

  test('turns the empty forms into undefined, not a bogus object', () => {
    // Elvanto sends "" for an unset single relation, e.g. a plan row's song.
    expect(song.parse('')).toBeUndefined()
    expect(song.parse(null)).toBeUndefined()
    expect(song.parse(undefined)).toBeUndefined()
  })

  test('still validates a present value', () => {
    expect(song.safeParse({ wrong: true }).success).toBe(false)
  })
})
