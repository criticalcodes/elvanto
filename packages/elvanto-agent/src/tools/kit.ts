import type { ElvantoClient } from '@criticalcodes/elvanto'

/** What every tool factory needs. */
export interface ToolDeps {
  /**
   * The client, or a factory invoked on first use.
   *
   * A factory is what {@link useElvantoBase} passes, and the reason is worth
   * stating: building the client eagerly means constructing it during the agent
   * render, where a missing `ELVANTO_API_KEY` throws before the agent exists and
   * the session dies with an internal error — the user cannot even be told what is
   * wrong. Deferred to first call, the same failure becomes a tool error the model
   * reads and can relay. The MCP server defers for the same reason.
   */
  client: ElvantoClient | (() => ElvantoClient)
  /**
   * The clock, injectable because half of these tools do date arithmetic and a
   * test that cannot fix "now" can only assert vaguely.
   */
  now?: () => Date
}

export function clockOf(deps: ToolDeps): () => Date {
  return deps.now ?? (() => new Date())
}

/**
 * Resolves {@link ToolDeps.client} to a memoized accessor.
 *
 * Memoized so a factory builds one client per tool rather than one per call —
 * which matters because the client owns the request pacing, and a fresh one per
 * call would pace nothing.
 */
export function clientOf(deps: ToolDeps): () => ElvantoClient {
  const source = deps.client
  if (typeof source !== 'function') return () => source

  let cached: ElvantoClient | undefined
  return () => (cached ??= source())
}

/**
 * A result set trimmed to a ceiling, saying so when it trims.
 *
 * The `dropped` count is the whole point. A silently shortened list reads as a
 * complete answer, and a model that believes it has the full roster will state
 * so confidently — which is worse than no answer. The same reasoning as the MCP
 * server's response cap, applied per tool.
 */
export interface Capped<T> {
  items: T[]
  truncated?: { dropped: number; of: number; advice: string }
}

export function cap<T>(items: T[], limit: number, advice: string): Capped<T> {
  if (items.length <= limit) return { items }
  return {
    items: items.slice(0, limit),
    truncated: { dropped: items.length - limit, of: items.length, advice },
  }
}
