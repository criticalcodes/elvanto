import { ElvantoError } from '@criticalcodes/elvanto'
import { configFromEnv, SERVER_VERSION, type ServerConfig } from './server.js'

/**
 * What the process should do, decided before any I/O.
 *
 * Kept separate from the entrypoint so it is testable without spawning a process
 * or binding stdio.
 */
export type StartupPlan =
  | { action: 'print'; text: string; exitCode: 0 }
  | { action: 'serve'; config: ServerConfig; warnings: string[] }
  | { action: 'fail'; message: string; exitCode: 1 }

export const HELP = `elvanto-mcp ${SERVER_VERSION}

An MCP server exposing read-only Elvanto API endpoints as tools. It speaks MCP
over stdio and is meant to be launched by an MCP client, not run by hand.

Environment:
  ELVANTO_API_KEY                 Secret API key (Settings > Account Settings)
  ELVANTO_ACCESS_TOKEN            OAuth access token, instead of an API key
  ELVANTO_VALIDATE                throw (default) | warn | off
  ELVANTO_MCP_PAGE_SIZE           Records per call when unspecified (default 25)
  ELVANTO_MCP_MAX_RESPONSE_CHARS  Response size cap (default 100000)
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
): StartupPlan {
  if (argv.includes('--version') || argv.includes('-v')) {
    return { action: 'print', text: `${SERVER_VERSION}\n`, exitCode: 0 }
  }
  if (argv.includes('--help') || argv.includes('-h')) {
    return { action: 'print', text: HELP, exitCode: 0 }
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
  if (!env['ELVANTO_API_KEY'] && !env['ELVANTO_ACCESS_TOKEN']) {
    warnings.push(
      'Neither ELVANTO_API_KEY nor ELVANTO_ACCESS_TOKEN is set. The server will ' +
        'start and list its tools, but every tool call will fail until one is ' +
        'provided. Find your key in Elvanto under Settings > Account Settings > ' +
        'Secret API Key.',
    )
  }

  return { action: 'serve', config, warnings }
}
