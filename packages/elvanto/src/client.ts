import { z } from 'zod'
import {
  ElvantoApiError,
  ElvantoError,
  ElvantoRequestValidationError,
  ElvantoResponseValidationError,
  type ValidationIssue,
} from './errors.js'
import {
  Transport,
  type ElvantoClientOptions,
  type ElvantoValidationWarning,
  type RequestOptions,
  type ValidationMode,
} from './http.js'
import { isEmptySingle, pageSchema, singleSchema, type Page } from './normalize.js'
import {
  endpoints,
  getEndpoint,
  type EndpointDefinition,
  type EndpointId,
  type EndpointRegistry,
  type PageEndpointId,
  type ParamsOf,
  type RecordOf,
} from './registry.js'

/** What an endpoint resolves to: a page of records, or a single record. */
export type ResultOf<K extends EndpointId> =
  EndpointRegistry[K]['result'] extends { kind: 'page' }
    ? Page<RecordOf<K>>
    : RecordOf<K>

export interface PaginateOptions extends RequestOptions {
  /** Stop after this many pages. */
  maxPages?: number
  /** Stop once this many records have been yielded. */
  maxRecords?: number
}

/**
 * A typed, read-only client for the Elvanto API.
 *
 * ```ts
 * const client = new ElvantoClient({ auth: { apiKey: process.env.ELVANTO_API_KEY! } })
 * const people = await client.people.getAll({ page_size: 100, fields: ['birthday'] })
 * ```
 *
 * Every method is a thin binding over {@link call}, which resolves the endpoint
 * in the registry, validates parameters, normalizes the response and applies the
 * configured validation mode.
 */
export class ElvantoClient {
  private readonly transport: Transport
  private readonly defaultValidate: ValidationMode
  private readonly warn: (warning: ElvantoValidationWarning) => void

  constructor(options: ElvantoClientOptions = {}) {
    this.transport = new Transport(options)
    this.defaultValidate = this.transport.validationMode
    this.warn =
      this.transport.onWarning ??
      ((warning) => {
        // stderr, so this never corrupts CLI stdout or the MCP stdio channel.
        console.warn(`[elvanto] ${warning.message}`)
      })
  }

  /**
   * Calls any endpoint by its registry id.
   *
   * Prefer the namespaced methods (`client.people.getAll(...)`) — they are
   * exactly this, with the id filled in. Use `call` when the endpoint is chosen
   * at runtime.
   */
  async call<K extends EndpointId>(
    id: K,
    params?: ParamsOf<K>,
    options: RequestOptions = {},
  ): Promise<ResultOf<K>> {
    const endpoint: EndpointDefinition = getEndpoint(id)

    if (endpoint.auth === 'oauth-only' && this.transport.usesApiKey) {
      throw new ElvantoError(
        `${id} requires OAuth authentication. Elvanto does not support it with ` +
          `an API key, because a key identifies an account rather than a user.`,
      )
    }

    const parsedParams = endpoint.params.safeParse(params ?? {})
    if (!parsedParams.success) {
      throw new ElvantoRequestValidationError({
        endpoint: id,
        issues: toIssues(parsedParams.error),
      })
    }

    const body = options.extraParams
      ? { ...(parsedParams.data as Record<string, unknown>), ...options.extraParams }
      : (parsedParams.data as Record<string, unknown>)

    const envelope = await this.transport.request(endpoint.path, body, options)

    const mode = options.validate ?? this.defaultValidate
    const result = this.extract(id, endpoint, envelope, mode) as ResultOf<K>

    const log = this.transport.logging
    if (log.enabled) {
      const page = result as unknown as Page<unknown>
      log.log({
        level: 'debug',
        event: 'result',
        endpoint: id,
        message: endpoint.result.kind === 'page' ? 'page' : 'record',
        data:
          endpoint.result.kind === 'page'
            ? { returned: page.items.length, total: page.total, page: page.page, hasMore: page.hasMore }
            : { validate: mode },
      })
    }

    return result
  }

  /**
   * Walks every page of a paginated endpoint, yielding records one at a time.
   *
   * ```ts
   * for await (const person of client.paginate('people.getAll')) { … }
   * ```
   *
   * Unlike a direct call, this treats Elvanto's "no records match your
   * criteria" 404 as an empty result rather than an error, so an unmatched
   * query yields nothing instead of throwing.
   */
  async *paginate<K extends PageEndpointId>(
    id: K,
    params?: ParamsOf<K>,
    options: PaginateOptions = {},
  ): AsyncGenerator<RecordOf<K>, void, undefined> {
    const { maxPages, maxRecords, ...requestOptions } = options
    const startParams = (params ?? {}) as Record<string, unknown>
    let page = typeof startParams['page'] === 'number' ? startParams['page'] : 1
    let emitted = 0
    let pagesFetched = 0

    for (;;) {
      if (maxPages !== undefined && pagesFetched >= maxPages) return

      let result: Page<RecordOf<K>>
      try {
        result = (await this.call(
          id,
          { ...startParams, page } as ParamsOf<K>,
          requestOptions,
        )) as Page<RecordOf<K>>
      } catch (error) {
        // Elvanto answers 404 for "nothing matched", which is not an error when
        // iterating. A 404 on a later page means we ran off the end.
        if (error instanceof ElvantoApiError && error.isNotFound) return
        throw error
      }
      pagesFetched++

      for (const item of result.items) {
        yield item
        emitted++
        if (maxRecords !== undefined && emitted >= maxRecords) return
      }

      if (!result.hasMore || result.items.length === 0) return
      page = result.page + 1
    }
  }

