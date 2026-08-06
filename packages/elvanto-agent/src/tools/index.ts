import type { ToolDefinition } from '@flue/runtime'
import { findPerson } from './find-person.ts'
import { listCustomFields } from './custom-fields.ts'
import { nextServing, roster } from './roster.ts'
import { serviceBrief } from './service-brief.ts'
import { songHistory } from './song-history.ts'
import type { ToolDeps } from './kit.ts'

/**
 * The tool catalogue, by name.
 *
 * A map rather than an array so a caller can select by name — `tools: ['roster']`
 * — and so the names in a configuration are checked against reality by the type
 * system instead of failing silently at render.
 */
export const TOOL_FACTORIES = {
  find_person: findPerson,
  roster,
  next_serving: nextServing,
  service_brief: serviceBrief,
  song_history: songHistory,
  list_custom_fields: listCustomFields,
} as const satisfies Record<string, (deps: ToolDeps) => ToolDefinition>

export type ElvantoToolName = keyof typeof TOOL_FACTORIES

export const ALL_TOOL_NAMES = Object.keys(TOOL_FACTORIES) as ElvantoToolName[]

/** Builds the named tools, or all of them. */
export function createElvantoTools(
  deps: ToolDeps,
  names: readonly ElvantoToolName[] = ALL_TOOL_NAMES,
): ToolDefinition[] {
  return names.map((name) => TOOL_FACTORIES[name](deps))
}

export { findPerson, listCustomFields, nextServing, roster, serviceBrief, songHistory }
export type { ToolDeps }
export { attemptsFor } from './find-person.ts'
export { cap, type Capped } from './kit.ts'
