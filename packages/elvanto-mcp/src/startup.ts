import { ElvantoError } from '@criticalcodes/elvanto'
import { configFromEnv, SERVER_VERSION, type ServerConfig } from './server.js'

/** Where the server should listen. */
export type TransportPlan =
  /** MCP over stdio, launched by a client. The default. */
  | { kind: 'stdio' }
  /** MCP over streamable HTTP, for hosts that speak only HTTP. */
  | { kind: 'http'; host: string; port: number; token?: string }

/** Default HTTP port. Above the range dev servers usually squat on. */
export const DEFAULT_HTTP_PORT = 3001

/**
 * Default HTTP bind address: loopback only.
 *
 * Serving this on `0.0.0.0` publishes every member and giving record in the
 * account to the local network, so reaching the network is an explicit act
 * (`--host`) and, per {@link planStartup}, requires a token.
 */
export const DEFAULT_HTTP_HOST = '127.0.0.1'

/**
 * What the process should do, decided before any I/O.
 *
 * Kept separate from the entrypoint so it is testable without spawning a process
 * or binding stdio.
 */
export type StartupPlan =
  | { action: 'print'; text: string; exitCode: 0 }
  | {
      action: 'serve'
      config: ServerConfig
      transport: TransportPlan
      warnings: string[]
    }
  | { action: 'fail'; message: string; exitCode: 1 }

export const HELP = `elvanto-mcp ${SERVER_VERSION}

An MCP server exposing read-only Elvanto API endpoints as tools. By default it
speaks MCP over stdio and is meant to be launched by an MCP client, not run by
hand. Pass --http to serve streamable HTTP instead, for hosts that cannot launch
a subprocess.

Options:
  --http                          Serve streamable HTTP instead of stdio
  --port <n>                      HTTP port (default ${DEFAULT_HTTP_PORT})
  --host <address>                HTTP bind address (default ${DEFAULT_HTTP_HOST})
  --help, -h                      Print this and exit
  --version, -v                   Print the version and exit

Credentials, in the order they are consulted:
  ELVANTO_API_KEY                 Secret API key (Settings > Account Settings)
  ELVANTO_ACCESS_TOKEN            A fixed OAuth access token, instead of a key
  (a stored grant)                Written by \`elvanto login\`; refreshed
                                  automatically. Used when neither variable above
                                  is set.

Environment:
  ELVANTO_CLIENT_ID               OAuth application client ID, for refreshing a
  ELVANTO_CLIENT_SECRET           stored grant. Elvanto: Settings > Integrations
  ELVANTO_PROFILE                 Which stored grant to use (default "default")
  ELVANTO_CREDENTIALS             Override the credentials file path
  ELVANTO_VALIDATE                throw (default) | warn | off
  ELVANTO_MCP_WRITES              off (default) | write | all. Which tools that
                                  change the account to offer: write adds
                                  creates, edits and group/flow membership; all
                                  also adds deletes and removals
  ELVANTO_MCP_PAGE_SIZE           Records per call when unspecified (default 25)
  ELVANTO_MCP_MAX_RESPONSE_CHARS  Response size cap (default 100000)
  ELVANTO_MCP_TOKEN               Bearer token required by --http. Mandatory when
                                  --host is not loopback, since an API key reads
                                  every member and giving record in the account.
  ELVANTO_DEBUG                   on | verbose — log requests and timings to
                                  stderr. Credentials and returned records are
                                  never logged.
  ELVANTO_BASE_URL                Override the API root

Example client configuration:
  {
    "mcpServers": {
      "elvanto": {
        "command": "npx",
        "args": ["-y", "@criticalcodes/elvanto-mcp"],
        "env": { "ELVANTO_API_KEY": "your-key" }
      }
    }
  }

Example HTTP invocation, for a host that takes a URL:
  ELVANTO_API_KEY=your-key ELVANTO_MCP_TOKEN=$(openssl rand -hex 32) \\
    npx -y @criticalcodes/elvanto-mcp --http
  # then point the host at http://127.0.0.1:${DEFAULT_HTTP_PORT}/ with that bearer token
`

/**
 * Decides how to start.
 *
 * The two failure modes are treated differently on purpose. A malformed
 * configuration value is an operator typo, so it fails fast with a readable
 * message rather than silently running with a default the operator did not
 * choose. Missing credentials do not fail: the server still starts and lists its
 * tools, so the client shows a working server whose calls explain what is wrong,
 * instead of a dead one with no explanation.
 */
