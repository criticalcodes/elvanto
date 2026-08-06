import { defineTool, type ToolDefinition } from '@flue/runtime'
import * as v from 'valibot'
import { addDays, isoDate, laterOf } from '../shape.ts'
import { cap, clientOf, clockOf, type ToolDeps } from './kit.ts'

/** Services to walk in one sweep. A year of weekly services with room to spare. */
const MAX_SERVICES = 200
const MAX_SONGS = 60
/** Dates listed per song before it stops being useful detail. */
const MAX_DATES_PER_SONG = 12
const DEFAULT_WINDOW_DAYS = 365

interface Usage {
  songId: string
  title?: string
  artist?: string
  count: number
  lastUsed?: string
  firstUsed?: string
  dates: string[]
  keys: string[]
}

/**
 * When songs were last sung, and how often.
 *
 * A worship-planning question with no endpoint behind it: song usage lives on
 * services, not on songs, so answering it means sweeping a year of services with
 * `fields: ['songs']` and aggregating. Left to a model, that is dozens of tool
 * calls and a page of JSON per service, to produce one date per song.
 *
 * The `songs` sub-structure of a service is documentation-derived — it came back
 * empty on every service in the live sweep — so an empty result here may mean the
 * shape is wrong rather than that nothing was sung. Worth checking against one
 * known service before trusting a "we have never sung this".
 */
export function songHistory(deps: ToolDeps): ToolDefinition {
  const clock = clockOf(deps)
  const getClient = clientOf(deps)

  return defineTool({
    name: 'song_history',
    description:
      'Report when songs were last sung and how often, over a date range. ' +
      `Defaults to the last ${DEFAULT_WINDOW_DAYS} days. Pass title to filter to ` +
      'songs whose title matches. Returns one row per song with its play count, ' +
      'first and last use, the dates, and the keys it was played in — sorted by ' +
      'most recently used. Use it for "when did we last sing X" and "what have we ' +
      'overplayed" questions.',
    input: v.object({
      start: v.optional(
        v.pipe(
          v.string(),
          v.trim(),
          v.regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected a date in YYYY-MM-DD format.'),
          v.description('Range start, YYYY-MM-DD.'),
        ),
      ),
      end: v.optional(
        v.pipe(
          v.string(),
          v.trim(),
          v.regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected a date in YYYY-MM-DD format.'),
          v.description('Range end, YYYY-MM-DD. Defaults to today.'),
        ),
      ),
      title: v.optional(
        v.pipe(
          v.string(),
          v.trim(),
          v.description('Only songs whose title contains this text, case-insensitive.'),
        ),
      ),
      sort: v.optional(
        v.pipe(
          v.picklist(['recent', 'frequency']),
          v.description('Order by most recently used (default) or by play count.'),
        ),
      ),
    }),
    async run({ data, log, signal }) {
      const today = clock()
      const end = data.end ?? isoDate(today)
      const start = data.start ?? isoDate(addDays(today, -DEFAULT_WINDOW_DAYS))

      if (start > end) {
        return { output: { error: `start (${start}) is after end (${end}).` } }
      }

      const usage = new Map<string, Usage>()
      let servicesSeen = 0
      const needle = data.title?.toLowerCase()

      for await (const service of getClient().paginate(
        'services.getAll',
        { start, end, all: 'yes', fields: ['songs'] },
        { maxRecords: MAX_SERVICES, ...(signal ? { signal } : {}) },
      )) {
        servicesSeen++
        const date = service.date

        for (const song of service.songs ?? []) {
          if (needle && !song.title?.toLowerCase().includes(needle)) continue

          const existing = usage.get(song.id) ?? {
            songId: song.id,
            title: song.title,
            artist: song.artist,
            count: 0,
            dates: [],
            keys: [],
          }

          existing.count++
          if (date) {
            existing.dates.push(date)
            existing.lastUsed = laterOf(existing.lastUsed, date)
            existing.firstUsed =
              existing.firstUsed && existing.firstUsed <= date ? existing.firstUsed : date
          }

          const arrangement =
            song.arrangement && typeof song.arrangement === 'object' ? song.arrangement : undefined
          const key = arrangement?.key_name ?? arrangement?.key
          if (key && !existing.keys.includes(key)) existing.keys.push(key)

          usage.set(song.id, existing)
        }
      }

      const sorted = [...usage.values()].sort((a, b) =>
        data.sort === 'frequency'
          ? b.count - a.count
          : (b.lastUsed ?? '').localeCompare(a.lastUsed ?? ''),
      )

      const capped = cap(sorted, MAX_SONGS, 'Filter by title, or narrow the date range.')
      log.info(
        `song_history: ${capped.items.length} song(s) across ${servicesSeen} service(s)`,
      )

      return {
        output: {
          range: { start, end },
          servicesScanned: servicesSeen,
          songCount: capped.items.length,
          songs: capped.items.map((song) => ({
            ...song,
            // Newest first, and only the most recent few — the count already
            // carries the total.
            dates: song.dates.sort((a, b) => b.localeCompare(a)).slice(0, MAX_DATES_PER_SONG),
          })),
          ...(capped.truncated ? { truncated: capped.truncated } : {}),
          ...(servicesSeen >= MAX_SERVICES
            ? {
                scanLimited: {
                  advice:
                    `Stopped after ${MAX_SERVICES} services, so earlier use may be ` +
                    `missing. Narrow the range for a complete answer.`,
                },
              }
            : {}),
          ...(capped.items.length === 0
            ? {
                advice:
                  'No song usage found in that range. Either nothing was recorded, ' +
                  'or songs were not attached to these services in Elvanto.',
              }
            : {}),
        },
      }
    },
  })
}
