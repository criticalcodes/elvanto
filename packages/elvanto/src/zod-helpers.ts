import { z } from 'zod'

/**
 * Schema helpers for Elvanto's XML-shaped JSON.
 *
 * Several helpers end in `as unknown as z.ZodType<Out, unknown>`. That is not
 * decoration: `z.preprocess` widens its input to `unknown`, and the cast restores
 * a signature callers can compose with. Each one is a promise that the runtime
 * transform really does produce the declared output type — the compiler cannot
 * check it. If you change a preprocess body, change its declared type with it, and
 * lean on `test/zod-helpers.test.ts`, which exercises every degenerate input
 * precisely because these casts cannot be trusted on inspection alone.
 */

/**
 * Elvanto's JSON is a mechanical translation of an XML document, so collections
 * arrive double-wrapped under a singular key:
 *
 *     "locations": { "location": [ {...}, {...} ] }
 *
 * and degrade in three further ways: a single member may come back as a bare
 * object instead of a one-element array, an empty collection may be `""` or
 * `[]`, and the key may be absent entirely. This flattens all of those to a
 * plain array.
 */
export function wrapped<T extends z.ZodType>(
  itemKey: string,
  item: T,
): z.ZodType<z.output<T>[], unknown> {
  return z.preprocess((value) => {
    if (value == null || value === '') return []
    // The newer People Flows endpoints already return plain JSON arrays.
    if (Array.isArray(value)) return value
    if (typeof value === 'object') {
      const obj = value as Record<string, unknown>
      let inner = obj[itemKey]
      // Several optional fields are documented by name only, with no example
      // payload, so the singular key here is an educated guess. If it misses but
      // the wrapper holds exactly one key, use that instead of silently
      // returning an empty array.
      if (!(itemKey in obj)) {
        const keys = Object.keys(obj)
        // An empty wrapper is an empty collection.
        if (keys.length === 0) return []
        if (keys.length === 1) inner = obj[keys[0]!]
        // With several candidate keys, guessing would be worse than reporting
        // the real shape, so fall through and let array validation fail loudly.
        else return value
      }
      if (inner == null || inner === '') return []
      return Array.isArray(inner) ? inner : [inner]
    }
    return value
  }, z.array(item)) as unknown as z.ZodType<z.output<T>[], unknown>
}

/**
 * A documented boolean that Elvanto encodes as `1`/`0`, `"Yes"`/`"No"`,
 * `"true"`/`"false"`, or `""` for false. Anything unrecognised is passed
 * through untouched so validation fails loudly rather than guessing.
 */
export const flag: z.ZodType<boolean, unknown> = z.preprocess((value) => {
  if (value == null || value === '') return false
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value !== 0
  if (typeof value === 'string') {
    const s = value.trim().toLowerCase()
    if (s === '1' || s === 'y' || s === 'yes' || s === 'true') return true
    if (s === '0' || s === 'n' || s === 'no' || s === 'false') return false
  }
  return value
}, z.boolean()) as unknown as z.ZodType<boolean, unknown>

/**
 * A number Elvanto sometimes quotes and sometimes doesn't — `125` vs `"360.00"`
 * for the same field on the same endpoint.
 */
export const numeric: z.ZodType<number, unknown> = z.preprocess(
  coerceNumber,
  z.number(),
) as unknown as z.ZodType<number, unknown>

export const numericOptional: z.ZodType<number | undefined, unknown> =
  z.preprocess(
    coerceNumber,
    z.number().optional(),
  ) as unknown as z.ZodType<number | undefined, unknown>

function coerceNumber(value: unknown): unknown {
  if (typeof value !== 'string') return value
  const trimmed = value.trim()
  if (trimmed === '') return undefined
  const n = Number(trimmed)
  return Number.isNaN(n) ? value : n
}

/**
 * A UUID-ish identifier. Left as a plain string: Elvanto mixes v1 UUIDs,
 * random-looking hex, and small integers (`family_id: 10`) across resources.
 */
export const id: z.ZodType<string, unknown> = z.preprocess(
  (v) => (typeof v === 'number' ? String(v) : v),
  z.string(),
) as unknown as z.ZodType<string, unknown>

/**
 * A datetime string in Elvanto's format (`"2026-02-24 11:56:22"`, always UTC)
 * or an ISO-8601 string on the financial endpoints. Kept verbatim — see
 * {@link parseElvantoDate} to convert.
 */
