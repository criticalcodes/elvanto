import { type Agent } from '@flue/runtime'
import { sqlite, start } from '@flue/runtime/node'
import { stderr, stdout } from 'node:process'
import { ask, askOnce, chatLoop } from './chat.ts'
import { webChatPage } from './web.ts'

/**
 * A terminal front end for an agent.
 *
 * Deliberately narrow: it covers only what Flue does not already provide. Flue has
 * no interactive chat, so that is here. Flue *does* build a server — `vite build`
 * emits `dist/server.mjs` for Node and a Worker for Cloudflare from `src/app.ts` —
 * so this does not serve HTTP. An earlier version did, reproducing the build with
 * an extra dependency and working only on Node; mount `elvantoRoutes()` in
 * `app.ts` instead.
 *
 * `start({ agents })` is what makes the terminal path work without a build: it
 * boots the runtime in the current process with no server and no `'use agent'`
 * scan — the agent function *is* the agent, identified by its name.
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
  /**
   * Where conversations are stored.
   *
   * Defaults to `./<name>.db` so a terminal conversation survives between
   * invocations — the alternative is in-memory state that vanishes on exit, which
   * makes `--id` meaningless. Pass `false` for that in-memory behaviour.
   */
  db?: string | false
  /**
   * A dotenv file to load before starting, relative to the working directory.
   * Defaults to `.env`; `false` skips it.
   *
   * Loading it is not optional politeness — `flue run` and `vite dev` both read
   * `.env`, so a project whose keys live there works under those and would fail
   * under a hand-rolled entry that skipped it. Real environment variables win over
   * the file, which is what `process.loadEnvFile` does and what a deployment
   * expects.
   */
  envFile?: string | false
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

  // `--env` wins over the option, which wins over the default, matching
  // `flue run --env`.
  const envFile = flagString(args, 'env') ?? (options.envFile === false ? null : (options.envFile ?? '.env'))
  if (envFile) loadEnvFile(envFile)

  // Only a recognised word is a command; anything else is the question itself.
  // Without this, `elvanto "who is serving?"` reads its first word as a command
  // name and prints help — which is precisely the friction a bare-message CLI is
  // supposed to remove.
  const BUILTIN = new Set(['chat', 'help'])
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
      case undefined:
      case 'chat': {
        const id = flagString(args, 'id') ?? 'cli'
        const message = rest.join(' ').trim()

        // A piped or argument-supplied message is a one-shot; an interactive
        // terminal gets the loop. Checking isTTY means `echo … | elvanto chat`
        // behaves like a unix tool rather than hanging on a prompt.
        const json = args.flags['json'] === true

        if (message) {
          await askOnce({
            agent: options.agent,
            id,
            message,
            name: options.name,
            json,
          })
        } else if (process.stdin.isTTY) {
          await chatLoop({ agent: options.agent, id, name: options.name })
        } else {
          const piped = await readStdin()
          if (!piped.trim()) {
            stderr.write(`${options.name}: nothing to ask. Pass a message, or run in a terminal.\n`)
            process.exitCode = 1
            return
          }
          await askOnce({
            agent: options.agent,
            id,
            message: piped.trim(),
            name: options.name,
            json,
          })
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
    const detail = describe(error)
    const aborted = /abort/i.test(detail)

    if (args.flags['json'] === true) {
      // One envelope for every terminal result, as `flue run --json` promises —
      // a script must not have to parse stderr to learn what happened.
      stdout.write(
        `${JSON.stringify({
          id: flagString(args, 'id') ?? 'cli',
          agent: options.name,
          outcome: aborted ? 'aborted' : 'failed',
          error: { message: detail },
        })}\n`,
      )
    } else {
      stderr.write(`${options.name}: ${explain(detail, options)}\n`)
    }
    // 130 for an abort, matching `flue run` and the shell convention for SIGINT.
    process.exitCode = aborted ? 130 : 1
  }
}

