import { z } from 'zod'
import { dateString, id, reference, wrapped } from '../zod-helpers.js'
import { demographicSchema, departmentSchema } from './common.js'
import { personReferenceSchema } from './people.js'

/** A group member: a person reference plus their role in the group. */
export const groupMemberSchema = personReferenceSchema.extend({
  position: z.string().optional(),
})

export type GroupMember = z.output<typeof groupMemberSchema>

/**
 * A group.
 *
 * `people` is only populated when `"people"` is passed in `fields`. Note the
 * group image is called `logo` by `groups/getAll` and `picture` by
 * `groups/getInfo`, so both are modelled.
 */
export const groupSchema = z.looseObject({
  id: id,
  date_added: dateString.optional(),
  date_modified: dateString.optional(),
  name: z.string().optional(),
  status: z.string().optional(),
  description: z.string().optional(),
  logo: z.string().optional(),
  picture: z.string().optional(),
  meeting_address: z.string().optional(),
  meeting_address2: z.string().optional(),
  meeting_city: z.string().optional(),
  meeting_state: z.string().optional(),
  meeting_postcode: z.string().optional(),
  meeting_country: z.string().optional(),
  meeting_day: z.string().optional(),
  meeting_time: z.string().optional(),
  meeting_frequency: z.string().optional(),

  // The five documented optional fields, returned only when named in `fields`.
  // All confirmed against a live account, including the sub-collections nested
  // inside departments and demographics.
  people: wrapped('person', groupMemberSchema).optional(),
  categories: wrapped('category', reference).optional(),
  departments: wrapped('department', departmentSchema).optional(),
  demographics: wrapped('demographic', demographicSchema).optional(),
  locations: wrapped('location', reference).optional(),
})

export type Group = z.output<typeof groupSchema>
