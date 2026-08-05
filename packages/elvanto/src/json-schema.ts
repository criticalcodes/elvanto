import { z } from 'zod'
import type { EndpointDefinition } from './registry.js'

/**
 * A JSON Schema object, loose enough to carry whatever zod emits.
 */
export interface JsonSchema {
  type?: string
  description?: string
  properties?: Record<string, JsonSchema>
  required?: string[]
  items?: JsonSchema
  enum?: unknown[]
  anyOf?: JsonSchema[]
  additionalProperties?: JsonSchema | boolean
  propertyNames?: JsonSchema
  pattern?: string
  minimum?: number
  maximum?: number
  exclusiveMinimum?: number
  minLength?: number
  [key: string]: unknown
}

/**
 * The endpoint's parameters as JSON Schema, for MCP tool definitions and CLI
 * option generation.
 *
 * Deriving both from the same zod schema is the point: a parameter cannot exist
 * on one surface and be missing from the other.
 */
export function paramsJsonSchema(endpoint: EndpointDefinition): JsonSchema {
  const schema = z.toJSONSchema(endpoint.params, { io: 'input' }) as JsonSchema
  delete schema['$schema']
  cleanUp(schema)
  // An MCP tool schema must always be an object, even with no parameters.
  schema.type ??= 'object'
  schema.properties ??= {}
  return schema
}

/**
 * Strips bounds that are artefacts of zod's integer handling rather than real
 * API constraints, so they don't show up as noise in tool schemas.
 */
function cleanUp(schema: JsonSchema): void {
  if (schema.maximum === Number.MAX_SAFE_INTEGER) delete schema.maximum
  if (schema.minimum === Number.MIN_SAFE_INTEGER) delete schema.minimum
  for (const value of Object.values(schema.properties ?? {})) cleanUp(value)
  for (const value of schema.anyOf ?? []) cleanUp(value)
  if (schema.items) cleanUp(schema.items)
}

/** How a parameter should be surfaced as a command-line option. */
export type ParamKind =
  | 'string'
  | 'enum'
  | 'integer'
  | 'boolean'
  | 'string-array'
  | 'string-or-array'
  | 'record'
  | 'unknown'

export interface ParamDescriptor {
  name: string
  kind: ParamKind
  required: boolean
  description: string | undefined
  choices: string[] | undefined
}

/**
 * Flattens an endpoint's parameters into a list a CLI can turn into options.
 *
 * Elvanto's parameter vocabulary is small, so the classification is exhaustive
 * in practice; anything unrecognised falls back to `unknown` and is exposed as a
 * JSON-valued option rather than being silently dropped.
 */
export function describeParams(endpoint: EndpointDefinition): ParamDescriptor[] {
  const schema = paramsJsonSchema(endpoint)
  const required = new Set(schema.required ?? [])

  return Object.entries(schema.properties ?? {}).map(([name, property]) => ({
    name,
    kind: classify(property),
    required: required.has(name),
    description: property.description,
    choices: Array.isArray(property.enum)
      ? property.enum.map((v) => String(v))
      : undefined,
  }))
}

function classify(property: JsonSchema): ParamKind {
  if (Array.isArray(property.enum)) return 'enum'

  if (property.anyOf) {
    const types = property.anyOf.map((entry) => entry.type)
    if (types.includes('string') && types.includes('array')) {
      return 'string-or-array'
    }
  }

  switch (property.type) {
    case 'string':
      return 'string'
    case 'integer':
    case 'number':
      return 'integer'
    case 'boolean':
      return 'boolean'
    case 'array':
      return property.items?.type === 'string' ? 'string-array' : 'unknown'
    case 'object':
      return property.additionalProperties !== undefined ||
        property.propertyNames !== undefined
        ? 'record'
        : 'unknown'
    default:
      return 'unknown'
  }
}
