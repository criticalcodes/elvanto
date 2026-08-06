/**
 * A Flue agent toolkit for the Elvanto church management API.
 *
 * Ships the parts an agent is made of — tools, an MCP connection and a
 * composition hook — rather than an agent. That is not a design preference: Flue
 * discovers agents by scanning a project's own source root for `'use agent'`
 * modules, so an agent function imported from a package is never registered. The
 * agent module has to be local; everything it composes can be shared.
 *
 * ```ts
 * 'use agent'
 * import { useModel } from '@flue/runtime'
 * import { useElvantoBase } from '@criticalcodes/elvanto-agent'
 *
 * export function Church() {
 *   useModel('anthropic/claude-sonnet-5')
 *   useElvantoBase()
 *   return 'You help our staff with rosters and member admin.'
 * }
 * ```
 *
 * `src/agents/elvanto.ts` in this package is a working example of exactly that,
 * and is published in the tarball so it can be copied.
 *
 * @packageDocumentation
 */

export { useElvantoBase, baseInstruction, type ElvantoBaseOptions } from './base.ts'

export {
  ALL_ENDPOINTS,
  CORE_ENDPOINTS,
  endpointTool,
  endpointTools,
  inputSchemaFor,
  resolveEndpoints,
  type EndpointSelection,
  type EndpointToolOptions,
} from './tools/endpoints.ts'

// Kept for connecting a genuinely remote MCP server. Reaching Elvanto no longer
// needs one — `endpointTools` mounts the same endpoints in-process.
export {
  ALL_MCP_TOOLS,
  CORE_MCP_TOOLS,
  elvantoMcpConnection,
  type ElvantoMcpOptions,
} from './mcp.ts'

export { ambientEnv, clientFromEnv, type Env } from './client.ts'

export {
  ALL_TOOL_NAMES,
  TOOL_FACTORIES,
  createElvantoTools,
  findPerson,
  listCustomFields,
  nextServing,
  roster,
  serviceBrief,
  songHistory,
  type ElvantoToolName,
  type ToolDeps,
} from './tools/index.ts'

// The shaping helpers, exported because anything built on top will want the same
// compact forms — a credential report keyed by person should use the same person
// card shape the rest of the toolkit returns.
export {
  addDays,
  daysBetween,
  displayName,
  isoDate,
  laterOf,
  parseElvantoDate,
  personCard,
  rosterEntries,
  serviceHeader,
  type PersonCard,
  type RosterEntry,
  type ServiceHeader,
} from './shape.ts'

export { cap, type Capped } from './tools/kit.ts'
