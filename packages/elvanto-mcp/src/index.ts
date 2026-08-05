import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { createServer } from './server.js'
import { planStartup } from './startup.js'

/**
 * Entry point for the Elvanto MCP server, speaking MCP over stdio.
 *
 * Configuration comes from the environment, because that is how MCP clients
 * launch a server. See `planStartup` for what is accepted, and `--help` for the
 * list. Deliberately thin: the decisions live in `startup.ts` so they can be
 * tested without spawning a process.
 */
async function main(): Promise<void> {
  const plan = planStartup(process.argv.slice(2), process.env)

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

  const server = createServer(plan.config)
  await server.connect(new StdioServerTransport())

  const shutdown = () => {
    void server.close().finally(() => process.exit(0))
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

await main()
