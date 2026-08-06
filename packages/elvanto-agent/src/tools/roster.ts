import { defineTool, type ToolDefinition } from '@flue/runtime'
import * as v from 'valibot'
import type { ElvantoClient, Service } from '@criticalcodes/elvanto'
import {
  addDays,
  countPositions,
  isoDate,
  rosterEntries,
  serviceHeader,
  type RosterEntry,
  type ServiceHeader,
} from '../shape.ts'
import { cap, clientOf, clockOf, type ToolDeps } from './kit.ts'

/** Services one call may return. A fortnight of a multi-site church fits. */
const MAX_SERVICES = 12
/** Roster rows per service. A large church runs 60–80 positions on a Sunday. */
const MAX_ENTRIES_PER_SERVICE = 120
/** Days ahead `roster` covers when given no dates. */
const DEFAULT_WINDOW_DAYS = 14
/** Days ahead `next_serving` scans. */
const DEFAULT_LOOKAHEAD_DAYS = 90

const dateSchema = v.pipe(
  v.string(),
  v.trim(),
  v.regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected a date in YYYY-MM-DD format.'),
)

/**
 * Fetches services with their volunteer rosters attached.
 *
 * `all: 'yes'` unconditionally, because `services.getAll` otherwise returns only
 * upcoming services and silently ignores a `start` in the past — which would make
 * "who served last Sunday" answer "nobody" rather than failing.
 */
async function servicesInRange(
  client: ElvantoClient,
  start: string,
  end: string,
  signal: AbortSignal | undefined,
  maxRecords: number,
): Promise<Service[]> {
  const services: Service[] = []
  for await (const service of client.paginate(
    'services.getAll',
    {
      start,
      end,
      all: 'yes',
      fields: ['volunteers', 'service_times'],
    },
    { maxRecords, ...(signal ? { signal } : {}) },
  )) {
    services.push(service)
  }
  return services
}

export interface ServiceRoster extends ServiceHeader {
  /** Positions the service defines, whether or not anyone fills them. */
  positionCount: number
  /** People actually scheduled. Below `positionCount` means unfilled slots. */
  assignedCount: number
  entries: RosterEntry[]
  truncated?: { dropped: number; of: number; advice: string }
  /** Present when positions exist but nobody is in them. */
  note?: string
}

/**
 * Who is scheduled to serve, over a date range.
 *
 * Answers the single most common rostering question, which the raw API answers
 * only by way of a four-level nested structure keyed on Elvanto's own vocabulary.
 * See {@link rosterEntries} for what that flattening involves.
 */