  /**
   * Collects every record from a paginated endpoint into an array.
   *
   * Convenient, but unbounded by default — an account with 50,000 people will
   * load 50,000 records into memory. Pass `maxRecords` to cap it, or use
   * {@link paginate} to stream.
   */
  async fetchAll<K extends PageEndpointId>(
    id: K,
    params?: ParamsOf<K>,
    options: PaginateOptions = {},
  ): Promise<RecordOf<K>[]> {
    const out: RecordOf<K>[] = []
    for await (const item of this.paginate(id, params, options)) {
      out.push(item)
    }
    return out
  }

  /**
   * Pulls the payload out of the envelope, normalizes its shape and applies the
   * validation mode.
   *
   * Structural normalization (unwrapping singular-key collections, collapsing
   * one-element single-record arrays) always happens, including when validation
   * is off — only the per-field schema is skipped.
   */
  private extract(
    id: string,
    endpoint: EndpointDefinition,
    envelope: Record<string, unknown>,
    mode: ValidationMode,
  ): unknown {
    const shape = endpoint.result

    if (shape.kind === 'page') {
      const raw = envelope[shape.collectionKey]
      if (raw === undefined) {
        // A successful response that lacks the documented collection key.
        this.report(id, mode, [
          {
            path: shape.collectionKey,
            message: `expected a "${shape.collectionKey}" collection in the response, got keys: ${Object.keys(envelope).join(', ')}`,
          },
        ], envelope)
        return emptyPage()
      }
      const structural = pageSchema(shape.itemKey, z.unknown())
      if (mode === 'off') return structural.parse(raw)

      const strict = pageSchema(shape.itemKey, shape.item)
      const result = strict.safeParse(raw)
      if (result.success) return result.data

      this.report(id, mode, toIssues(result.error, shape.collectionKey), raw)

      // Salvage per record rather than abandoning the whole page. One unexpected
      // field on one record would otherwise cost every other record its
      // normalization — booleans staying as 1/0, quoted numbers staying strings —
      // which is a surprising penalty for the mode whose job is to keep working
      // when a schema is imperfect.
      const page = structural.parse(raw) as Page<unknown>
      return {
        ...page,
        items: page.items.map((item) => {
          const parsed = shape.item.safeParse(item)
          return parsed.success ? parsed.data : item
        }),
      }
    }

    const raw = envelope[shape.key]
    if (isEmptySingle(raw)) {
      throw new ElvantoApiError({
        message: `returned no "${shape.key}" record`,
        httpStatus: 404,
        endpoint: id,
        body: envelope,
      })
    }
    const structural = singleSchema(z.unknown())
    if (mode === 'off') return structural.parse(raw)

    const result = singleSchema(shape.item).safeParse(raw)
    if (result.success) return result.data

    this.report(id, mode, toIssues(result.error, shape.key), raw)
    return structural.parse(raw)
  }

  /** Raises or reports a response-shape mismatch according to the mode. */
  private report(
    id: string,
    mode: ValidationMode,
    issues: ValidationIssue[],
    data: unknown,
  ): void {
    if (mode === 'throw') {
      throw new ElvantoResponseValidationError({ endpoint: id, issues, data })
    }
    if (mode === 'warn') {
      const summary = issues
        .slice(0, 3)
        .map((i) => `${i.path || '(root)'}: ${i.message}`)
        .join('; ')
      const log = this.transport.logging
      if (log.enabled) {
        log.log({
          level: 'warn',
          event: 'schema-mismatch',
          endpoint: id,
          message: `${issues.length} issue(s), using the raw response`,
          // Paths only: an issue path names a field, never its value.
          data: { paths: issues.slice(0, 10).map((issue) => issue.path) },
        })
      }
      this.warn({
        endpoint: id,
        message:
          `${id} returned an unexpected shape (${issues.length} issue${issues.length === 1 ? '' : 's'}): ` +
          `${summary}. Using the raw response.`,
        issues,
        data,
      })
    }
  }

  // ── Namespaced methods ────────────────────────────────────────────────────
  // One line per registry entry. A typo in an id is a compile error, and
  // client.test.ts asserts every registry endpoint is reachable here.

