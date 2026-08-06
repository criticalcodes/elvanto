import { defineMcpConnection, type McpConnectionDefinition } from '@flue/runtime'
import { endpointIds, toMcpToolName, type EndpointId } from '@criticalcodes/elvanto'
import { ambientEnv, type Env } from './client.ts'

/**
 * Names an MCP tool from a registry id, checked at compile time.
 *
 * The allowlist below could be written as string literals, but Flue treats a name
 * the server does not expose as an error — correctly, since a silently narrowed
 * tool set is worse than a loud failure. Deriving the names from the same registry
 * the server derives them from makes the two impossible to drift apart, and a
 * renamed endpoint a type error here rather than a startup failure in production.
 */
function mcpTool(id: EndpointId): string {
  return toMcpToolName(id)
}

/**
 * The raw endpoint tools mounted by default, alongside the custom tools.
 *
 * Chosen to *add* to the custom tools rather than duplicate them. The custom
 * tools are the well-lit path for the common questions; these are the escape
 * hatch for everything else, and a narrower escape hatch is easier to reason
 * about than all 25.
 *
 * Three deliberate omissions:
 *
 * - **Every financial endpoint.** Individual giving records are the most
 *   sensitive data an API key reaches, and a general-purpose church assistant has
 *   no reason to read them. Opt in with {@link ALL_MCP_TOOLS} or an explicit list.
 * - **`people.search`.** `find_person` does the same job with a search strategy
 *   and a compact result; offering both invites the model to pick the harder one.
 * - **`people.currentUser`.** OAuth-only, so with an API key it is a tool that
 *   can only ever fail.
 */
export const CORE_MCP_TOOLS: readonly string[] = [
  mcpTool('people.getAll'),
  mcpTool('people.getInfo'),
  mcpTool('people.categories.getAll'),
  mcpTool('groups.getAll'),
  mcpTool('groups.getInfo'),
  mcpTool('services.getAll'),
  mcpTool('songs.getAll'),
  mcpTool('songs.getInfo'),
  mcpTool('calendar.events.getAll'),
]

/**
 * Every tool the server exposes, financial endpoints included.
 *
 * For an operator who has decided the agent should reach giving data. Read the
 * privacy note in the MCP server's README first — an agent runtime persists tool
 * results, so this puts giving history into whatever store backs the session.
 */
export const ALL_MCP_TOOLS: readonly string[] = endpointIds.map((id) => toMcpToolName(id))

export interface ElvantoMcpOptions {
  /** Server URL. Defaults to `ELVANTO_MCP_URL`. */
  url?: string
  /** Bearer token. Defaults to `ELVANTO_MCP_TOKEN`. */
  token?: string
  /** Tool allowlist. Defaults to {@link CORE_MCP_TOOLS}. */
  tools?: readonly string[]
  env?: Env
}

/**
 * The Elvanto MCP connection, or `undefined` when no URL is configured.
 *
 * Returns `undefined` rather than throwing or inventing a default, because the
 * custom tools work perfectly well without the raw endpoints and a missing URL is
 * a normal state — a `flue run` session with nothing else set up. The caller
 * decides what to do about it; {@link useElvantoBase} tells the model.
 */
export function elvantoMcpConnection(
  options: ElvantoMcpOptions = {},
): McpConnectionDefinition | undefined {
  const env = options.env ?? ambientEnv()
  const url = options.url ?? env['ELVANTO_MCP_URL']
  if (!url) return undefined

  const token = options.token ?? env['ELVANTO_MCP_TOKEN']

  return defineMcpConnection({
    name: 'elvanto',
    url,
    ...(token ? { auth: token } : {}),
    tools: [...(options.tools ?? CORE_MCP_TOOLS)],
    // A failed connection mounts zero tools for the submission and announces the
    // gap to the model, instead of failing the whole turn. The custom tools cover
    // the common questions, so a session that loses the escape hatch is degraded
    // rather than useless — and the next submission retries.
    optional: true,
  })
}
