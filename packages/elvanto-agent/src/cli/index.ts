import { type Agent } from '@flue/runtime'
import type { TokenSource } from '@criticalcodes/elvanto'
import { sqlite, start } from '@flue/runtime/node'
import { stderr, stdout } from 'node:process'
import { ask, askOnce, chatLoop } from './chat.ts'
import { runLogin, runLogout, runWhoami, storedGrant } from './auth.ts'
import { setProcessTokenSource } from '../client.ts'
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
  /**
   * The Elvanto credential for this process.
   *
   * Defaults to the grant `login` stored, when neither `ELVANTO_API_KEY` nor
   * `ELVANTO_ACCESS_TOKEN` is set — so signing in once is enough and no secret has
   * to stay in the environment. Pass a {@link TokenSource} of your own to take the
   * credential from somewhere else entirely (a secrets manager, a test double), or
   * `false` to use only what the environment provides.
   *
   * Installed process-wide before the agent runs, which is what lets an agent
   * module that calls `clientFromEnv()` pick it up without being rewritten. See
   * {@link setProcessTokenSource}.
   */
  auth?: TokenSource | false
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
  const BUILTIN = new Set(['chat', 'help', 'login', 'logout', 'whoami'])
  const first = args.positional[0]
  const isCommand =
    first !== undefined && (BUILTIN.has(first) || first in (options.commands ?? {}))
  const command = isCommand ? first : undefined
  const rest = isCommand ? args.positional.slice(1) : args.positional

  if (args.flags['help'] || args.flags['h'] || command === 'help') {
    stdout.write(help(options))
    return
  }

  // Before `start()`: none of these needs an agent, and `login` in particular has
  // to work when there are no credentials at all — which is the whole reason
  // somebody is running it.
  if (command === 'login' || command === 'logout' || command === 'whoami') {
    try {
      process.exitCode =
        command === 'login'
          ? await runLogin(args, process.env)
          : command === 'logout'
            ? await runLogout(process.env)
            : runWhoami(process.env)
    } catch (error) {
      stderr.write(`${options.name}: ${describe(error)}\n`)
      process.exitCode = 1
    }
    return
  }

  // After the .env load, so a grant configured there is visible, and after the
  // auth commands, which must run without one.
  if (options.auth !== false) {
    setProcessTokenSource(options.auth ?? storedGrant(process.env))
  }

  // Persistence before anything else: an `--id` that silently does not persist is
  // worse than no `--id` at all.
  const dbPath = options.db === false ? undefined : (options.db ?? `./${options.name}.db`)

  await using flue = await start({
    agents: [options.agent],
    ...(dbPath ? { db: sqlite(dbPath) } : {}),
  })
  void flue

  /**
   * The conversation to use.
   *
   * A fresh id when none is given, matching `flue run`. An earlier version
   * defaulted to the fixed string `'cli'`, which meant every invocation continued
   * one ever-growing conversation: unrelated questions re-answered each other, the
   * transcript grew without bound, and member data retrieved for one question
   * stayed in context for the next. Continuing a conversation has to be something
   * you ask for.
   *
   * Printed to stderr — never stdout, which carries only the reply — because an id
   * you cannot see is an id you cannot continue.
   */
  const explicitId = flagString(args, 'id')
  const conversationId = explicitId ?? freshConversationId()
  // Not for the interactive loop, whose own header already names it.
  if (!explicitId && !(command === undefined && rest.length === 0 && process.stdin.isTTY)) {
    stderr.write(`${options.name}: conversation ${conversationId}\n`)
  }

  const runOnce = (message: string, id = conversationId) => ask(options.agent, id, message)

  try {
    switch (command) {
      case undefined:
      case 'chat': {
        const id = conversationId
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
          id: conversationId,
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

/**
 * A fresh conversation id.
 *
 * Time-ordered so a directory listing of conversations reads chronologically, and
 * random-suffixed so two invocations in the same millisecond cannot collide.
 * `crypto.randomUUID` rather than a ULID dependency — nothing here needs the
 * lexicographic guarantees a real ULID buys.
 */
function freshConversationId(): string {
  return `cli-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`
}

/** Exported for the regression test that pins the default away from a fixed id. */
export const freshIdForTest = freshConversationId

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
    // Last, and after the caller's own: these are plumbing, and a reader looking
    // for what this binary *does* should not meet sign-in first.
    ...(options.auth === false
      ? []
      : ([
          [`${options.name} login`, 'Sign in to Elvanto with OAuth and store the grant'],
          [`${options.name} logout`, 'Forget the stored grant'],
          [`${options.name} whoami`, 'Show which Elvanto credential is in use'],
        ] as const)),
  ]
  // Align on the longest invocation rather than a guessed column, so an added
  // command cannot push its description out of line.
  const width = Math.max(...lines.map(([invocation]) => invocation!.length)) + 3
  const usage = lines.map(([invocation, describe]) => `  ${invocation!.padEnd(width)}${describe}`)

  return `${options.name}${options.description ? ` — ${options.description}` : ''}

Usage:
${usage.join('\n')}

Options:
  --id <id>            Conversation to create or continue. Defaults to a fresh
                       one per invocation, printed on stderr.
  --json               Print one JSON result envelope instead of the reply.
  --env <path>         Load this .env-format file instead of ./.env.
  --help               This.

Each run starts a new conversation unless --id names one; pass the same --id
again to continue it.

Elvanto credentials, in the order they are consulted:
  ELVANTO_API_KEY        Secret API key (Settings > Account Settings)
  ELVANTO_ACCESS_TOKEN   A fixed OAuth access token
  a stored grant         Written by \`login\`, refreshed automatically

\`login\` needs an OAuth application (Elvanto: Settings > Integrations) with
http://127.0.0.1:8975/callback as its redirect URI, and its ELVANTO_CLIENT_ID
and ELVANTO_CLIENT_SECRET set — in the environment, in .env, or as flags. Those
are needed only to sign in; refreshing afterwards needs neither.

A model provider key such as ANTHROPIC_API_KEY is also read from the
environment or .env.

To serve HTTP and the web chat UI, build the app instead — Flue emits the
server, so there is nothing to run by hand here:
  vite build && node dist/server.mjs        # Node
  vite build && wrangler deploy             # Cloudflare
`
}

export { ask, askOnce, chatLoop } from './chat.ts'
export { webChatPage, type WebChatOptions } from './web.ts'