export function planStartup(
  argv: readonly string[],
  env: Record<string, string | undefined>,
  options: {
    /**
     * Whether `elvanto login` has left a usable grant on disk. Passed in rather
     * than read here, so this stays a pure decision over its inputs and testable
     * without a filesystem.
     */
    hasStoredGrant?: boolean
  } = {},
): StartupPlan {
  if (argv.includes('--version') || argv.includes('-v')) {
    return { action: 'print', text: `${SERVER_VERSION}\n`, exitCode: 0 }
  }
  if (argv.includes('--help') || argv.includes('-h')) {
    return { action: 'print', text: HELP, exitCode: 0 }
  }

  let transport: TransportPlan
  try {
    transport = planTransport(argv, env)
  } catch (error) {
    return {
      action: 'fail',
      message: `${error instanceof Error ? error.message : String(error)}\nRun with --help to see the accepted options.`,
      exitCode: 1,
    }
  }

  let config: ServerConfig
  try {
    config = configFromEnv(env)
  } catch (error) {
    const detail = error instanceof ElvantoError ? error.message : String(error)
    return {
      action: 'fail',
      message:
        `Cannot start: ${detail}\n` +
        `Fix the environment variable in your MCP client configuration, or remove ` +
        `it to use the default. Run with --help to see the accepted values.`,
      exitCode: 1,
    }
  }

  const warnings: string[] = []
  if (!env['ELVANTO_API_KEY'] && !env['ELVANTO_ACCESS_TOKEN'] && !options.hasStoredGrant) {
    warnings.push(
      'No credentials. Neither ELVANTO_API_KEY nor ELVANTO_ACCESS_TOKEN is set, and ' +
        'no OAuth grant is stored. The server will start and list its tools, but ' +
        'every tool call will fail until one is provided. Either run `elvanto login` ' +
        '(from @criticalcodes/elvanto-cli) to sign in as yourself, or find your key ' +
        'in Elvanto under Settings > Account Settings > Secret API Key.',
    )
  }
  if (config.writes && config.writes !== 'off') {
    // Said on every start, because the MCP client's own UI may not make it
    // obvious that this server can now change the account.
    warnings.push(
      `Write tools are enabled (ELVANTO_MCP_WRITES=${config.writes}). A connected ` +
        `model can ${config.writes === 'all' ? 'create, change and delete' : 'create and change'} ` +
        `records in the Elvanto account.`,
    )
  }
  if (transport.kind === 'http' && transport.token === undefined) {
    // Loopback only, or planTransport would have failed. Still worth saying out
    // loud: anything running as this user can read the whole account through it,
    // which is a wider door than a stdio server that dies with its client.
    warnings.push(
      'Serving HTTP without ELVANTO_MCP_TOKEN. Any process on this machine can ' +
        'read every member and giving record in the account through this port. ' +
        'Set ELVANTO_MCP_TOKEN to require a bearer token.',
    )
  }

  return { action: 'serve', config, transport, warnings }
}

/**
 * Reads the transport options.
 *
 * Throws rather than returning a plan, so {@link planStartup} can attribute the
 * message uniformly; every throw here is an operator typo, which fails fast on
 * the same reasoning as a malformed environment value.
 */
function planTransport(
  argv: readonly string[],
  env: Record<string, string | undefined>,
): TransportPlan {
  const http = argv.includes('--http')
  const port = readOption(argv, '--port')
  const host = readOption(argv, '--host')

  if (!http) {
    // Silently ignoring these would leave an operator staring at a stdio server
    // wondering why nothing is listening on the port they asked for.
    const stray = [port !== undefined ? '--port' : '', host !== undefined ? '--host' : '']
      .filter(Boolean)
      .join(' and ')
    if (stray) {
      throw new ElvantoError(
        `${stray} only applies with --http, which was not passed. The server ` +
          `would have spoken stdio and ignored it.`,
      )
    }
    return { kind: 'stdio' }
  }

  let resolvedPort = DEFAULT_HTTP_PORT
  if (port !== undefined) {
    const parsed = Number(port)
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
      throw new ElvantoError(`--port must be an integer between 1 and 65535, got "${port}".`)
    }
    resolvedPort = parsed
  }

  const resolvedHost = host ?? DEFAULT_HTTP_HOST
  const token = env['ELVANTO_MCP_TOKEN']?.trim()

  if (!token && !isLoopback(resolvedHost)) {
    throw new ElvantoError(
      `Refusing to serve ${resolvedHost} without ELVANTO_MCP_TOKEN. An Elvanto API ` +
        `key grants read access to every member record and every giving record in ` +
        `the account, so an unauthenticated port on a reachable interface is a copy ` +
        `of the church database. Either set ELVANTO_MCP_TOKEN, or drop --host to ` +
        `bind ${DEFAULT_HTTP_HOST}.`,
    )
  }

  return { kind: 'http', host: resolvedHost, port: resolvedPort, ...(token ? { token } : {}) }
}

/** Reads `--name value` or `--name=value`. */
function readOption(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name)
  if (index !== -1) {
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--')) {
      throw new ElvantoError(`${name} requires a value.`)
    }
    return value
  }

  const inline = argv.find((arg) => arg.startsWith(`${name}=`))
  return inline?.slice(name.length + 1)
}

/**
 * Whether a bind address reaches only this machine.
 *
 * Errs towards "not loopback": an address this does not recognise requires a
 * token, so a form nobody thought of fails closed.
 */
function isLoopback(host: string): boolean {
  const bare = host.replace(/^\[|\]$/g, '').toLowerCase()
  return (
    bare === 'localhost' ||
    bare === '::1' ||
    bare === '0:0:0:0:0:0:0:1' ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(bare)
  )
}
