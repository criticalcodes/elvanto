import { z } from 'zod'
import {
  dateString,
  flag,
  id,
  numericOptional,
  optionalReference,
  reference,
  wrapped,
} from '../zod-helpers.js'
import { personReferenceSchema } from './people.js'

/** The arrangement summary embedded in a service's song list or plan item. */
const embeddedArrangementSchema = z.looseObject({
  id: id.optional(),
  title: z.string().optional(),
  bpm: z.string().optional(),
  duration: z.string().optional(),
  sequence: z.union([z.string(), z.array(z.string())]).optional(),
  key_id: z.string().optional(),
  key_name: z.string().optional(),
  key: z.string().optional(),
})

/** A song as attached to a service, with the chosen arrangement. */
export const serviceSongSchema = z.looseObject({
  id: id,
  ccli_number: z.string().optional(),
  title: z.string().optional(),
  artist: z.string().optional(),
  album: z.string().optional(),
  arrangement: optionalReference(embeddedArrangementSchema),
})

export type ServiceSong = z.output<typeof serviceSongSchema>

/**
 * One row of a service plan (running sheet).
 *
 * `heading` is a 1/0 flag marking the row as a section header rather than an
 * item. `song` is `""` when the row isn't a song.
 */
export const planItemSchema = z.looseObject({
  id: id.optional(),
  heading: flag.optional(),
  duration: z.string().optional(),
  title: z.string().optional(),
  song: optionalReference(serviceSongSchema),
  description: z.string().optional(),
  /** Where the item sits relative to the service, e.g. `"during"`. */
  when: z.string().optional(),
})

export type PlanItem = z.output<typeof planItemSchema>

/** A service plan, one per service time. */
export const planSchema = z.looseObject({
  time_id: id.optional(),
  service_length: numericOptional,
  service_length_formatted: z.string().optional(),
  total_length: numericOptional,
  total_length_formatted: z.string().optional(),
  items: wrapped('item', planItemSchema).optional(),
})

export type Plan = z.output<typeof planSchema>

/** A person scheduled onto a position, with their confirmation status. */
export const scheduledVolunteerSchema = z.looseObject({
  person: optionalReference(personReferenceSchema),
  status: z.string().optional(),
})

export type ScheduledVolunteer = z.output<typeof scheduledVolunteerSchema>

/** A volunteer position within a department, and who is filling it. */
export const volunteerPositionSchema = z.looseObject({
  department_id: id.optional(),
  department_name: z.string().optional(),
  sub_department_id: id.optional(),
  sub_department_name: z.string().optional(),
  position_id: id.optional(),
  position_name: z.string().optional(),
  volunteers: wrapped('volunteer', scheduledVolunteerSchema).optional(),
})

export type VolunteerPosition = z.output<typeof volunteerPositionSchema>

/**
 * The volunteer roster for one service time.
 *
 * Elvanto keys these by `plan`, the same word it uses for running sheets, even
 * though the contents are unrelated.
 */
export const volunteerPlanSchema = z.looseObject({
  time_id: id.optional(),
  positions: wrapped('position', volunteerPositionSchema).optional(),
})

export type VolunteerPlan = z.output<typeof volunteerPlanSchema>

/** A named time block attached to a service. */
export const serviceTimeSchema = z.looseObject({
  id: id.optional(),
  date_added: dateString.optional(),
  date_modified: dateString.optional(),
  name: z.string().optional(),
  starts: dateString.optional(),
  ends: dateString.optional(),
})

export type ServiceTime = z.output<typeof serviceTimeSchema>

/** A file attached to a service. */
export const serviceFileSchema = z.looseObject({
  id: id.optional(),
  title: z.string().optional(),
  type: z.string().optional(),
  html: flag.optional(),
  content: z.string().optional(),
})

export type ServiceFile = z.output<typeof serviceFileSchema>

/** A note attached to a service. */
export const serviceNoteSchema = z.looseObject({
  id: id.optional(),
  date_added: dateString.optional(),
  date_modified: dateString.optional(),
  note: z.string().optional(),
})

export type ServiceNote = z.output<typeof serviceNoteSchema>

/**
 * A service.
 *
 * `status` is Elvanto's numeric published/draft state and is left as-is.
 * Everything from `series_name` down appears only when requested via `fields`.
 *
 * Partially confirmed against a live account: the envelope, `service_times` and
 * the full `volunteers` tree (plan → position → volunteer → person) were
 * exercised for real. `plans`, `songs`, `files` and `notes` came back empty on
 * every service swept, so those four sub-structures still follow the
 * documentation alone.
 */
export const serviceSchema = z.looseObject({
  id: id,
  /** Elvanto's own state, not a boolean: 1 published, 0 draft. */
  status: numericOptional,
  date_added: dateString.optional(),
  date_modified: dateString.optional(),
  name: z.string().optional(),
  date: dateString.optional(),
  description: z.string().optional(),
  service_type: optionalReference(reference),
  location: optionalReference(reference),

  series_name: z.string().optional(),
  picture: z.string().optional(),
  service_times: wrapped('service_time', serviceTimeSchema).optional(),
  rehearsal_times: wrapped('rehearsal_time', serviceTimeSchema).optional(),
  other_times: wrapped('other_time', serviceTimeSchema).optional(),
  plans: wrapped('plan', planSchema).optional(),
  volunteers: wrapped('plan', volunteerPlanSchema).optional(),
  songs: wrapped('song', serviceSongSchema).optional(),
  files: wrapped('file', serviceFileSchema).optional(),
  notes: wrapped('note', serviceNoteSchema).optional(),
})

export type Service = z.output<typeof serviceSchema>
