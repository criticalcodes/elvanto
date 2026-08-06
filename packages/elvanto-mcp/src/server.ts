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
  endpointToolDescription,
  fitToBudget as fitPayloadToBudget,
  toModelPayload,
  withDefaultPageSize,
  DEFAULT_PAGE_SIZE as SHARED_DEFAULT_PAGE_SIZE,
  DEFAULT_MAX_RESPONSE_CHARS as SHARED_MAX_RESPONSE_CHARS,
  MIN_MAX_RESPONSE_CHARS as SHARED_MIN_RESPONSE_CHARS,
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
 * Response and paging limits, re-exported from the SDK.
 *
 * They live there because the agent toolkit needs exactly the same numbers and
 * the same truncation behaviour — a model that sees a 25-record page on one
 * surface and a 1000-record page on another is being told two different things
 * about the same API.
 */
export const DEFAULT_PAGE_SIZE = SHARED_DEFAULT_PAGE_SIZE
export const DEFAULT_MAX_RESPONSE_CHARS = SHARED_MAX_RESPONSE_CHARS
export const MIN_MAX_RESPONSE_CHARS = SHARED_MIN_RESPONSE_CHARS

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

/**
 * Kept as a named export because this package's tests and consumers use it;
 * the text itself is the SDK's, so both surfaces describe an endpoint alike.
 */
export function toolDescription(
  endpoint: EndpointDefinition,
  defaultPageSize: number,
): string {
  return endpointToolDescription(endpoint, defaultPageSize)
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

    const args = withDefaultPageSize(
      endpoint,
      { ...(request.params.arguments ?? {}) },
      defaultPageSize,
    )

    try {
      const result = await getClient().call(endpoint.id as never, args as never)
      return okResult(result, maxResponseChars)
    } catch (error) {
      return errorResult(describeError(error))
    }
  })

  return server
}

/** Serialises a result for the model, within the configured budget. */
function okResult(result: unknown, maxChars: number): CallToolResult {
  return { content: [{ type: 'text', text: fitToBudget(result, maxChars) }] }
}

/**
 * Re-exported for this package's tests, which assert the truncation contract
 * directly. The implementation is shared with the agent toolkit.
 */
export function fitToBudget(payload: unknown, maxChars: number): string {
  return fitPayloadToBudget(toModelPayload(payload), maxChars)
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
