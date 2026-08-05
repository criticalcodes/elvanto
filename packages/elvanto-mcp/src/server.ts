import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js'
import {
  ElvantoApiError,
  ElvantoClient,
  ElvantoError,
  ElvantoRequestValidationError,
  ElvantoResponseValidationError,
  ElvantoTransportError,
  endpointIds,
  getEndpoint,
  isPageEndpoint,
  paramsJsonSchema,
  parseDebugMode,
  parseValidationMode,
  toMcpToolName,
  type DebugMode,
  type ElvantoClientOptions,
  type EndpointDefinition,
  type ValidationMode,
} from '@criticalcodes/elvanto'

export const SERVER_NAME = 'elvanto'
export const SERVER_VERSION = '0.1.0'

/**
 * Default records per page for tool calls that don't specify one.
 *
 * Elvanto's own default is 1000, which would flood a model's context on a
 * mid-sized account. Callers can still ask for more explicitly, up to Elvanto's
 * limit of 1000.
 */
export const DEFAULT_PAGE_SIZE = 25

/** Hard cap on the characters returned by one tool call. */
export const DEFAULT_MAX_RESPONSE_CHARS = 100_000

/**
 * Floor for the response cap. Below this there is no room for the truncation
 * notice itself, so the cap could not be honoured while still explaining why.
 */
export const MIN_MAX_RESPONSE_CHARS = 1_000

export interface ServerConfig {
  clientOptions?: ElvantoClientOptions
  defaultPageSize?: number
  maxResponseChars?: number
  /** Build the client lazily so the server starts without credentials. */
  createClient?: (options: ElvantoClientOptions) => ElvantoClient
}

/** Reads configuration from the environment, as an MCP server is launched. */
export function configFromEnv(
  env: Record<string, string | undefined> = process.env,
): ServerConfig {
  // Name the variable in the error: "Invalid validation mode" alone leaves the
  // operator guessing which entry in their MCP client config is wrong.
  const validate: ValidationMode | undefined = attributeTo(
    'ELVANTO_VALIDATE',
    () => parseValidationMode(env['ELVANTO_VALIDATE']),
  )
  const debug: DebugMode | undefined = attributeTo('ELVANTO_DEBUG', () =>
    parseDebugMode(env['ELVANTO_DEBUG']),
  )
  const pageSize = positiveInt(env['ELVANTO_MCP_PAGE_SIZE'])
  const maxChars = positiveInt(env['ELVANTO_MCP_MAX_RESPONSE_CHARS'])

  return {
    clientOptions: {
      ...(validate ? { validate } : {}),
      ...(debug ? { debug } : {}),
      ...(env['ELVANTO_BASE_URL'] ? { baseUrl: env['ELVANTO_BASE_URL'] } : {}),
      userAgent: `elvanto-mcp/${SERVER_VERSION}`,
      // stdout carries the MCP protocol, so diagnostics must go to stderr.
      onWarning: (warning) => {
        process.stderr.write(`[elvanto-mcp] ${warning.message}\n`)
      },
    },
    ...(pageSize !== undefined ? { defaultPageSize: pageSize } : {}),
    ...(maxChars !== undefined ? { maxResponseChars: maxChars } : {}),
  }
}

/** Prefixes a parse failure with the environment variable responsible. */
function attributeTo<T>(variable: string, parse: () => T): T {
  try {
    return parse()
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new ElvantoError(`${variable}: ${detail}`)
  }
}

function positiveInt(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === '') return undefined
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined
}

