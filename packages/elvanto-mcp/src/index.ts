import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { storedGrant } from './credentials.js'
import { createServer } from './server.js'
import { serveHttp } from './serve.js'
import { planStartup } from './startup.js'

/**
 * Entry point for the Elvanto MCP server, speaking MCP over stdio or streamable
 * HTTP.
 *
 * Configuration comes from the environment, because that is how MCP clients
 * launch a server. See `planStartup` for what is accepted, and `--help` for the
 * list. Deliberately thin: the decisions live in `startup.ts` so they can be
 * tested without spawning a process.
 */
async function main(): Promise<void> {
  const grant = storedGrant(process.env)
  const plan = planStartup(process.argv.slice(2), process.env, {
    hasStoredGrant: grant !== undefined,
  })

  if (plan.action === 'print') {
    process.stdout.write(plan.text)
    return
  }

  if (plan.action === 'fail') {
    process.stderr.write(`[elvanto-mcp] ${plan.message}\n`)
    process.exitCode = plan.exitCode
    return
  }

  for (const warning of plan.warnings) {
    process.stderr.write(`[elvanto-mcp] Warning: ${warning}\n`)
  }

  // Merged after planning rather than inside it: `planStartup` is a pure decision
  // over argv and the environment, and a grant comes off the filesystem.
  const config = grant
    ? { ...plan.config, clientOptions: { ...plan.config.clientOptions, auth: grant.auth } }
    : plan.config
  if (grant) {
    process.stderr.write(
      `[elvanto-mcp] Using the stored OAuth grant for profile "${grant.profile}" ` +
        `(${grant.path}).\n`,
    )
  }

  if (plan.transport.kind === 'http') {
    const { host, port, token } = plan.transport
    const running = await serveHttp(config, {
      host,
      port,
      ...(token ? { token } : {}),
    })
    // stdout is free in HTTP mode — nothing speaks MCP on it — but stderr keeps
    // every diagnostic in one stream regardless of transport.
    process.stderr.write(
      `[elvanto-mcp] Listening on http://${running.host}:${running.port}/ ` +
        `(${token ? 'bearer token required' : 'no authentication'})\n`,
    )

    const shutdown = () => {
      void running.close().finally(() => process.exit(0))
    }
    process.on('SIGINT', shutdown)
    process.on('SIGTERM', shutdown)
    return
  }

  const server = createServer(config)
  await server.connect(new StdioServerTransport())

  const shutdown = () => {
    void server.close().finally(() => process.exit(0))
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

await main()
