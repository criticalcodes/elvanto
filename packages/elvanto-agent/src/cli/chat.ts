import { createInterface } from 'node:readline/promises'
import { stdin, stdout } from 'node:process'
import { init, type Agent } from '@flue/runtime'

/**
 * An interactive terminal chat with an agent.
 *
 * No HTTP, no server, no browser: `start()` has already booted the runtime in this
 * process, so this talks to the agent directly through the `init()` handle. That is
 * the whole reason a TUI is worth having here — it is the shortest path from a
 * question to an answer, and it works before anything is deployed.
 *
 * Deliberately built on `node:readline` rather than a TUI framework. A chat is a
 * prompt and a reply; a full-screen renderer would add a dependency, break piping,
 * and fight the terminal over scrollback that a plain transcript gets for free.
 */

const DIM = '[2m'
const BOLD = '[1m'
const RESET = '[0m'

/** Colour only when a human is watching — piped output stays clean. */
function style(text: string, code: string): string {
  return stdout.isTTY ? `${code}${text}${RESET}` : text
}

export interface ChatOptions {
  agent: Agent
  /** Conversation id. Reusing one continues it, if persistence is configured. */
  id: string
  /** A label for the prompt, e.g. the command name. */
  name?: string
}

export interface Exchange {
  text: string
  submissionId: string
  uid?: string
}

/**
 * Runs one exchange.
 *
 * Shared by the interactive loop and the one-shot path, so a scripted invocation
 * and a typed message go through exactly the same code.
 *
 * No create-only mode: `AgentHandleDispatchRequest` omits `uid`, so the
 * exactly-once creation `flue run --new` offers is not reachable from the handle.
 * Reimplementing it some other way would be guesswork against a contract the
 * framework deliberately narrowed — use `flue run --new` for that CI case.
 */
export async function askFull(agent: Agent, id: string, message: string): Promise<Exchange> {
  const handle = init(agent, { id })
  const receipt = await handle.dispatch(message)
  const reply = await handle.read(receipt)
  return {
    text: reply.text,
    submissionId: reply.submissionId,
    ...(reply.uid ? { uid: reply.uid } : {}),
  }
}

/** The reply text alone — what most callers want. */
export async function ask(agent: Agent, id: string, message: string): Promise<string> {
  return (await askFull(agent, id, message)).text
}

/** One message in, one reply out, for `chat "…"` and for piped stdin. */
export async function askOnce(
  options: ChatOptions & { message: string; json?: boolean },
): Promise<void> {
  const exchange = await askFull(options.agent, options.id, options.message)

  // stdout carries the reply and nothing else, so it stays pipeable. With --json
  // it carries exactly one envelope instead, matching `flue run --json` so the
  // same `jq -r .message` works against either.
  stdout.write(
    options.json
      ? `${JSON.stringify({
          id: options.id,
          agent: options.name ?? 'agent',
          submissionId: exchange.submissionId,
          outcome: 'completed',
          message: exchange.text,
          ...(exchange.uid ? { uid: exchange.uid } : {}),
        })}\n`
      : `${exchange.text}\n`,
  )
}

/**
 * The interactive loop.
 *
 * Errors from one turn are reported and the loop continues: a failed tool call or
 * a rate limit should not end the session and lose the conversation.
 */
export async function chatLoop(options: ChatOptions): Promise<void> {
  const label = options.name ?? 'elvanto'
  const rl = createInterface({ input: stdin, output: stdout })

  stdout.write(
    `${style(`${label} — conversation ${options.id}`, BOLD)}\n` +
      `${style('Type a question. Ctrl-D or /exit to leave.', DIM)}\n\n`,
  )

  try {
    for (;;) {
      let line: string
      try {
        line = await rl.question(style('› ', BOLD))
      } catch {
        // Ctrl-C/Ctrl-D reject the question rather than returning.
        break
      }

      const message = line.trim()
      if (!message) continue
      if (message === '/exit' || message === '/quit') break

      try {
        stdout.write(style('…thinking\n', DIM))
        const text = await ask(options.agent, options.id, message)
        stdout.write(`\n${text}\n\n`)
      } catch (error) {
        // Keep the session — the conversation is durable and the next question
        // may well work.
        stdout.write(
          `\n${style(`error: ${error instanceof Error ? error.message : String(error)}`, DIM)}\n\n`,
        )
      }
    }
  } finally {
    rl.close()
  }

  stdout.write(`${style('bye', DIM)}\n`)
}
