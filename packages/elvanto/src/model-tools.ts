import { isPageEndpoint, type EndpointDefinition } from './registry.js'

/**
 * Helpers for exposing endpoints to a language model.
 *
 * Two surfaces need exactly the same behaviour here — the MCP server, and any
 * agent framework generating native tools from the registry — and the behaviour
 * is subtle enough that two copies would drift. A model reading a tool
 * description on one surface and a differently-capped response on the other is a
 * bug that only shows up as bad answers.
 *
 * `paramsJsonSchema` already lives alongside the registry for the same reason, so
 * this is consistent rather than a new kind of thing.
 */

/**
 * Default records per page for a model-facing call that doesn't specify one.
 *
 * Elvanto's own default is 1000, which would flood a context window on a
 * mid-sized account. Callers can still ask for more explicitly, up to 1000.
 */
export const DEFAULT_PAGE_SIZE = 25

/** Hard cap on the characters one tool result may serialise to. */
export const DEFAULT_MAX_RESPONSE_CHARS = 100_000

/**
 * Floor for the response cap. Below this there is no room for the truncation
 * notice itself, so the cap could not be honoured while still explaining why.
 */
export const MIN_MAX_RESPONSE_CHARS = 1_000

/**
 * The tool description a model reads for one endpoint.
 *
 * Everything a model would otherwise get wrong is stated here: that services are
 * upcoming-only by default, that a search takes a field-to-keyword map, that a
 * page is 25 records unless asked otherwise, and that some response shapes have
 * never met real data.
 */
export function endpointToolDescription(
  endpoint: EndpointDefinition,
  defaultPageSize: number = DEFAULT_PAGE_SIZE,
): string {
  const parts = [endpoint.summary]
  if (endpoint.notes) parts.push(endpoint.notes)

  if (isPageEndpoint(endpoint) && 'page_size' in endpoint.params.shape) {
    parts.push(
      `Returns up to ${defaultPageSize} records per call unless page_size is ` +
        `given. The result includes total and has_more — increase page or ` +
        `page_size to see the rest.`,
    )
  }
  if (endpoint.effect === 'write') {
    parts.push(
      'This changes the Elvanto account. It is not retried automatically; if it ' +
        'reports that the outcome is unknown, check with a read before calling ' +
        'it again, or it may be applied twice.',
    )
  }
  if (endpoint.effect === 'destructive') {
    parts.push(
      'This can delete or discard data in the Elvanto account, and cannot be ' +
        'undone by another call. Confirm the exact record with the user first. ' +
        'It is not retried automatically; if it reports that the outcome is ' +
        'unknown, check with a read before calling it again.',
    )
  }
  if (endpoint.auth === 'oauth-only') {
    parts.push('Requires OAuth; unavailable when authenticated with an API key.')
  }
  if (endpoint.verified !== 'live') {
    parts.push(
      "Note: this endpoint's response shape follows Elvanto's documentation but " +
        'has not been verified against real data, so it may differ.',
    )
  }
  parts.push(`Docs: ${endpoint.docs}`)
  return parts.join(' ')
}

/** Applies the page-size default to a model's arguments, in place of nothing. */
export function withDefaultPageSize(
  endpoint: EndpointDefinition,
  args: Record<string, unknown>,
  defaultPageSize: number = DEFAULT_PAGE_SIZE,
): Record<string, unknown> {
  if (
    isPageEndpoint(endpoint) &&
    'page_size' in endpoint.params.shape &&
    args['page_size'] === undefined
  ) {
    return { ...args, page_size: defaultPageSize }
  }
  return args
}

interface PageResult {
  items: unknown[]
  page: number
  perPage: number
  total: number
  hasMore: boolean
}

function isPageResult(value: unknown): value is PageResult {
  return (
    typeof value === 'object' &&
    value !== null &&
    Array.isArray((value as { items?: unknown }).items) &&
    typeof (value as { total?: unknown }).total === 'number'
  )
}

/**
 * Reshapes a result into the form a model should see.
 *
 * Page results are rewritten into snake_case keys matching Elvanto's own
 * vocabulary, so a model reading the tool description sees the same names in the
 * response as in the docs it was pointed at.
 */
export function toModelPayload(result: unknown): unknown {
  if (!isPageResult(result)) return result
  return {
    total: result.total,
    page: result.page,
    per_page: result.perPage,
    returned: result.items.length,
    has_more: result.hasMore,
    items: result.items,
  }
}

const serialize = (value: unknown): string => JSON.stringify(value, null, 2)

/**
 * Serialises a payload within a character budget, saying what it dropped.
 *
 * Every candidate is measured after serialisation rather than estimated, because
 * an estimate has to guess the indentation depth each record will end up at and
 * the size of the truncation notice itself — get either wrong and the "cap" is
 * exceeded. Silent truncation is the real hazard: a short result reads as a
 * complete one, so the notice is part of the budget, not an afterthought.
 */
export function fitToBudget(payload: unknown, maxChars: number): string {
  const full = serialize(payload)
  if (full.length <= maxChars) return full

  if (isPageResult(payload)) return fitPage(payload, maxChars)
  return fitRecord(payload, maxChars)
}

/** Drops whole records from the end of a page until it fits. */
function fitPage(page: PageResult, maxChars: number): string {
  const rest = { ...page } as Record<string, unknown>
  delete rest['items']

  const build = (items: unknown[], dropped: number) =>
    serialize({
      ...rest,
      items,
      truncated: {
        dropped_records: dropped,
        returned: items.length,
        reason: `Response exceeded ${maxChars} characters.`,
        advice:
          'Request a smaller page_size, or narrow the query with the available filters.',
      },
    })

  let kept = page.items.length
  while (kept > 0) {
    const text = build(page.items.slice(0, kept), page.items.length - kept)
    if (text.length <= maxChars) return text

    // Shrink by the overflow divided by the average record size, so a wildly
    // oversized response converges in a few iterations rather than one drop each.
    const perRecord = Math.max(1, Math.floor(text.length / kept))
    kept -= Math.max(1, Math.ceil((text.length - maxChars) / perRecord))
  }
  return build([], page.items.length)
}

/**
 * Drops the largest fields of a single record until it fits.
 *
 * Dropping whole fields rather than slicing the serialised JSON, which would cut
 * mid-string and hand the model text `JSON.parse` rejects. Biggest-first, so a
 * huge `lyrics` or `chord_chart` goes before anything small and identifying.
 */
function fitRecord(payload: unknown, maxChars: number): string {
  if (!payload || typeof payload !== 'object') {
    return serialize({
      truncated: {
        reason: `Response exceeded ${maxChars} characters.`,
        advice: 'Request fewer fields.',
      },
    })
  }

  const entries = Object.entries(payload as Record<string, unknown>).sort(
    (a, b) => serialize(b[1]).length - serialize(a[1]).length,
  )
  const dropped: string[] = []
  let kept = entries

  while (kept.length > 0) {
    const candidate = serialize({
      ...Object.fromEntries(kept),
      truncated: {
        dropped_fields: dropped,
        reason: `Response exceeded ${maxChars} characters.`,
        advice:
          'Request the dropped fields individually, or use the `fields` parameter to ask for less.',
      },
    })
    if (candidate.length <= maxChars) return candidate

    // Largest first, so identifying fields such as `id` survive longest.
    const [name] = kept[0]!
    dropped.push(name)
    kept = kept.slice(1)
  }

  return serialize({
    truncated: {
      dropped_fields: dropped,
      reason: `Response exceeded ${maxChars} characters.`,
      advice: 'Raise the response cap, or request fewer fields.',
    },
  })
}