export const dateString = z.string()

/**
 * Turns an Elvanto date/datetime string into a `Date`.
 *
 * Elvanto documents its `"YYYY-MM-DD HH:MM:SS"` timestamps as UTC but omits the
 * zone marker, which `new Date()` would read as local time, so the zone is
 * supplied here. Already-ISO strings (financial endpoints) pass through.
 * Returns `undefined` for `""`, which Elvanto uses for "never"/"not set".
 */
export function parseElvantoDate(value: string | undefined): Date | undefined {
  if (!value) return undefined
  const trimmed = value.trim()
  if (trimmed === '' || trimmed.startsWith('0000-00-00')) return undefined

  // Date-only: midnight UTC.
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    return exact(`${trimmed}T00:00:00Z`, trimmed)
  }
  // Elvanto's space-separated UTC datetime.
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(trimmed)) {
    return exact(`${trimmed.replace(' ', 'T')}Z`, trimmed.slice(0, 10))
  }
  const d = new Date(trimmed)
  return Number.isNaN(d.getTime()) ? undefined : d
}

/**
 * Parses a UTC timestamp, rejecting a date that doesn't exist.
 *
 * `new Date('2026-02-31T00:00:00Z')` silently rolls over to 3 March rather than
 * failing, which would put a birthday or transaction in the wrong month. The
 * round-trip check catches that.
 */
function exact(isoString: string, expectedDatePart: string): Date | undefined {
  const date = new Date(isoString)
  if (Number.isNaN(date.getTime())) return undefined
  return date.toISOString().slice(0, 10) === expectedDatePart ? date : undefined
}

/** `{ id, name }` — Elvanto's shape for a reference to another record. */
export const reference = z.looseObject({
  id: id,
  name: z.string().optional(),
})
export type Reference = z.output<typeof reference>

/**
 * A reference that may arrive as `""` when unset (Elvanto does this for
 * optional single relations such as a plan item's song).
 */
export function optionalReference<T extends z.ZodType>(
  schema: T,
): z.ZodType<z.output<T> | undefined, unknown> {
  return z.preprocess(
    (v) => (v === '' || v === null ? undefined : v),
    schema.optional(),
  ) as unknown as z.ZodType<z.output<T> | undefined, unknown>
}

/** Shared page/page_size params. Elvanto rejects page sizes outside 10–1000. */
export const paginationParams = {
  page: z.number().int().positive().optional().describe('Results page to retrieve. Default: 1'),
  page_size: z
    .number()
    .int()
    .min(10)
    .max(1000)
    .optional()
    .describe('Records per page, 10–1000. Default: 1000'),
}

/** A `fields` parameter: extra fields Elvanto only returns when asked. */
export function fieldsParam(description: string) {
  return z.array(z.string()).optional().describe(description)
}

/** A parameter Elvanto accepts as either one ID or a list of IDs. */
export function idOrIds(description: string) {
  return z.union([z.string(), z.array(z.string())]).optional().describe(description)
}

/** Elvanto's `"yes"`/`"no"` filter tri-state; omitting it means "all". */
export function yesNo(description: string) {
  return z.enum(['yes', 'no']).optional().describe(description)
}

/** A `YYYY-MM-DD` date parameter. */
export function dateParam(description: string) {
  return z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected a date in YYYY-MM-DD format')
    .describe(description)
}

/**
 * A `"yes"`/`"no"` value to *set*, as the write endpoints take it.
 *
 * Distinct from {@link yesNo}, whose description is about filtering; the values
 * are the same.
 */
export function yesNoValue(description: string) {
  return z.enum(['yes', 'no']).optional().describe(description)
}

/**
 * An optional `YYYY-MM-DD` date parameter.
 */
export function optionalDateParam(description: string) {
  return z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected a date in YYYY-MM-DD format')
    .optional()
    .describe(description)
}

/**
 * The `fields` object on a write: extra and custom fields to set.
 *
 * Unlike the read-side `fields`, which is a list of names to return, this maps
 * each name to its new value — `{ "gender": "Female", "custom_<uuid>": "x" }`.
 * Values are mostly strings; a few (`access_permissions`) take a list.
 */
export function fieldValuesParam(description: string) {
  return z
    .record(
      z.string(),
      z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]),
    )
    .optional()
    .describe(description)
}
