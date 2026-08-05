import { z } from 'zod'
import { numericOptional } from './zod-helpers.js'

/** A page of records, with Elvanto's pagination counters normalized. */
export interface Page<T> {
  items: T[]
  /** 1-based page number this result represents. */
  page: number
  /** Records requested per page. */
  perPage: number
  /** Records actually on this page. */
  onThisPage: number
  /** Total records matching the query across all pages. */
  total: number
  /** Whether a further page exists. */
  hasMore: boolean
}

/**
 * Every Elvanto response, success or failure, arrives inside this envelope.
 * Note that `status: "fail"` comes back with HTTP 200 on some endpoints, so the
 * body must be inspected rather than trusting the status line.
 */
export const envelopeSchema = z.looseObject({
  status: z.string().optional(),
  generated_in: z.union([z.string(), z.number()]).optional(),
  error: z
    .looseObject({
      code: z.union([z.number(), z.string()]).optional(),
      message: z.string().optional(),
    })
    .optional(),
})

export type Envelope = z.output<typeof envelopeSchema>

/**
 * Builds a schema for a paginated collection, flattening Elvanto's
 * `{ on_this_page, page, per_page, total, <itemKey>: [...] }` block into a
 * {@link Page}.
 *
 * Pagination counters are treated as optional because at least one endpoint
 * (`peopleFlows/steps/people`) documents itself as unpaginated; they are
 * derived from the returned items when absent.
 */
export function pageSchema<T extends z.ZodType>(
  itemKey: string,
  item: T,
): z.ZodType<Page<z.output<T>>, unknown> {
  const inner = z.object({
    items: z.array(item),
    page: numericOptional,
    per_page: numericOptional,
    on_this_page: numericOptional,
    total: numericOptional,
  })

  return z.preprocess((value) => {
    // A collection arriving as a plain JSON array, with no wrapper at all. The
    // People Flows endpoints already dropped the singular-key idiom, so this is
    // a live drift direction; accept it rather than reporting an empty page.
    if (Array.isArray(value)) {
      return { items: value, on_this_page: value.length, total: value.length }
    }
    // Anything that is not an object cannot be a collection. Returning it
    // unchanged makes validation fail loudly, which is far better than the
    // empty page a `{}` fallback would silently produce.
    if (value === null || typeof value !== 'object') return value

    const obj = value as Record<string, unknown>
    const rawItems = obj[itemKey]
    const items =
      rawItems == null || rawItems === ''
        ? []
        : Array.isArray(rawItems)
          ? rawItems
          : [rawItems]
    return {
      items,
      page: obj['page'],
      per_page: obj['per_page'],
      on_this_page: obj['on_this_page'],
      total: obj['total'],
    }
  }, inner).transform((v): Page<z.output<T>> => {
    const page = v.page ?? 1
    const onThisPage = v.on_this_page ?? v.items.length
    const perPage = v.per_page ?? onThisPage
    const total = v.total ?? v.items.length
    return {
      items: v.items as z.output<T>[],
      page,
      perPage,
      onThisPage,
      total,
      hasMore: perPage > 0 && page * perPage < total,
    }
  }) as unknown as z.ZodType<Page<z.output<T>>, unknown>
}

/**
 * Builds a schema for a single-record response.
 *
 * Elvanto is inconsistent here: `people/getInfo` returns `person: [{...}]` — a
 * one-element array — while `financial/transactions/getInfo` returns
 * `transaction: {...}` as a bare object. Both are accepted.
 */
export function singleSchema<T extends z.ZodType>(
  item: T,
): z.ZodType<z.output<T>, unknown> {
  return z.preprocess(
    (value) => (Array.isArray(value) ? value[0] : value),
    item,
  ) as unknown as z.ZodType<z.output<T>, unknown>
}

/**
 * True when a single-record payload came back empty rather than erroring.
 *
 * Covers all three forms Elvanto uses for "nothing here": absent, `""`, and an
 * empty array. An empty *object* is deliberately not included — that is a
 * malformed record, not an absent one, and should surface as a schema error.
 */
export function isEmptySingle(value: unknown): boolean {
  if (value == null || value === '') return true
  return Array.isArray(value) && value.length === 0
}
