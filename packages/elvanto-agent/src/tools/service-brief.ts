import { defineTool, type ToolDefinition } from '@flue/runtime'
import * as v from 'valibot'
import type { Service } from '@criticalcodes/elvanto'
import { rosterEntries, serviceHeader } from '../shape.ts'
import { cap, clientOf, clockOf, type ToolDeps } from './kit.ts'

const MAX_PLAN_ITEMS = 60
const MAX_NOTES = 10
/** Notes are free text and occasionally very long. */
const MAX_NOTE_CHARS = 500

/**
 * Every optional field a service can carry.
 *
 * Named explicitly rather than fetched piecemeal: they cost one request together
 * and several separately, and the whole point of this tool is one round trip.
 */
const ALL_FIELDS = [
  'series_name',
  'service_times',
  'plans',
  'volunteers',
  'songs',
  'notes',
] as const

/**
 * One service, assembled.
 *
 * Optional service fields are only returned when named in `fields`, which a model
 * reliably forgets — leading it to conclude a service has no songs when it simply
 * did not ask for them. This asks for everything once and reshapes the result.
 *
 * Caveat worth knowing: of the sub-structures here, only the envelope,
 * `service_times` and the `volunteers` tree have been confirmed against a real
 * account. `plans`, `songs` and `notes` came back empty on every service in the
 * live sweep, so their shapes still follow Elvanto's documentation alone.
 */
export function serviceBrief(deps: ToolDeps): ToolDefinition {
  const clock = clockOf(deps)
  const getClient = clientOf(deps)

  return defineTool({
    name: 'service_brief',
    description:
      'Get everything about one service in a single call: times, songs with keys, ' +
      'the running sheet, who is serving, and any notes. Pass service_id, or date ' +
      'to take the first service on that day. Prefer this over the raw service ' +
      'endpoints, which return optional sections only when explicitly requested.',
    input: v.object({
      service_id: v.optional(
        v.pipe(v.string(), v.trim(), v.description('The service id.')),
      ),
      date: v.optional(
        v.pipe(
          v.string(),
          v.trim(),
          v.regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected a date in YYYY-MM-DD format.'),
          v.description('A date, YYYY-MM-DD. The first service that day is used.'),
        ),
      ),
    }),
    async run({ data, log, signal }) {
      const options = signal ? { signal } : {}

      let service: Service | undefined
      if (data.service_id) {
        service = await getClient().services.getInfo(
          { id: data.service_id, fields: [...ALL_FIELDS] },
          options,
        )
      } else {
        const date = data.date ?? new Date(clock()).toISOString().slice(0, 10)
        for await (const found of getClient().paginate(
          'services.getAll',
          { start: date, end: date, all: 'yes', fields: [...ALL_FIELDS] },
          { maxRecords: 1, ...options },
        )) {
          service = found
        }
        if (!service) {
          return {
            output: {
              advice:
                `No service found on ${date}. Check the date, or use roster over a ` +
                `range to see what is scheduled.`,
            },
          }
        }
      }

      const songs = (service.songs ?? []).map((song) => {
        const arrangement =
          song.arrangement && typeof song.arrangement === 'object' ? song.arrangement : undefined
        return {
          title: song.title,
          artist: song.artist,
          // Elvanto exposes the key under two names depending on the endpoint.
          key: arrangement?.key_name ?? arrangement?.key,
          bpm: arrangement?.bpm,
        }
      })

      const planItems = (service.plans ?? []).flatMap((plan) =>
        (plan.items ?? []).map((item) => ({
          ...(item.heading ? { heading: true } : {}),
          title: item.title,
          duration: item.duration,
          when: item.when,
          ...(item.song && typeof item.song === 'object' && item.song.title
            ? { song: item.song.title }
            : {}),
          ...(item.description ? { description: truncate(item.description, MAX_NOTE_CHARS) } : {}),
        })),
      )
      const cappedPlan = cap(planItems, MAX_PLAN_ITEMS, 'The running sheet is longer than shown.')

      const entries = rosterEntries(service)
      // Grouped by department, because that is how a service is staffed and read.
      const byDepartment = new Map<string, string[]>()
      for (const entry of entries) {
        const key = entry.subDepartment
          ? `${entry.department ?? 'Unknown'} / ${entry.subDepartment}`
          : (entry.department ?? 'Unknown')
        const label = entry.position ? `${entry.person.name} (${entry.position})` : entry.person.name
        byDepartment.set(key, [...(byDepartment.get(key) ?? []), label])
      }

      const notes = cap(
        (service.notes ?? [])
          .map((note) => note.note)
          .filter((note): note is string => Boolean(note))
          .map((note) => truncate(note, MAX_NOTE_CHARS)),
        MAX_NOTES,
        'More notes exist than shown.',
      )

      log.info(
        `service_brief: ${songs.length} song(s), ${cappedPlan.items.length} plan item(s), ` +
          `${entries.length} volunteer(s)`,
      )

      return {
        output: {
          ...serviceHeader(service),
          seriesName: service.series_name,
          times: (service.service_times ?? []).map((time) => ({
            name: time.name,
            starts: time.starts,
            ends: time.ends,
          })),
          songs,
          plan: cappedPlan.items,
          ...(cappedPlan.truncated ? { planTruncated: cappedPlan.truncated } : {}),
          volunteers: Object.fromEntries(byDepartment),
          volunteerCount: entries.length,
          notes: notes.items,
          ...(notes.truncated ? { notesTruncated: notes.truncated } : {}),
        },
      }
    },
  })
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}… (truncated)`
}
