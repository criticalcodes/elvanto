import { defineTool, type ToolDefinition } from '@flue/runtime'
import * as v from 'valibot'
import type { Person } from '@criticalcodes/elvanto'
import { personCard, type PersonCard } from '../shape.ts'
import { cap, clientOf, type ToolDeps } from './kit.ts'

/** Hard ceiling on returned matches, whatever the caller asks for. */
const MAX_MATCHES = 25
const DEFAULT_MATCHES = 10

/**
 * How many searches one call may issue.
 *
 * Elvanto ANDs the keys of a `search` map, so "Josh Cuneo" cannot be matched
 * against "either name" in a single request — finding someone takes a few
 * attempts. Three is enough for every strategy below and bounds the latency a
 * single tool call can add to a conversation.
 */
const MAX_ATTEMPTS = 3

/** One search to try, and how to describe it if it hits. */
interface Attempt {
  search: Record<string, string>
  matchedOn: string
}

/**
 * Turns free text into an ordered list of searches to try.
 *
 * Exported for tests: the ordering is the substance of this tool, and asserting
 * it directly is more useful than inferring it from recorded HTTP calls.
 */
export function attemptsFor(query: string): Attempt[] {
  const trimmed = query.trim()

  if (trimmed.includes('@')) {
    return [{ search: { email: trimmed }, matchedOn: 'email' }]
  }

  // Six digits is the shortest thing plausibly a phone number rather than a
  // house number or a year in a nickname.
  const digits = trimmed.replace(/\D/g, '')
  if (digits.length >= 6 && /^[\d\s()+-]+$/.test(trimmed)) {
    return [
      { search: { mobile: trimmed }, matchedOn: 'mobile' },
      { search: { phone: trimmed }, matchedOn: 'phone' },
    ]
  }

  const tokens = trimmed.split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return []

  if (tokens.length === 1) {
    const only = tokens[0]!
    // Surname first: it is both the more selective field and the more common way
    // a single name is used in this context ("is Cuneo rostered?").
    return [
      { search: { lastname: only }, matchedOn: 'lastname' },
      { search: { firstname: only }, matchedOn: 'firstname' },
      { search: { preferred_name: only }, matchedOn: 'preferred name' },
    ]
  }

  const first = tokens[0]!
  const last = tokens[tokens.length - 1]!
  return [
    { search: { firstname: first, lastname: last }, matchedOn: 'first and last name' },
    // Falls back to surname alone, which catches a preferred name the caller
    // guessed wrong ("Jon Smith" for a Jonathan who goes by Jonny).
    { search: { lastname: last }, matchedOn: 'lastname' },
    { search: { preferred_name: first, lastname: last }, matchedOn: 'preferred and last name' },
  ]
}

export interface PersonMatch extends PersonCard {
  /** Which search found them, so the model can judge how strong the match is. */
  matchedOn: string
}

/**
 * Finds people by free text, and returns identity cards rather than records.
 *
 * The tool that earns its place most clearly. Without it a model has to choose
 * between `people_get_all` and `people_search`, know that the latter takes a
 * field-to-keyword map rather than a query string, know which keys are
 * searchable, and then page through full person records to read a name and an
 * email off them. This does the search strategy once and returns four fields per
 * person.
 */
export function findPerson(deps: ToolDeps): ToolDefinition {
  const getClient = clientOf(deps)

  return defineTool({
    name: 'find_person',
    description:
      'Find people in Elvanto by name, email address or phone number, and return ' +
      'a short identity card for each match (id, name, email, phone). Use this ' +
      'before any tool that needs a person id. Accepts free text: a full name, a ' +
      'surname alone, an email, or a phone number — it tries the appropriate ' +
      'searches in order and merges the results. Archived people are excluded ' +
      'unless include_archived is true.',
    input: v.object({
      query: v.pipe(
        v.string(),
        v.trim(),
        v.minLength(1, 'Provide a name, email address or phone number to search for.'),
      ),
      limit: v.optional(
        v.pipe(
          v.number(),
          v.integer(),
          v.minValue(1),
          v.maxValue(MAX_MATCHES),
          v.description(`Maximum matches to return. Default ${DEFAULT_MATCHES}.`),
        ),
      ),
      include_archived: v.optional(
        v.pipe(
          v.boolean(),
          v.description('Include archived people. Default false.'),
        ),
      ),
    }),
    async run({ data, log, signal }) {
      const limit = data.limit ?? DEFAULT_MATCHES
      const attempts = attemptsFor(data.query).slice(0, MAX_ATTEMPTS)

      if (attempts.length === 0) {
        return { output: { query: data.query, matches: [], searched: [] } }
      }

      const byId = new Map<string, PersonMatch>()
      const searched: string[] = []

      for (const attempt of attempts) {
        if (byId.size >= limit) break

        const search: Record<string, string> = { ...attempt.search }
        // Elvanto ANDs these, so this narrows rather than filtering afterwards —
        // which also means archived people never enter the context at all.
        if (!data.include_archived) search['archived'] = 'no'

        searched.push(attempt.matchedOn)

        // `paginate` rather than a direct call: Elvanto answers "nothing matched"
        // with a 404, which is an empty result here and not an error.
        const found: Person[] = []
        for await (const person of getClient().paginate(
          'people.search',
          { search },
          { maxRecords: limit, ...(signal ? { signal } : {}) },
        )) {
          found.push(person)
        }

        for (const person of found) {
          // First strategy to find someone wins the `matchedOn` label, since
          // attempts run strongest-first.
          if (!byId.has(person.id)) {
            byId.set(person.id, { ...personCard(person), matchedOn: attempt.matchedOn })
          }
        }

        // Counts only — never the names or the query itself, which are the
        // sensitive parts and would otherwise land in a durable transcript.
        log.info(`find_person: ${attempt.matchedOn} matched ${found.length}`)
      }

      const capped = cap(
        [...byId.values()],
        limit,
        'Narrow the query, or raise limit to see more.',
      )

      return {
        output: {
          query: data.query,
          searched,
          count: capped.items.length,
          matches: capped.items,
          ...(capped.truncated ? { truncated: capped.truncated } : {}),
          ...(capped.items.length === 0
            ? {
                advice:
                  'No matches. Check the spelling, try a surname alone, or set ' +
                  'include_archived to true — archived people are excluded by default.',
              }
            : {}),
        },
      }
    },
  })
}