  readonly people = {
    getAll: (params?: ParamsOf<'people.getAll'>, options?: RequestOptions) =>
      this.call('people.getAll', params, options),
    search: (params: ParamsOf<'people.search'>, options?: RequestOptions) =>
      this.call('people.search', params, options),
    getInfo: (params: ParamsOf<'people.getInfo'>, options?: RequestOptions) =>
      this.call('people.getInfo', params, options),
    /** OAuth only — throws when the client is authenticated with an API key. */
    currentUser: (options?: RequestOptions) =>
      this.call('people.currentUser', {}, options),
    categories: {
      getAll: (options?: RequestOptions) =>
        this.call('people.categories.getAll', {}, options),
    },
    customFields: {
      getAll: (options?: RequestOptions) =>
        this.call('people.customFields.getAll', {}, options),
    },
  } as const

  readonly peopleFlows = {
    getAll: (options?: RequestOptions) =>
      this.call('peopleFlows.getAll', {}, options),
    steps: {
      getAll: (
        params: ParamsOf<'peopleFlows.steps.getAll'>,
        options?: RequestOptions,
      ) => this.call('peopleFlows.steps.getAll', params, options),
      people: (
        params: ParamsOf<'peopleFlows.steps.people'>,
        options?: RequestOptions,
      ) => this.call('peopleFlows.steps.people', params, options),
    },
  } as const

  readonly groups = {
    getAll: (params?: ParamsOf<'groups.getAll'>, options?: RequestOptions) =>
      this.call('groups.getAll', params, options),
    getInfo: (params: ParamsOf<'groups.getInfo'>, options?: RequestOptions) =>
      this.call('groups.getInfo', params, options),
  } as const

  readonly services = {
    getAll: (params?: ParamsOf<'services.getAll'>, options?: RequestOptions) =>
      this.call('services.getAll', params, options),
    getInfo: (params: ParamsOf<'services.getInfo'>, options?: RequestOptions) =>
      this.call('services.getInfo', params, options),
  } as const

  readonly songs = {
    getAll: (params?: ParamsOf<'songs.getAll'>, options?: RequestOptions) =>
      this.call('songs.getAll', params, options),
    getInfo: (params: ParamsOf<'songs.getInfo'>, options?: RequestOptions) =>
      this.call('songs.getInfo', params, options),
    categories: {
      getAll: (
        params?: ParamsOf<'songs.categories.getAll'>,
        options?: RequestOptions,
      ) => this.call('songs.categories.getAll', params, options),
    },
    arrangements: {
      getAll: (
        params: ParamsOf<'songs.arrangements.getAll'>,
        options?: RequestOptions,
      ) => this.call('songs.arrangements.getAll', params, options),
      getInfo: (
        params: ParamsOf<'songs.arrangements.getInfo'>,
        options?: RequestOptions,
      ) => this.call('songs.arrangements.getInfo', params, options),
    },
    keys: {
      getAll: (
        params: ParamsOf<'songs.keys.getAll'>,
        options?: RequestOptions,
      ) => this.call('songs.keys.getAll', params, options),
      getInfo: (
        params: ParamsOf<'songs.keys.getInfo'>,
        options?: RequestOptions,
      ) => this.call('songs.keys.getInfo', params, options),
    },
  } as const

  readonly calendar = {
    getAll: (options?: RequestOptions) =>
      this.call('calendar.getAll', {}, options),
    events: {
      getAll: (
        params: ParamsOf<'calendar.events.getAll'>,
        options?: RequestOptions,
      ) => this.call('calendar.events.getAll', params, options),
    },
  } as const

  readonly financial = {
    transactions: {
      getAll: (
        params: ParamsOf<'financial.transactions.getAll'>,
        options?: RequestOptions,
      ) => this.call('financial.transactions.getAll', params, options),
      getInfo: (
        params: ParamsOf<'financial.transactions.getInfo'>,
        options?: RequestOptions,
      ) => this.call('financial.transactions.getInfo', params, options),
    },
    categories: {
      getAll: (
        params?: ParamsOf<'financial.categories.getAll'>,
        options?: RequestOptions,
      ) => this.call('financial.categories.getAll', params, options),
    },
  } as const
}

/** Convenience factory, for `createClient({ apiKey })` over `new`. */
export function createClient(options: ElvantoClientOptions = {}): ElvantoClient {
  return new ElvantoClient(options)
}

function emptyPage(): Page<never> {
  return { items: [], page: 1, perPage: 0, onThisPage: 0, total: 0, hasMore: false }
}

function toIssues(error: z.ZodError, prefix?: string): ValidationIssue[] {
  return error.issues.map((issue) => {
    const path = issue.path.map(String).join('.')
    return {
      path: prefix ? [prefix, path].filter(Boolean).join('.') : path,
      message: issue.message,
    }
  })
}

/** The registry, re-exported for tooling that enumerates endpoints. */
export { endpoints }
