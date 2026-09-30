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
  ElvantoWriteOutcomeUnknownError,
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
  parsePeopleUpdateRequest,
  peopleUpdateRequestJsonSchema,
  toMcpToolName,
  updatePeople,
  type DebugMode,
  type ElvantoClientOptions,
  type EndpointDefinition,
  type EndpointId,
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

/**
 * Which writes the server exposes.
 *
 * - `off` (default) — reads only. Write tools are not listed and cannot be
 *   called, so a server configured before writes existed does not gain them.
 * - `write` — adds creates, edits and memberships that another call can undo.
 * - `all` — adds the destructive ones too: deleting people and groups, removing
 *   memberships, and `people.edit`, which can detach a person from a family.
 */
export type WriteLevel = 'off' | 'write' | 'all'

/** Parses `ELVANTO_MCP_WRITES`. Absent means `off`; anything unknown throws. */
export function parseWriteLevel(value: string | undefined): WriteLevel {
  if (value == null || value.trim() === '') return 'off'
  const v = value.trim().toLowerCase()
  if (v === 'off' || v === 'write' || v === 'all') return v
  throw new ElvantoError(
    `Invalid write level "${value}". Expected "off", "write" or "all".`,
  )
}

/** The endpoints exposed at a write level. */
export function exposedEndpointIds(level: WriteLevel): EndpointId[] {
  return endpointIds.filter((id) => {
    const { effect } = getEndpoint(id)
    if (effect === 'read') return true
    if (effect === 'write') return level !== 'off'
    return level === 'all'
  })
}

export interface ServerConfig {
  clientOptions?: ElvantoClientOptions
  /** Which writes to expose. Default `off`. */
  writes?: WriteLevel
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
  const writes = attributeTo('ELVANTO_MCP_WRITES', () =>
    parseWriteLevel(env['ELVANTO_MCP_WRITES']),
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
    writes,
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

/** The tool definitions advertised to the client, one per exposed endpoint. */
export function buildTools(
  defaultPageSize = DEFAULT_PAGE_SIZE,
  writes: WriteLevel = 'off',
): Tool[] {
  const tools: Tool[] = exposedEndpointIds(writes).map((id) => {
    const endpoint = getEndpoint(id)
    return {
      name: toMcpToolName(id),
      description: toolDescription(endpoint, defaultPageSize),
      inputSchema: paramsJsonSchema(endpoint) as Tool['inputSchema'],
      annotations: { title: endpoint.summary, ...hintsFor(endpoint), openWorldHint: true },
    }
  })
  if (writes !== 'off') tools.push(PEOPLE_UPDATE_TOOL)
  return tools
}

/**
 * Batch changes to people, dry run by default. See `updatePeople` in the SDK.
 *
 * Not an endpoint, so not in the registry: it composes reads and edits into the
 * one thing `people.edit` cannot do safely — add or remove a multi-select option
 * without replacing the rest. Offered at the `write` level, because it cannot
 * touch the family, name or login fields that make `people_edit` destructive, and
 * because it writes nothing unless asked to after a dry run.
 */
export const PEOPLE_UPDATE_TOOL_NAME = 'elvanto_people_update'

const PEOPLE_UPDATE_TOOL: Tool = {
  name: PEOPLE_UPDATE_TOOL_NAME,
  description:
    'Change several people at once: add or remove multi-select options (e.g. ' +
    'positions) without disturbing the others, and set email, people category, or ' +
    'text, date and single-select custom fields. People are addressed by Elvanto ' +
    'ID only — resolve names with elvanto_people_search first, and ask the user ' +
    'about any name that matches none or several people rather than guessing. ' +
    'By default this is a DRY RUN: it reads each person and returns every ' +
    'field\'s before and after, writing nothing. Show that to the user, and call ' +
    'again with apply: true only once they approve. Applying re-reads each person, ' +
    'writes, and reads back, reporting per person whether the change landed ' +
    '(applied, partly-applied, not-applied). If any update is invalid, nothing is ' +
    'written. Use elvanto_people_custom_fields_get_all to see field names and ' +
    'options.',
  inputSchema: peopleUpdateRequestJsonSchema() as Tool['inputSchema'],
  annotations: {
    title: 'Update people (dry run by default)',
    readOnlyHint: false,
    // It overwrites values when applied; the dry run is the guard, and a client
    // that asks before destructive calls should ask here too.
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  },
}

/**
 * MCP's behaviour hints, from the endpoint's effect. Clients use these to decide
 * what to ask the user before calling.
 *
 * Only reads are idempotent. `edit` and `addPerson` would repeat harmlessly in
 * isolation, but not after someone else's change in between, and a hint that
 * invites automatic retries is the wrong default for a write.
 */
function hintsFor(endpoint: EndpointDefinition): Tool['annotations'] {
  switch (endpoint.effect) {
    case 'read':
      return { readOnlyHint: true, destructiveHint: false, idempotentHint: true }
    case 'write':
      return { readOnlyHint: false, destructiveHint: false, idempotentHint: false }
    case 'destructive':
      return { readOnlyHint: false, destructiveHint: true, idempotentHint: false }
  }
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
  const writes = config.writes ?? 'off'
  const tools = buildTools(defaultPageSize, writes)
  // Built from the same filter as the listing, so an unlisted write tool is also
  // uncallable — a client that guesses its name gets "unknown tool".
  const byToolName = new Map(
    exposedEndpointIds(writes).map((id) => [toMcpToolName(id), getEndpoint(id)]),
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
    if (request.params.name === PEOPLE_UPDATE_TOOL_NAME && writes !== 'off') {
      const parsed = parsePeopleUpdateRequest(request.params.arguments)
      if (!parsed.ok) return errorResult(`Invalid arguments. ${parsed.message}`)
      try {
        return okResult(await updatePeople(getClient(), parsed.request), maxResponseChars)
      } catch (error) {
        return errorResult(describeError(error))
      }
    }

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
  if (error instanceof ElvantoWriteOutcomeUnknownError) {
    return (
      `${error.message} Tell the user it is unclear whether the change was made, ` +
      `and read the record to find out before calling this tool again.`
    )
  }
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
        `Elvanto rejected the credentials (${error.message}). Whoever runs this ` +
        `server needs to supply a valid ELVANTO_API_KEY, or sign in again with ` +
        `\`elvanto login\` if it is using a stored OAuth grant — a grant can be ` +
        `revoked from Elvanto's own settings. This cannot be fixed by changing ` +
        `the request, so do not retry it.`
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