export function roster(deps: ToolDeps): ToolDefinition {
  const clock = clockOf(deps)
  const getClient = clientOf(deps)

  return defineTool({
    name: 'roster',
    description:
      'List who is scheduled to serve, by service and position, over a date range. ' +
      'Pass date for a single day, or start and end for a range; with neither, it ' +
      `covers the next ${DEFAULT_WINDOW_DAYS} days. Past dates work. Each row gives ` +
      'the department, position, person and their confirmation status. Use this ' +
      'for "who is on this Sunday" and similar questions — do not try to assemble ' +
      'it from the raw service endpoints. Note the difference between ' +
      'positionCount and assignedCount: positions with nobody assigned mean the ' +
      'roster has not been filled in, which is not the same as a service needing ' +
      'no volunteers.',
    input: v.object({
      date: v.optional(
        v.pipe(dateSchema, v.description('A single day, YYYY-MM-DD.')),
      ),
      start: v.optional(
        v.pipe(dateSchema, v.description('Range start, YYYY-MM-DD. Used with end.')),
      ),
      end: v.optional(
        v.pipe(dateSchema, v.description('Range end, YYYY-MM-DD. Used with start.')),
      ),
      department: v.optional(
        v.pipe(
          v.string(),
          v.trim(),
          v.description(
            'Only positions whose department or sub-department contains this text, ' +
              'case-insensitive. Use it to narrow a large roster.',
          ),
        ),
      ),
    }),
    async run({ data, log, signal }) {
      const today = clock()
      const start = data.date ?? data.start ?? isoDate(today)
      const end = data.date ?? data.end ?? isoDate(addDays(today, DEFAULT_WINDOW_DAYS))

      if (start > end) {
        // Cheaper to say so than to return an empty roster the model will read as
        // "nobody is serving".
        return {
          output: {
            error: `start (${start}) is after end (${end}).`,
          },
        }
      }

      const services = await servicesInRange(getClient(), start, end, signal, MAX_SERVICES)
      const needle = data.department?.toLowerCase()

      const rosters: ServiceRoster[] = services.map((service) => {
        let entries = rosterEntries(service)
        if (needle) {
          entries = entries.filter(
            (entry) =>
              entry.department?.toLowerCase().includes(needle) ||
              entry.subDepartment?.toLowerCase().includes(needle),
          )
        }

        const capped = cap(
          entries,
          MAX_ENTRIES_PER_SERVICE,
          'Filter by department to see the rest.',
        )
        const positions = countPositions(service)
        return {
          ...serviceHeader(service),
          positionCount: positions,
          assignedCount: capped.items.length,
          entries: capped.items,
          ...(capped.truncated ? { truncated: capped.truncated } : {}),
          // The distinction that matters: an empty roster on a service with
          // positions is work outstanding, not a service that needs nobody.
          ...(positions > 0 && capped.items.length === 0
            ? {
                note:
                  `${positions} position(s) are defined but nobody is assigned to any ` +
                  `of them — the roster for this service has not been filled in.`,
              }
            : {}),
          ...(positions === 0 && capped.items.length === 0
            ? { note: 'This service defines no volunteer positions at all.' }
            : {}),
        }
      })

      log.info(`roster: ${services.length} service(s) between ${start} and ${end}`)

      const scheduled = rosters.reduce((sum, r) => sum + r.assignedCount, 0)
      const positions = rosters.reduce((sum, r) => sum + r.positionCount, 0)
      return {
        output: {
          range: { start, end },
          serviceCount: rosters.length,
          positionCount: positions,
          scheduledCount: scheduled,
          services: rosters,
          ...(services.length >= MAX_SERVICES
            ? {
                truncated: {
                  advice:
                    `Stopped at ${MAX_SERVICES} services. Narrow the date range to ` +
                    `see the rest.`,
                },
              }
            : {}),
          ...(rosters.length === 0
            ? {
                advice:
                  'No services in that range. Check the dates, or the services may ' +
                  'not be published yet.',
              }
            : {}),
        },
      }
    },
  })
}

/**
 * When one person is next scheduled.
 *
 * The inverse of {@link roster}, and the reason it is a tool rather than a prompt:
 * Elvanto has no person-centric roster endpoint at all. The only way to answer it
 * is to walk forward through services and search each volunteer tree for the
 * person — which is precisely the kind of loop a model should not be running by
 * hand, one tool call per service.
 */
export function nextServing(deps: ToolDeps): ToolDefinition {
  const clock = clockOf(deps)
  const getClient = clientOf(deps)

  return defineTool({
    name: 'next_serving',
    description:
      'Find the upcoming services a specific person is scheduled to serve at, ' +
      'with their position. Requires a person id — call find_person first to ' +
      `resolve a name. Scans the next ${DEFAULT_LOOKAHEAD_DAYS} days by default. ` +
      'Elvanto has no per-person roster endpoint, so this is the only way to ' +
      'answer it.',
    input: v.object({
      person_id: v.pipe(
        v.string(),
        v.trim(),
        v.minLength(1, 'A person id is required — use find_person to get one.'),
      ),
      days: v.optional(
        v.pipe(
          v.number(),
          v.integer(),
          v.minValue(1),
          v.maxValue(365),
          v.description(`Days ahead to scan. Default ${DEFAULT_LOOKAHEAD_DAYS}.`),
        ),
      ),
    }),
    async run({ data, log, signal }) {
      const today = clock()
      const days = data.days ?? DEFAULT_LOOKAHEAD_DAYS
      const start = isoDate(today)
      const end = isoDate(addDays(today, days))

      // A wider window needs more services than `roster` does, since most will
      // not involve this person.
      const services = await servicesInRange(getClient(), start, end, signal, 60)

      const assignments = services.flatMap((service) => {
        const mine = rosterEntries(service).filter(
          (entry) => entry.person.id === data.person_id,
        )
        return mine.map((entry) => ({
          service: serviceHeader(service),
          department: entry.department,
          subDepartment: entry.subDepartment,
          position: entry.position,
          status: entry.status,
        }))
      })

      log.info(
        `next_serving: ${assignments.length} assignment(s) across ` +
          `${services.length} service(s)`,
      )

      return {
        output: {
          personId: data.person_id,
          range: { start, end },
          count: assignments.length,
          assignments,
          ...(assignments.length === 0
            ? {
                advice:
                  `Not scheduled in the next ${days} days. They may be rostered ` +
                  `further out — raise days — or the services may not be published yet.`,
              }
            : {}),
        },
      }
    },
  })
}
