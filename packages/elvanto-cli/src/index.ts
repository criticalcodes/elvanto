import { Command, CommanderError, Option } from 'commander'
import {
  ElvantoApiError,
  ElvantoClient,
  ElvantoError,
  ElvantoRequestValidationError,
  ElvantoResponseValidationError,
  ElvantoTransportError,
  endpointIds,
  getEndpoint,
  isPageEndpoint,
  parseDebugMode,
  parseValidationMode,
  toCliPath,
  toKebabCase,
  type DebugMode,
  type EndpointDefinition,
  type PageEndpointId,
  type RequestOptions,
  type ValidationMode,
} from '@criticalcodes/elvanto'
import { UsageError, buildOptions, collectParams } from './options.js'
import { isPage, render, type OutputFormat } from './render.js'

const VERSION = '0.1.0'

/** Exit codes, so scripts can branch on the failure rather than parsing stderr. */
export const EXIT = {
  ok: 0,
  error: 1,
  usage: 2,
  auth: 3,
  notFound: 4,
  schemaMismatch: 5,
} as const

interface GlobalOptions {
  apiKey?: string
  token?: string
  baseUrl?: string
  validate?: string
  output?: OutputFormat
  all?: boolean
  maxRecords?: number
  timeout?: number
  retries?: number
  paramsJson?: string
  columns?: number
  debug?: boolean | string
}

export function buildProgram(): Command {
  const program = new Command()

  program
    .name('elvanto')
    .description(
      'Read-only command-line access to the Elvanto API.\n\n' +
        'Authenticate with ELVANTO_API_KEY (Settings > Account Settings > Secret ' +
        'API Key) or --api-key. Commands mirror the API: `elvanto people get-all`.',
    )
    .version(VERSION)
    .configureHelp({ sortSubcommands: true })

  program
    .addOption(
      new Option(
        '--api-key <key>',
        'Elvanto secret API key. Defaults to $ELVANTO_API_KEY.',
      ).env('ELVANTO_API_KEY'),
    )
    .addOption(
      new Option(
        '--token <token>',
        'OAuth access token, used instead of an API key.',
      ).env('ELVANTO_ACCESS_TOKEN'),
    )
    .addOption(
      new Option('--base-url <url>', 'Override the API root.').env(
        'ELVANTO_BASE_URL',
      ),
    )
    .addOption(
      new Option(
        '--validate <mode>',
        'Response validation: throw (default), warn, or off. Use warn or off if ' +
          'Elvanto returns a shape this version does not model yet.',
      )
        .choices(['throw', 'warn', 'off'])
        .env('ELVANTO_VALIDATE'),
    )
    .addOption(
      new Option('-o, --output <format>', 'Output format.')
        .choices(['table', 'json', 'ndjson'])
        .default(process.stdout.isTTY ? 'table' : 'json'),
    )
    .addOption(
      new Option(
        '--all',
        'Fetch every page, not just the first. Combine with --max-records.',
      ),
    )
    .addOption(
      new Option('--max-records <number>', 'Stop after this many records.').argParser(
        Number,
      ),
    )
    .addOption(
      new Option('--timeout <ms>', 'Per-request timeout in milliseconds.').argParser(
        Number,
      ),
    )
    .addOption(
      new Option('--retries <number>', 'Retries for rate limits and 5xx.').argParser(
        Number,
      ),
    )
    .addOption(
      new Option(
        '--params-json <json>',
        'Extra parameters as a JSON object, merged over the flags above.',
      ),
    )
    .addOption(new Option('--columns <number>', 'Max table columns.').argParser(Number))
    .addOption(
      new Option(
        '--debug [mode]',
        'Log requests, timings and retries to stderr. Pass "verbose" to include ' +
          'parameter values. Credentials and returned records are never logged.',
      ).env('ELVANTO_DEBUG'),
    )

  program
    .command('endpoints')
    .description('List every available endpoint and its documentation link.')
    .action(() => {
      const width = Math.max(...endpointIds.map((id) => toCliPath(id).join(' ').length))
      for (const id of endpointIds) {
        const endpoint = getEndpoint(id)
        const command = toCliPath(id).join(' ')
        const mark = endpoint.verified === 'live' ? '' : ' *'
        process.stdout.write(
          `${command.padEnd(width)}  ${endpoint.summary}${mark}\n`,
        )
      }
      process.stdout.write(
        '\n* Response shape matches Elvanto\'s documented example but has not yet\n' +
          '  been seen returning real data. Please report anything unexpected.\n',
      )
    })

  for (const id of endpointIds) {
    attachEndpoint(program, getEndpoint(id))
  }

  return program
}

/**
 * Hangs an endpoint off the program as nested subcommands, creating the
 * intermediate namespace commands on first use.
 */
function attachEndpoint(program: Command, endpoint: EndpointDefinition): void {
  const path = toCliPath(endpoint.id)
  const action = path.at(-1)!
  const namespaces = path.slice(0, -1)

  let parent = program
  for (const namespace of namespaces) {
    parent = findOrCreateNamespace(parent, namespace)
  }

  const command = parent
    .command(action)
    .description(
      endpoint.verified === 'live'
        ? endpoint.summary
        : `${endpoint.summary} (This endpoint's response shape matches Elvanto's ` +
            `documentation but has not been verified against real data.)`,
    )
    .addHelpText('after', `\nDocumentation: ${endpoint.docs}`)

  for (const option of buildOptions(endpoint)) {
    command.addOption(option)
  }

  command.action(async (_options: unknown, self: Command) => {
    await runEndpoint(endpoint, self)
  })
}