/** The tool definitions advertised to the client, one per read-only endpoint. */
export function buildTools(defaultPageSize = DEFAULT_PAGE_SIZE): Tool[] {
  return endpointIds.map((id) => {
    const endpoint = getEndpoint(id)
    return {
      name: toMcpToolName(id),
      description: toolDescription(endpoint, defaultPageSize),
      inputSchema: paramsJsonSchema(endpoint) as Tool['inputSchema'],
      annotations: {
        title: endpoint.summary,
        readOnlyHint: true,
        // Nothing here mutates Elvanto, so a repeat call is always safe.
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    }
  })
}

/** Exported for unit testing against synthetic endpoints. */
export function toolDescription(
  endpoint: EndpointDefinition,
  defaultPageSize: number,
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
  if (endpoint.auth === 'oauth-only') {
    parts.push('Requires OAuth; unavailable when the server is configured with an API key.')
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

/**
 * Builds the MCP server.
 *
 * The Elvanto client is created on the first call rather than at startup, so a
 * misconfigured server still lists its tools and reports a readable error
 * instead of dying before the handshake.
 */
export function createServer(config: ServerConfig = {}): Server {
  const defaultPageSize = config.defaultPageSize ?? DEFAULT_PAGE_SIZE
  const maxResponseChars = Math.max(
    config.maxResponseChars ?? DEFAULT_MAX_RESPONSE_CHARS,
    MIN_MAX_RESPONSE_CHARS,
  )
  const tools = buildTools(defaultPageSize)
  const byToolName = new Map(
    endpointIds.map((id) => [toMcpToolName(id), getEndpoint(id)]),
  )

  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} } },
  )

  let client: ElvantoClient | undefined
  const getClient = (): ElvantoClient => {
    if (!client) {
      const factory =
        config.createClient ?? ((options) => new ElvantoClient(options))
      client = factory(config.clientOptions ?? {})
    }
    return client
  }

  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools }))

  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
    const endpoint = byToolName.get(request.params.name)
    if (!endpoint) {
      return errorResult(
        `Unknown tool "${request.params.name}". Call tools/list for the available tools.`,
      )
    }

    const args: Record<string, unknown> = { ...(request.params.arguments ?? {}) }
    if (
      isPageEndpoint(endpoint) &&
      'page_size' in endpoint.params.shape &&
      args['page_size'] === undefined
    ) {
      args['page_size'] = defaultPageSize
    }

    try {
      const result = await getClient().call(endpoint.id as never, args as never)
      return okResult(result, maxResponseChars)
    } catch (error) {
      return errorResult(describeError(error))
    }
  })

  return server
}

/**
 * Serialises a result for the model.
 *
 * Page results are rewritten into snake_case keys matching Elvanto's own
 * vocabulary, so a model reading the tool description sees the same names in the
 * response.
 */
function okResult(result: unknown, maxChars: number): CallToolResult {
  const payload = isPageResult(result)
    ? {
        total: result.total,
        page: result.page,
        per_page: result.perPage,
        returned: result.items.length,
        has_more: result.hasMore,
        items: result.items,
      }
    : result

  return { content: [{ type: 'text', text: fitToBudget(payload, maxChars) }] }
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

const serialize = (value: unknown): string => JSON.stringify(value, null, 2)

/**
 * Serialises a payload within a character budget, saying what it dropped.
 *
 * Every candidate is measured after serialisation rather than estimated, because
 * an estimate has to guess the indentation depth each record will end up at and
 * the size of the truncation notice itself — get either wrong and the "cap" is
 * exceeded. Silent truncation is the real hazard here: a short result reads as a
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
 * The previous approach sliced the serialised JSON, which cut mid-string and
 * handed the model text that `JSON.parse` rejects. Dropping whole fields keeps
 * the result parseable, and drops biggest-first so a huge `lyrics` or
 * `chord_chart` goes before anything small and identifying.
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
      advice: 'Raise ELVANTO_MCP_MAX_RESPONSE_CHARS, or request fewer fields.',
    },
  })
}

function errorResult(message: string): CallToolResult {
  return { content: [{ type: 'text', text: message }], isError: true }
}

/**
 * Turns an error into something a model can act on: what went wrong, and what
 * to do differently.
 */
export function describeError(error: unknown): string {
  if (error instanceof ElvantoRequestValidationError) {
    return `Invalid arguments. ${error.message}`
  }
  if (error instanceof ElvantoResponseValidationError) {
    return (
      `Elvanto returned a response this server does not recognise. ${error.message}\n\n` +
      `This is a limitation of the server, not of the request. Whoever runs it can ` +
      `set ELVANTO_VALIDATE=warn to accept unrecognised responses.`
    )
  }
  if (error instanceof ElvantoApiError) {
    if (error.isAuthError) {
      return (
        `Elvanto rejected the credentials (${error.message}). The server needs a ` +
        `valid ELVANTO_API_KEY. This cannot be fixed by changing the request.`
      )
    }
    if (error.isNotFound) {
      return (
        `Nothing matched (${error.message}). Elvanto returns this both for an ID ` +
        `that does not exist and for filters that match no records.`
      )
    }
    if (error.isRateLimited) {
      return `Elvanto is rate limiting requests (${error.message}). Wait before retrying.`
    }
    return `Elvanto returned an error: ${error.message}`
  }
  if (error instanceof ElvantoTransportError) {
    return `Could not reach Elvanto: ${error.message}`
  }
  if (error instanceof ElvantoError) {
    return error.message
  }
  return error instanceof Error ? error.message : String(error)
}
