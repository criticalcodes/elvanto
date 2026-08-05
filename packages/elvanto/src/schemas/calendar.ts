import { z } from 'zod'
import { dateString, flag, id, reference, wrapped } from '../zod-helpers.js'

/** A calendar that events can be assigned to. */
export const calendarSchema = z.looseObject({
  id: id,
  name: z.string().optional(),
  color: z.string().optional(),
  /** Whether the calendar is visible in the member area. */
  members: flag.optional(),
  published: flag.optional(),
})

export type Calendar = z.output<typeof calendarSchema>

/**
 * A calendar event.
 *
 * All dates are returned in UTC. `locations`, `assets` and `register_url` are the
 * only documented optional fields, returned when named in `fields`.
 */
export const calendarEventSchema = z.looseObject({
  id: id,
  name: z.string().optional(),
  description: z.string().optional(),
  admin_notes: z.string().optional(),
  where: z.string().optional(),
  start_date: dateString.optional(),
  end_date: dateString.optional(),
  all_day: flag.optional(),
  color: z.string().optional(),
  picture: z.string().optional(),
  /** The calendar this event belongs to. */
  calendar_id: id.optional(),
  /** Elvanto's repeat interval for a recurring event. */
  interval: z.unknown().optional(),
  url: z.string().optional(),

  // Returned only when named in `fields`.
  locations: wrapped('location', reference).optional(),
  assets: z.unknown().optional(),
  register_url: z.string().optional(),
})

export type CalendarEvent = z.output<typeof calendarEventSchema>
