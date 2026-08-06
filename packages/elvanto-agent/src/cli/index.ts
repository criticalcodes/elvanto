import { createAgentRouter } from '@flue/runtime/routing'
import { init, type Agent } from '@flue/runtime'
import { sqlite, start } from '@flue/runtime/node'
import { Hono } from 'hono'
import { stderr, stdout } from 'node:process'
import { ask, askOnce, chatLoop } from './chat.ts'
import { webChatPage } from './web.ts'

/**
 * One executable that runs an agent three ways.
 *
 * The thing that makes this possible is `start({ agents })`, which boots the Flue
 * runtime in the current process with no server, no `app.ts`, and no `'use agent'`
 * scan — the agent function *is* the agent, identified by its name. So a CLI needs
 * neither Vite nor Wrangler, and the same binary can open a terminal chat, serve
 * HTTP, or run a one-shot job.
 *
 * The Cloudflare target still builds through Vite, because Durable Object codegen
 * requires it — but it imports the same agent module, so there is one behaviour
 * across all three.
 *
 * Nothing here is specific to any church or account: a caller supplies its agent
 * and its name. Policy belongs in the project that owns the agent.
 */

export interface ElvantoCliOptions {
  /** The agent to run. */
  agent: Agent
  /** Program name, used in help and the chat prompt. */
  name: string
  /** One-line description for `--help`. */
  description?: string
  /** Title shown in the web chat header. Defaults to `name`. */
  title?: string
  /**
   * Where conversations are stored.
   *
   * Defaults to `./<name>.db` so a terminal conversation survives between
   * invocations — the alternative is in-memory state that vanishes on exit, which
   * makes `--id` meaningless. Pass `false` for that in-memory behaviour.
   */
  db?: string | false
  /** Extra subcommands, e.g. a scheduled job worth running by hand. */
  commands?: Record<string, ElvantoCliCommand>
}

export interface ElvantoCliCommand {
  describe: string
  /** Receives the remaining argv and a helper that runs one agent exchange. */
  run: (args: Args, run: (message: string, id?: string) => Promise<string>) => Promise<void>
}

export interface Args {
  positional: string[]
  flags: Record<string, string | boolean>
}

/** Minimal `--flag value`, `--flag=value` and `--boolean` parsing. */
export function parseArgs(argv: readonly string[]): Args {
  const positional: string[] = []
  const flags: Record<string, string | boolean> = {}

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!
    if (!arg.startsWith('--')) {
      positional.push(arg)
      continue
    }
    const [name, inline] = arg.slice(2).split(/=(.*)/s, 2)
    if (!name) continue
    if (inline !== undefined) {
      flags[name] = inline
      continue
    }
    const next = argv[index + 1]
    if (next !== undefined && !next.startsWith('--')) {
      flags[name] = next
      index++
    } else {
      flags[name] = true
    }
  }

  return { positional, flags }
}

function flagString(args: Args, name: string): string | undefined {
  const value = args.flags[name]
  return typeof value === 'string' ? value : undefined
}

/**
 * Runs the CLI. Resolves when the work is done; sets a non-zero exit code on
 * failure rather than throwing, so a shell sees a normal error.
 */
