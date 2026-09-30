import { defineTool, type ToolDefinition } from '@flue/runtime'
import * as v from 'valibot'
import {
  DEFAULT_MAX_RESPONSE_CHARS,
  DEFAULT_PAGE_SIZE,
  MIN_MAX_RESPONSE_CHARS,
  describeParams,
  readEndpointIds,
  endpointToolDescription,
  fitToBudget,
  getEndpoint,
  toMcpToolName,
  toModelPayload,
  withDefaultPageSize,
  type EndpointDefinition,
  type ReadEndpointId,
  type ParamDescriptor,
} from '@criticalcodes/elvanto'
import { clientOf, type ToolDeps } from './kit.ts'

/**
 * The 25 read-only Elvanto endpoints, as native Flue tools.
 *
 * ## Why not just connect the MCP server
 *
 * Because for an agent that already has the SDK loaded, MCP is a round trip to
 * nowhere: serialise the call to JSON-RPC, push it over a socket to a second
 * process, and have that process call the same `client.call()` this one could have
 * called directly. It costs a port, a bearer token, a process to supervise, and a
 * failure mode — and buys nothing, because the MCP server's tools are generated
 * from the same registry these are.
 *
 * MCP earns its keep when the *host* is somebody else's: Claude Desktop, a remote
 * connector, another framework. `@criticalcodes/elvanto-mcp` is still the right
 * answer there. It is the wrong answer for talking to yourself.
 *
 * Names and descriptions are identical to the MCP surface — same
 * `toMcpToolName`, same {@link endpointToolDescription} — so an instruction, an
 * allowlist or a transcript reads the same either way.
 *
 * ## On the Valibot schemas
 *
 * Flue presents a tool's `input` schema to the model as JSON Schema, so the schema
 * has to *describe* the parameters, and these are generated from the registry's
 * own {@link describeParams}. They are not the authority on validity: the SDK
 * validates request parameters strictly on every call, and it is the single source
 * of truth. Mirroring every zod refinement here would be duplication that could
 * drift, so a rule these schemas miss is caught one layer down and returned to the
 * model as a readable error.
 */

export interface EndpointToolOptions {
  /** Records per page when the model doesn't say. Defaults to 25, not Elvanto's 1000. */
  defaultPageSize?: number
  /** Characters one result may serialise to. Defaults to 100,000. */
  maxResponseChars?: number
}

/**
 * Builds the Valibot schema for one parameter.
 *
 * The kinds come from `describeParams`, whose classification is exhaustive over
 * Elvanto's parameter vocabulary. `unknown` is the deliberate fallback: an
 * unrecognised parameter is exposed as a free-form value rather than silently
 * dropped, which is the same choice the CLI makes.
 */
function schemaForParam(param: ParamDescriptor): v.GenericSchema {
  const described = <S extends v.GenericSchema>(schema: S) =>
    param.description ? v.pipe(schema, v.description(param.description)) : schema

  switch (param.kind) {
    case 'enum':
      // `choices` is always present for this kind, but fall back rather than
      // assert — an empty picklist would reject every value.
      return described(
        param.choices?.length
          ? v.picklist(param.choices)
          : (v.string() as unknown as v.GenericSchema),
      ) as v.GenericSchema
    case 'integer':
      return described(v.pipe(v.number(), v.integer())) as v.GenericSchema
    case 'boolean':
      return described(v.boolean()) as v.GenericSchema
    case 'string-array':
      return described(v.array(v.string())) as v.GenericSchema
    case 'string-or-array':
      return described(v.union([v.string(), v.array(v.string())])) as v.GenericSchema
    case 'record':
      return described(
        v.record(v.string(), v.union([v.string(), v.number(), v.boolean()])),
      ) as v.GenericSchema
    case 'string':
      return described(v.string()) as v.GenericSchema
    case 'unknown':
      return described(v.unknown()) as v.GenericSchema
  }
}

