import { InvalidArgumentError, Option } from 'commander'
import {
  describeParams,
  toKebabCase,
  type EndpointDefinition,
  type ParamDescriptor,
} from '@criticalcodes/elvanto'

/**
 * Turns an endpoint's parameters into command-line options.
 *
 * Option names are the kebab-case form of Elvanto's parameter names, so
 * `page_size` becomes `--page-size`. The reverse mapping happens in
 * {@link collectParams}, which reads values back by the original name.
 */
export function buildOptions(endpoint: EndpointDefinition): Option[] {
  return describeParams(endpoint).map((param) => toOption(param))
}

function toOption(param: ParamDescriptor): Option {
  const flag = `--${toKebabCase(param.name)}`
  const description = param.description ?? param.name

  switch (param.kind) {
    case 'boolean':
      return new Option(flag, description)

    case 'integer':
      return new Option(`${flag} <number>`, description).argParser(parseInteger)

    case 'enum': {
      const option = new Option(
        `${flag} <${(param.choices ?? []).join('|')}>`,
        description,
      )
      if (param.choices) option.choices(param.choices)
      return required(option, param)
    }

    case 'string-array':
      return required(
        new Option(`${flag} <values...>`, `${description} Comma or space separated.`)
          .argParser(collectList),
        param,
      )

    case 'string-or-array':
      return required(
        new Option(
          `${flag} <values...>`,
          `${description} Repeat or comma-separate for several.`,
        ).argParser(collectList),
        param,
      )

    case 'record':
      return required(
        new Option(
          `${flag} <key=value...>`,
          `${description} Repeatable, e.g. --search lastname=Smith --search volunteer=yes`,
        ).argParser(collectPairs),
        param,
      )

    default:
      return required(new Option(`${flag} <value>`, description), param)
  }
}

function required(option: Option, param: ParamDescriptor): Option {
  return param.required ? option.makeOptionMandatory(true) : option
}

function parseInteger(value: string): number {
  const parsed = Number(value)
  if (!Number.isInteger(parsed)) {
    throw new InvalidArgumentError('Expected a whole number.')
  }
  return parsed
}

/** Accumulates repeated occurrences, splitting comma-separated values. */
function collectList(value: string, previous: string[] | undefined): string[] {
  const parts = value
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
  return [...(previous ?? []), ...parts]
}

/** Accumulates `key=value` pairs into an object. */
function collectPairs(
  value: string,
  previous: Record<string, string> | undefined,
): Record<string, string> {
  const separator = value.indexOf('=')
  if (separator < 1) {
    throw new InvalidArgumentError(
      `Expected key=value, got "${value}".`,
    )
  }
  return {
    ...(previous ?? {}),
    [value.slice(0, separator)]: value.slice(separator + 1),
  }
}

/** A problem with what the user typed. Mapped to the usage exit code. */
export class UsageError extends Error {}

export interface CollectedParams {
  /** Parameters the endpoint declares, which the SDK will validate. */
  params: Record<string, unknown>
  /**
   * Keys from `--params-json` that the endpoint does not declare. These skip
   * validation, which is the only way an escape hatch can actually be one —
   * `z.object` strips unknown keys, so merging them into `params` would silently
   * drop them.
   */
  extraParams: Record<string, unknown>
}

/**
 * Reads option values back into Elvanto's parameter names.
 *
 * `--params-json` is applied last so it can override a flag or supply something
 * the generated flags cannot express — a parameter Elvanto adds before this
 * package catches up.
 */
export function collectParams(
  endpoint: EndpointDefinition,
  options: Record<string, unknown>,
  paramsJson: string | undefined,
): CollectedParams {
  const params: Record<string, unknown> = {}
  const extraParams: Record<string, unknown> = {}
  const declared = new Set(describeParams(endpoint).map((param) => param.name))

  for (const param of describeParams(endpoint)) {
    // Commander camelCases option names: `--page-size` arrives as `pageSize`.
    const value = options[camelCase(toKebabCase(param.name))]
    if (value === undefined) continue

    // Elvanto accepts a bare string where a single ID is meant, and a list
    // otherwise; sending a one-element array is equivalent but noisier.
    if (param.kind === 'string-or-array' && Array.isArray(value) && value.length === 1) {
      params[param.name] = value[0]
      continue
    }
    params[param.name] = value
  }

  if (paramsJson !== undefined) {
    let parsed: unknown
    try {
      parsed = JSON.parse(paramsJson)
    } catch (error) {
      throw new UsageError(
        `--params-json is not valid JSON: ${(error as Error).message}`,
      )
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new UsageError('--params-json must be a JSON object.')
    }
    for (const [key, value] of Object.entries(parsed)) {
      if (declared.has(key)) params[key] = value
      else extraParams[key] = value
    }
  }

  return { params, extraParams }
}

function camelCase(kebab: string): string {
  return kebab.replace(/-([a-z0-9])/g, (_, char: string) => char.toUpperCase())
}