export async function runElvantoCli(
  options: ElvantoCliOptions,
  argv: readonly string[] = process.argv.slice(2),
): Promise<void> {
  silenceSqliteWarning()
  const args = parseArgs(argv)
  const title = options.title ?? options.name

  // Only a recognised word is a command; anything else is the question itself.
  // Without this, `elvanto "who is serving?"` reads its first word as a command
  // name and prints help — which is precisely the friction a bare-message CLI is
  // supposed to remove.
  const BUILTIN = new Set(['serve', 'chat', 'help'])
  const first = args.positional[0]
  const isCommand =
    first !== undefined && (BUILTIN.has(first) || first in (options.commands ?? {}))
  const command = isCommand ? first : undefined
  const rest = isCommand ? args.positional.slice(1) : args.positional

  if (args.flags['help'] || args.flags['h'] || command === 'help') {
    stdout.write(help(options))
    return
  }

  // Persistence before anything else: an `--id` that silently does not persist is
  // worse than no `--id` at all.
  const dbPath = options.db === false ? undefined : (options.db ?? `./${options.name}.db`)

  await using flue = await start({
    agents: [options.agent],
    ...(dbPath ? { db: sqlite(dbPath) } : {}),
  })
  void flue

  const runOnce = (message: string, id = 'cli') => ask(options.agent, id, message)

  try {
    switch (command) {
      case 'serve':
        await serve(options, args, title)
        return

      case undefined:
      case 'chat': {
        const id = flagString(args, 'id') ?? 'cli'
        const message = rest.join(' ').trim()

        // A piped or argument-supplied message is a one-shot; an interactive
        // terminal gets the loop. Checking isTTY means `echo … | elvanto chat`
        // behaves like a unix tool rather than hanging on a prompt.
        if (message) {
          await askOnce({ agent: options.agent, id, message, name: options.name })
        } else if (process.stdin.isTTY) {
          await chatLoop({ agent: options.agent, id, name: options.name })
        } else {
          const piped = await readStdin()
          if (!piped.trim()) {
            stderr.write(`${options.name}: nothing to ask. Pass a message, or run in a terminal.\n`)
            process.exitCode = 1
            return
          }
          await askOnce({ agent: options.agent, id, message: piped.trim(), name: options.name })
        }
        return
      }

      default: {
        // Reachable only for a name that matched `options.commands`, since
        // anything unrecognised was treated as a message above.
        const extra = options.commands?.[command]
        if (!extra) {
          stderr.write(`${options.name}: unknown command "${command}".\n\n${help(options)}`)
          process.exitCode = 1
          return
        }
        await extra.run({ ...args, positional: rest }, runOnce)
        return
      }
    }
  } catch (error) {
    // The message, not a stack: a failed run is usually a missing key or a bad
    // question, and a stack buries both.
    stderr.write(`${options.name}: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}

/**
 * Serves the agent's HTTP surface and the web chat.
 *
 * `@hono/node-server` rather than a hand-rolled `node:http` adapter, because the
 * agent router's streaming routes need proper request/response bridging and this is
 * the adapter Flue's own Node target uses.
 */
async function serve(options: ElvantoCliOptions, args: Args, title: string): Promise<void> {
  const { serve: honoServe } = await import('@hono/node-server')

  const port = Number(flagString(args, 'port') ?? process.env['PORT'] ?? 8787)
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`--port must be an integer between 1 and 65535.`)
  }
  const host = flagString(args, 'host') ?? '127.0.0.1'

  const app = buildApp(options, title)

  await new Promise<void>((resolve) => {
    honoServe({ fetch: app.fetch, port, hostname: host }, (info) => {
      stderr.write(
        `${options.name} listening on http://${host}:${info.port}/ ` +
          `(chat UI at /, API at /agents/${identityOf(options.agent)})\n`,
      )
      resolve()
    })
  })

  // Hold the process open until signalled.
  await new Promise<void>((resolve) => {
    const stop = () => resolve()
    process.once('SIGINT', stop)
    process.once('SIGTERM', stop)
  })
}

/** The Hono app: the agent's routes, plus the chat page. Exported for tests. */
export function buildApp(options: ElvantoCliOptions, title = options.name): Hono {
  const app = new Hono()
  const identity = identityOf(options.agent)
  const mount = `/agents/${identity}`

  app.route(mount, createAgentRouter(options.agent))

  app.get('/', (c) => {
    const conversationId = c.req.query('id') ?? 'web'
    return c.html(webChatPage({ mount, title, conversationId }))
  })

  return app
}

/**
 * The agent's durable identity — its `agentName` static, else the function name.
 *
 * The same rule `start()` applies, so the mount path matches the conversation
 * storage key rather than drifting from it.
 */
function identityOf(agent: Agent): string {
  const named = agent as { agentName?: string; name?: string }
  return (named.agentName ?? named.name ?? 'agent').toLowerCase()
}

/**
 * Drops Node's `node:sqlite` experimental warning.
 *
 * It comes from Flue's own persistence, fires on import, and tells the operator
 * nothing they can act on — but it prints on every single invocation, which
 * teaches people to ignore stderr. Only this one warning is filtered; everything
 * else still reaches the default handler.
 */
function silenceSqliteWarning(): void {
  const listeners = process.listeners('warning')
  process.removeAllListeners('warning')
  process.on('warning', (warning) => {
    if (warning.name === 'ExperimentalWarning' && /SQLite/i.test(warning.message)) return
    for (const listener of listeners) listener(warning)
  })
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

function help(options: ElvantoCliOptions): string {
  const lines = [
    [`${options.name} [chat] [message…]`, 'Ask one question, or open an interactive chat'],
    [`${options.name} serve`, 'Serve the HTTP API and a web chat UI'],
    ...Object.entries(options.commands ?? {}).map(
      ([name, command]) => [`${options.name} ${name}`, command.describe] as const,
    ),
  ]
  // Align on the longest invocation rather than a guessed column, so an added
  // command cannot push its description out of line.
  const width = Math.max(...lines.map(([invocation]) => invocation!.length)) + 3
  const usage = lines.map(([invocation, describe]) => `  ${invocation!.padEnd(width)}${describe}`)

  return `${options.name}${options.description ? ` — ${options.description}` : ''}

Usage:
${usage.join('\n')}

Options:
  --id <id>            Conversation to continue. Default "cli".
  --port <n>           serve only. Default 8787, or $PORT.
  --host <address>     serve only. Default 127.0.0.1.
  --help               This.

Conversations persist between runs, so reusing --id continues one. Reads
credentials from the environment (or .env): ELVANTO_API_KEY, and a model
provider key such as ANTHROPIC_API_KEY.
`
}

export { ask, askOnce, chatLoop } from './chat.ts'
export { webChatPage, type WebChatOptions } from './web.ts'
