import { z } from 'zod'
import {
  dateString,
  flag,
  id,
  reference,
  wrapped,
} from '../zod-helpers.js'

/**
 * A song's arrangement sequence.
 *
 * `songs/arrangements/*` returns an array of section names, but the arrangement
 * summary nested inside a service returns `""`. Both are accepted.
 */
const sequence = z.union([z.string(), z.array(z.string())]).optional()

/** A file attached to a song, arrangement or key. */
export const songFileSchema = z.looseObject({
  id: id.optional(),
  title: z.string().optional(),
  type: z.string().optional(),
  filename: z.string().optional(),
  url: z.string().optional(),
})

export type SongFile = z.output<typeof songFileSchema>

/**
 * A song.
 *
 * Not yet confirmed against a live account — the account swept had no songs — so
 * everything here follows Elvanto's documented example only. `sequence` in
 * particular is an array on these endpoints but `""` on the copy embedded in a
 * service, which is the kind of inconsistency real data tends to reveal.
 *
 * `status` is Elvanto's own numeric state, not a boolean, so it is left
 * untouched. `item`, `learn` and `allow_downloads` are documented 1/0 flags and
 * are normalized to booleans.
 */
export const songSchema = z.looseObject({
  id: id,
  status: z.unknown().optional(),
  date_added: dateString.optional(),
  date_modified: dateString.optional(),
  title: z.string().optional(),
  permalink: z.string().optional(),
  number: z.string().optional(),
  item: flag.optional(),
  learn: flag.optional(),
  allow_downloads: flag.optional(),
  artist: z.string().optional(),
  album: z.string().optional(),
  ccli_number: z.string().optional(),
  notes: z.string().optional(),
  categories: wrapped('category', reference).optional(),
  locations: wrapped('location', reference).optional(),
  files: wrapped('file', songFileSchema).optional(),
})

export type Song = z.output<typeof songSchema>

/** An arrangement of a song: its lyrics, chord chart and timing. */
export const arrangementSchema = z.looseObject({
  id: id,
  date_added: dateString.optional(),
  date_modified: dateString.optional(),
  name: z.string().optional(),
  title: z.string().optional(),
  copyright: z.string().optional(),
  sequence: sequence,
  minutes: z.string().optional(),
  seconds: z.string().optional(),
  bpm: z.string().optional(),
  duration: z.string().optional(),
  key_male: z.string().optional(),
  key_female: z.string().optional(),
  key_name: z.string().optional(),
  key_id: z.string().optional(),
  key: z.string().optional(),
  chord_chart_key: z.string().optional(),
  lyrics: z.string().optional(),
  chord_chart: z.string().optional(),
  files: wrapped('file', songFileSchema).optional(),
})

export type Arrangement = z.output<typeof arrangementSchema>

/** A key an arrangement can be played in. */
export const songKeySchema = z.looseObject({
  id: id,
  date_added: dateString.optional(),
  date_modified: dateString.optional(),
  name: z.string().optional(),
  key_starting: z.string().optional(),
  key_ending: z.string().optional(),
  arrangement_id: id.optional(),
  files: wrapped('file', songFileSchema).optional(),
})

export type SongKey = z.output<typeof songKeySchema>

/** A song category, e.g. Praise or Worship. */
export const songCategorySchema = z.looseObject({
  id: id,
  name: z.string().optional(),
})

export type SongCategory = z.output<typeof songCategorySchema>
