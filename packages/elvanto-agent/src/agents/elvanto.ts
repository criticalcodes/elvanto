'use agent'
import { useInitialData, useModel } from '@flue/runtime'
import { useElvantoBase } from '../base.ts'
import { clientForPerson, personTokenSourceFromEnv } from '../client.ts'
import { sessionStore } from '#sessions'

/**
 * A general-purpose Elvanto assistant.
 *
 * Intentionally this short. Everything it can do comes from `useElvantoBase()`,
 * and the only thing this file decides is which model runs and who the agent is —
 * which is the shape a consuming project should copy. Anything account-specific
 * (a credential profile, local policy, notice wording) belongs in the project that
 * owns it, mounted with `useTool` after the base hook.
 *
 * Run it directly:
 *
 * ```console
 * $ flue run src/agents/elvanto.ts --message "Who is on the roster this Sunday?"
 * ```
 */
export function Elvanto() {
  // Sonnet over Haiku: these tools return structured results that need reasoning
  // over — reconciling a roster against a request, deciding whether a truncated
  // result is good enough — and the cheaper model tends to report the first match
  // it sees rather than asking which of two people was meant.
  useModel('anthropic/claude-sonnet-5')

  // Who this conversation belongs to, recorded when it was created and checked
  // against the session by the guard in front of the mount. Absent when the
  // deployment runs without sign-in, in which case the base hook falls back to
  // the account-wide key in the environment.
  //
  // Only the id is durable. The grant it points at lives in the session store,
  // because the record log this is read from is explicitly not a secrets channel.
  const person = useInitialData<{ personId?: string } | undefined>()

  useElvantoBase(
    person?.personId
      ? {
          client: () =>
            clientForPerson(personTokenSourceFromEnv(sessionStore(), person.personId!)),
        }
      : {},
  )

  return (
    'You are an assistant for a church office team, working with their Elvanto ' +
    'account. Be brief and concrete: staff are usually checking one fact — who is ' +
    'serving, when someone last sang a song, what is on this Sunday. Lead with the ' +
    'answer, then the detail if it helps.\n\n' +
    'When a request is ambiguous about which person or which service is meant, ask ' +
    'rather than picking one.'
  )
}