/** Exported for tests: the generated schema is the model's whole view of an endpoint. */
export function inputSchemaFor(endpoint: EndpointDefinition): v.GenericSchema<
  Record<string, unknown>,
  unknown
> {
  const entries: Record<string, v.GenericSchema> = {}
  for (const param of describeParams(endpoint)) {
    const schema = schemaForParam(param)
    entries[param.name] = param.required ? schema : v.optional(schema)
  }
  // Flue requires a top-level object schema, including for the endpoints that
  // take no parameters at all.
  return v.object(entries) as unknown as v.GenericSchema<Record<string, unknown>, unknown>
}

/** One endpoint, as a Flue tool. */
export function endpointTool(
  deps: ToolDeps,
  id: ReadEndpointId,
  options: EndpointToolOptions = {},
): ToolDefinition {
  const endpoint = getEndpoint(id)
  const getClient = clientOf(deps)
  const defaultPageSize = options.defaultPageSize ?? DEFAULT_PAGE_SIZE
  const maxChars = Math.max(
    options.maxResponseChars ?? DEFAULT_MAX_RESPONSE_CHARS,
    MIN_MAX_RESPONSE_CHARS,
  )

  return defineTool({
    name: toMcpToolName(id),
    description: endpointToolDescription(endpoint, defaultPageSize),
    input: inputSchemaFor(endpoint),
    async run({ data, log, signal }) {
      const args = withDefaultPageSize(
        endpoint,
        data as Record<string, unknown>,
        defaultPageSize,
      )

      const result = await getClient().call(id as never, args as never, signal ? { signal } : {})

      // Counts only. Parameter values can carry search terms and record ids, and
      // these lines may be persisted by the runtime.
      log.info(`${toMcpToolName(id)}: ok`)

      // Serialised here rather than handed over as an object, because the budget
      // can only be enforced against the actual serialisation — the same reason
      // the MCP server does it this way.
      return { output: fitToBudget(toModelPayload(result), maxChars) }
    },
  })
}

/**
 * The endpoints mounted by default, alongside the purpose-built tools.
 *
 * Chosen to *add* to them rather than duplicate them, with three deliberate
 * omissions:
 *
 * - **Every financial endpoint.** Individual giving records are the most
 *   sensitive data an API key reaches, and an agent runtime persists tool
 *   results. Opt in with `'all'` or an explicit list.
 * - **`people.search`.** `find_person` does the same job with a search strategy
 *   and a compact result; offering both invites the model to pick the harder one.
 * - **`people.currentUser`.** OAuth-only, so with an API key it can only fail.
 */
export const CORE_ENDPOINTS: readonly ReadEndpointId[] = [
  'people.getAll',
  'people.getInfo',
  'people.categories.getAll',
  'groups.getAll',
  'groups.getInfo',
  'services.getAll',
  'songs.getAll',
  'songs.getInfo',
  'calendar.events.getAll',
]

/**
 * Every read-only endpoint, financial included.
 *
 * Writes are excluded by type as well as by value: this toolkit reads and
 * reports, and handing a model the ability to change the account should be a
 * deliberate design, not a preset. See the README's Roadmap.
 */
export const ALL_ENDPOINTS: readonly ReadEndpointId[] = readEndpointIds

/** Which endpoints to mount: a preset, an explicit list, or none. */
export type EndpointSelection = 'core' | 'all' | readonly ReadEndpointId[] | false

export function resolveEndpoints(selection: EndpointSelection): readonly ReadEndpointId[] {
  if (selection === false) return []
  if (selection === 'core') return CORE_ENDPOINTS
  if (selection === 'all') return ALL_ENDPOINTS
  return selection
}

/** Builds a tool per selected endpoint. */
export function endpointTools(
  deps: ToolDeps,
  selection: EndpointSelection = 'core',
  options: EndpointToolOptions = {},
): ToolDefinition[] {
  return resolveEndpoints(selection).map((id) => endpointTool(deps, id, options))
}