/**
 * Flattens an error into every message it carries.
 *
 * The reason a run failed is rarely on the top-level error: Flue wraps it, so
 * `AgentRunError.message` is "Agent run failed (submission …)" and the actual cause
 * — "Provider is not configured: anthropic" — sits on a nested error or on
 * `meta.reason`. Reading only the outer message loses the one useful sentence, so
 * this gathers all of them and lets {@link explain} match against the lot.
 *
 * Deliberately tolerant of shape rather than typed against Flue's error classes:
 * the nesting is an implementation detail, and a version that rearranges it should
 * degrade to a worse message, not to a wrong one.
 */
function describe(error: unknown): string {
  const seen = new Set<unknown>()
  const parts: string[] = []

  const walk = (value: unknown, depth: number): void => {
    if (depth > 5 || value === null || typeof value !== 'object' || seen.has(value)) return
    seen.add(value)

    const record = value as { message?: unknown; meta?: unknown; cause?: unknown }
    if (typeof record.message === 'string') parts.push(record.message)
    const meta = record.meta as { reason?: unknown } | undefined
    if (meta && typeof meta.reason === 'string') parts.push(meta.reason)
    walk(record.cause, depth + 1)
  }

  if (typeof error === 'string') return error
  walk(error, 0)
  return parts.length > 0 ? [...new Set(parts)].join(' — ') : String(error)
}

/**
 * Turns a runtime failure into something actionable.
 *
 * "Provider is not configured: anthropic" is accurate and tells you nothing about
 * what to do — and it arrives wrapped in a page of Flue's own stack, so the useful
 * sentence has to be worth finding.
 */
function explain(message: string, options: ElvantoCliOptions): string {
  const provider = /Provider is not configured: (\S+)/.exec(message)?.[1]
  if (!provider) return message

  const variable = PROVIDER_ENV[provider] ?? `${provider.toUpperCase()}_API_KEY`
  const file = options.envFile === false ? null : (options.envFile ?? '.env')

  return (
    `no API key for the "${provider}" model provider.\n\n` +
    `  Set ${variable}${file ? ` in ${file}, or in the environment` : ' in the environment'}:\n` +
    `      ${variable}=…\n\n` +
    `  The model is chosen by useModel() in the agent, so if you meant to use a ` +
    `different\n  provider, change it there instead.`
  )
}

/** The env var each provider reads. Anything unlisted follows the same convention. */
const PROVIDER_ENV: Record<string, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  google: 'GEMINI_API_KEY',
  groq: 'GROQ_API_KEY',
  mistral: 'MISTRAL_API_KEY',
  moonshot: 'MOONSHOT_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  xai: 'XAI_API_KEY',
}

/**
 * Loads a dotenv file if it is there.
 *
 * `process.loadEnvFile` throws when the file is absent, which is a normal state —
 * a deployment supplies real environment variables and has no `.env` at all. It
 * also leaves already-set variables alone, so the environment beats the file.
 */
function loadEnvFile(path: string): void {
  try {
    process.loadEnvFile(path)
  } catch {
    // Absent, unreadable, or a Node without the API. Any real missing value shows
    // up as a specific error later, with better advice than this could give.
  }
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
  --id <id>            Conversation to create or continue. Default "cli".
  --json               Print one JSON result envelope instead of the reply.
  --env <path>         Load this .env-format file instead of ./.env.
  --help               This.

Conversations persist between runs, so reusing --id continues one. Reads
credentials from the environment (or .env): ELVANTO_API_KEY, and a model
provider key such as ANTHROPIC_API_KEY.

To serve HTTP and the web chat UI, build the app instead — Flue emits the
server, so there is nothing to run by hand here:
  vite build && node dist/server.mjs        # Node
  vite build && wrangler deploy             # Cloudflare
`
}

export { ask, askOnce, chatLoop } from './chat.ts'
export { webChatPage, type WebChatOptions } from './web.ts'