function findOrCreateNamespace(parent: Command, name: string): Command {
  const existing = parent.commands.find((command) => command.name() === name)
  if (existing) return existing
  return parent
    .command(name)
    .description(`${name.replace(/-/g, ' ')} endpoints`)
}

async function runEndpoint(
  endpoint: EndpointDefinition,
  command: Command,
): Promise<void> {
  const options = command.optsWithGlobals() as GlobalOptions & Record<string, unknown>

  const validate: ValidationMode | undefined = parseValidationMode(options.validate)
  // `--debug` with no value arrives as `true`; `--debug verbose` as the string.
  const debug: DebugMode | undefined =
    options.debug === true
      ? 'on'
      : typeof options.debug === 'string'
        ? parseDebugMode(options.debug)
        : undefined

  const client = new ElvantoClient({
    ...(options.token && !options.apiKey
      ? { auth: { accessToken: options.token } }
      : options.apiKey
        ? { auth: { apiKey: options.apiKey } }
        : {}),
    ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
    ...(validate ? { validate } : {}),
    ...(debug ? { debug } : {}),
    ...(options.timeout !== undefined ? { timeoutMs: options.timeout } : {}),
    ...(options.retries !== undefined ? { maxRetries: options.retries } : {}),
    userAgent: `elvanto-cli/${VERSION}`,
    onWarning: (warning) => {
      process.stderr.write(`warning: ${warning.message}\n`)
    },
  })

  const { params, extraParams } = collectParams(endpoint, options, options.paramsJson)
  const requestOptions =
    Object.keys(extraParams).length > 0 ? { extraParams } : {}

  const result =
    options.all && isPageEndpoint(endpoint)
      ? await fetchEveryPage(
          client,
          endpoint.id as PageEndpointId,
          params,
          options,
          requestOptions,
        )
      : await client.call(endpoint.id as never, params as never, requestOptions)

  const format: OutputFormat = options.output ?? 'json'
  const output = render(result, {
    format,
    width: process.stdout.columns ?? 120,
    maxColumns: options.columns ?? 6,
  })
  process.stdout.write(`${output}\n`)
}

/** Collects every page into one page-shaped result, so rendering is uniform. */
async function fetchEveryPage(
  client: ElvantoClient,
  id: PageEndpointId,
  params: Record<string, unknown>,
  options: GlobalOptions,
  requestOptions: RequestOptions,
): Promise<unknown> {
  const items = await client.fetchAll(id, params as never, {
    ...requestOptions,
    ...(options.maxRecords !== undefined ? { maxRecords: options.maxRecords } : {}),
  })
  return {
    items,
    page: 1,
    perPage: items.length,
    onThisPage: items.length,
    total: items.length,
    hasMore: false,
  }
}

/** Maps an error to a message and exit code. */
export function describeError(error: unknown): { message: string; code: number } {
  if (error instanceof UsageError) {
    return { message: error.message, code: EXIT.usage }
  }
  if (error instanceof ElvantoRequestValidationError) {
    return { message: error.message, code: EXIT.usage }
  }
  if (error instanceof ElvantoResponseValidationError) {
    return {
      message:
        `${error.message}\n\n` +
        `Re-run with --validate warn to use the response anyway.`,
      code: EXIT.schemaMismatch,
    }
  }
  if (error instanceof ElvantoApiError) {
    if (error.isAuthError) {
      return {
        message:
          `${error.message}\n\nCheck ELVANTO_API_KEY, or --api-key. Find your key ` +
          `in Elvanto under Settings > Account Settings > Secret API Key.`,
        code: EXIT.auth,
      }
    }
    if (error.isNotFound) {
      return {
        message: `${error.message}\n\nNothing matched, or the ID does not exist.`,
        code: EXIT.notFound,
      }
    }
    if (error.isRateLimited) {
      return {
        message: `${error.message}\n\nRate limited — retry with --retries 3.`,
        code: EXIT.error,
      }
    }
    return { message: error.message, code: EXIT.error }
  }
  if (error instanceof ElvantoTransportError) {
    return { message: error.message, code: EXIT.error }
  }
  if (error instanceof ElvantoError) {
    return { message: error.message, code: EXIT.usage }
  }
  return { message: error instanceof Error ? error.message : String(error), code: EXIT.error }
}

/**
 * Makes every command throw instead of calling `process.exit`.
 *
 * `exitOverride()` is only inherited by subcommands created after it is called,
 * and the whole tree is built up front, so it has to be applied to each one —
 * otherwise a subcommand's `--help` or usage error exits the process directly
 * and never reaches the error mapping below.
 */
function applyExitOverride(command: Command): void {
  command.exitOverride()
  for (const child of command.commands) applyExitOverride(child)
}

export async function main(argv: string[] = process.argv): Promise<number> {
  const program = buildProgram()
  applyExitOverride(program)

  try {
    await program.parseAsync(argv)
    return EXIT.ok
  } catch (error) {
    // Commander throws for --help and --version too, which are not failures.
    if (error instanceof CommanderError) {
      if (error.exitCode === 0) return EXIT.ok
      // Commander has already written its own message to stderr.
      if (error.message) process.stderr.write(`${error.message}\n`)
      return EXIT.usage
    }
    const { message, code } = describeError(error)
    process.stderr.write(`error: ${message}\n`)
    return code
  }
}

// Re-exported for tests; `isPage` keeps the render contract in one place.
export { isPage, render, toKebabCase }

const isDirectRun =
  process.argv[1] !== undefined &&
  (import.meta.url === `file://${process.argv[1]}` ||
    import.meta.url.endsWith('/dist/index.js'))

if (isDirectRun) {
  process.exitCode = await main()
}
