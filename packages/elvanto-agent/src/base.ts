import { useInstruction, useMcpConnection, useTool } from '@flue/runtime'
import type { ElvantoClient } from '@criticalcodes/elvanto'
import { ambientEnv, clientFromEnv, type Env } from './client.ts'
import { elvantoMcpConnection, type ElvantoMcpOptions } from './mcp.ts'
import { createElvantoTools, ALL_TOOL_NAMES, type ElvantoToolName } from './tools/index.ts'
import {
  endpointTools,
  type EndpointSelection,
  type EndpointToolOptions,
} from './tools/endpoints.ts'
import { isoDate } from './shape.ts'

export interface ElvantoBaseOptions {
  /**
   * The Elvanto client the tools share, or a factory invoked on first use.
   * Defaults to a factory over {@link clientFromEnv} — see it for the two
   * defaults that differ from the SDK's.
   *
   * Prefer the factory form when supplying your own. This hook runs during the
   * agent render, so a client constructed eagerly by the caller throws there on
   * a missing credential, before the agent exists — and the session dies with an
   * internal error rather than a message the model can relay. It also lets the
   * same factory be shared with your own tools, so one client (and one set of
   * request pacing) covers everything a turn does.
   */
  client?: ElvantoClient | (() => ElvantoClient)
  env?: Env
  /** The clock, for tests and for a fixed reporting date. */
  now?: () => Date
  /** Which custom tools to mount. Defaults to all of them. */
  tools?: readonly ElvantoToolName[]
  /**
   * Which raw Elvanto endpoints to mount as tools, in-process.
   *
   * `'core'` (the default) adds the endpoints the purpose-built tools do not
   * already cover, and omits every financial one. `'all'` includes giving data.
   * `false` mounts none.
   *
   * These are native Flue tools calling the SDK directly — no MCP server, no
   * second process, no port. See {@link endpointTools} for why that is preferable
   * to connecting to a local MCP server.
   */
  endpoints?: EndpointSelection
  /** Records per page when the model doesn't say, and the response cap. */
  endpointOptions?: EndpointToolOptions
  /**
   * A **remote** MCP server to connect as well, for tools this package does not
   * generate.
   *
   * Not needed to reach the Elvanto endpoints — `endpoints` does that in-process.
   * Left here for a genuinely remote server, on another host or run by someone
   * else. `false` (the default) connects nothing.
   */
  mcp?: ElvantoMcpOptions | false
  /**
   * Append the base instruction. Default true.
   *
   * Set false to write the whole instruction yourself; the tools still work, but
   * the model loses the date context and the Elvanto-specific guidance below,
   * both of which it gets wrong unaided.
   */
  instruction?: boolean
}

/**
 * Mounts the Elvanto toolkit into an agent.
 *
 * A custom hook in Flue's own idiom — a plain function that calls `useTool`,
 * `useMcpConnection` and `useInstruction` — and the extension point this package
 * is built around. Flue only scans a project's own source root for `'use agent'`
 * modules, so an agent cannot be imported from a package; what a package *can*
 * ship is everything the agent is made of. A consuming agent is then a dozen
 * lines:
 *
 * ```ts
 * 'use agent'
 * import { useModel } from '@flue/runtime'
 * import { useElvantoBase } from '@criticalcodes/elvanto-agent'
 *
 * export function Church() {
 *   useModel('anthropic/claude-sonnet-5')
 *   useElvantoBase()
 *   return 'You help staff at our church with rosters and member admin.'
 * }
 * ```
 *
 * Compose further by calling `useTool` for your own tools after it — that is how
 * anything account-specific (a credential profile, local policy, notice wording)
 * stays out of this package and in the repository that owns it.
 */
export function useElvantoBase(options: ElvantoBaseOptions = {}): void {
  const env = options.env ?? ambientEnv()
  const names = options.tools ?? ALL_TOOL_NAMES

  // A factory, not a client. This function runs during the agent render, and
  // building the client here would throw on a missing ELVANTO_API_KEY before the
  // agent exists — killing the session with an internal error instead of letting
  // the model say what is misconfigured. Deferred, the same failure surfaces as a
  // tool error on first use.
  const client = options.client ?? (() => clientFromEnv(env))
  const deps = { client, ...(options.now ? { now: options.now } : {}) }
  for (const tool of createElvantoTools(deps, names)) useTool(tool)

  const selection = options.endpoints ?? 'core'
  const endpoints = endpointTools(deps, selection, options.endpointOptions ?? {})
  for (const tool of endpoints) useTool(tool)

  // Only when explicitly asked for. Reaching Elvanto no longer needs it.
  const connection = options.mcp ? elvantoMcpConnection({ env, ...options.mcp }) : undefined
  if (connection) useMcpConnection(connection)

  if (options.instruction !== false) {
    useInstruction(
      baseInstruction((options.now ?? (() => new Date()))(), endpoints.length > 0),
    )
  }
}

/**
 * The guidance a model needs to use these tools well.
 *
 * Everything here is something a model gets wrong without being told, and each
 * line is here because the alternative is a wrong answer rather than a slow one.
 * Exported so a consuming agent can inspect or replace it.
 */
export function baseInstruction(today: Date, hasRawEndpoints: boolean): string {
  const lines = [
    '## Elvanto',
    '',
    'You have read-only access to this church\'s Elvanto account. Nothing you can ' +
      'call modifies data, so you never need to warn about that — but equally, you ' +
      'cannot make changes when asked, and should say so plainly.',
    '',
    // Without this the model cannot resolve "this Sunday", and will either ask or
    // guess. Rendered each turn, so it stays correct across a long conversation.
    `Today is ${isoDate(today)} (${today.toUTCString().slice(0, 3)}).`,
    '',
    '### Using the tools',
    '',
    '- **Resolve people before using their id.** `find_person` takes free text and ' +
      'returns candidates. If several match, ask which one rather than guessing — ' +
      'two people often share a surname.',
    '- **Prefer the purpose-built tools.** `roster`, `next_serving`, ' +
      '`service_brief` and `song_history` each answer a whole question in one call. ' +
      'Assembling the same answer from raw endpoints costs many calls and usually ' +
      'gets the nested volunteer structure wrong.',
    '- **Custom fields need `list_custom_fields` first.** They are addressed as ' +
      '`custom_<uuid>` keys that differ per account and cannot be guessed.',
    '- **Respect truncation.** A result carrying `truncated` or `scanLimited` is ' +
      'incomplete. Say so, or narrow the query and call again — do not present a ' +
      'trimmed list as the full picture.',
    '- **Dates are `YYYY-MM-DD`.** Elvanto timestamps have no timezone marker but ' +
      'are UTC.',
    '',
    '### Care with member data',
    '',
    '- Answer the question asked. Pulling a whole roster to report one person\'s ' +
      'position puts everyone else\'s details into this conversation for no reason.',
    '- Do not volunteer contact details, addresses or giving information that was ' +
      'not asked for.',
    '- This conversation may be recorded durably, so treat anything you retrieve as ' +
      'leaving the account permanently.',
  ]

  if (!hasRawEndpoints) {
    lines.push(
      '',
      'The raw Elvanto endpoint tools are not connected in this session, so you ' +
        'have only the tools listed above. If a question needs something they ' +
        'cannot reach, say what is missing rather than improvising.',
    )
  }

  return lines.join('\n')
}
