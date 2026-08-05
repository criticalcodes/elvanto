/**
 * Name derivation for the three surfaces.
 *
 * Elvanto's own paths are camelCase (`peopleFlows/steps/getAll`). Rather than
 * letting that leak into places where it reads wrong, every public name is
 * derived mechanically from the registry so each surface is internally
 * consistent:
 *
 * | Surface | Convention  | Example                            |
 * | ------- | ----------- | ---------------------------------- |
 * | TS      | camelCase   | `client.peopleFlows.steps.getAll()` |
 * | CLI     | kebab-case  | `elvanto people-flows steps get-all` |
 * | MCP     | snake_case  | `elvanto_people_flows_steps_get_all` |
 */

/** Splits a camelCase identifier into lowercase words. */
export function words(identifier: string): string[] {
  return identifier
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[\s_-]+/)
    .filter((w) => w.length > 0)
    .map((w) => w.toLowerCase())
}

/** `getAll` → `get-all`, `peopleFlows` → `people-flows`. */
export function toKebabCase(identifier: string): string {
  return words(identifier).join('-')
}

/** `getAll` → `get_all`, `customFields` → `custom_fields`. */
export function toSnakeCase(identifier: string): string {
  return words(identifier).join('_')
}

/** Turns a dotted endpoint id into its CLI argument path. */
export function toCliPath(endpointId: string): string[] {
  return endpointId.split('.').map(toKebabCase)
}

/** Turns a dotted endpoint id into its MCP tool name. */
export function toMcpToolName(endpointId: string, prefix = 'elvanto'): string {
  return [prefix, ...endpointId.split('.').map(toSnakeCase)].join('_')
}
