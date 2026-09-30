import { z } from 'zod'
import { id } from '../zod-helpers.js'

/**
 * Acknowledgements from the write endpoints.
 *
 * Elvanto answers a write with the id it touched and little else. Every field
 * past the id is optional, and the objects are loose: these shapes come from
 * documentation examples only, and a write whose acknowledgement surprises us
 * has still happened.
 */

/** `people/create`, `people/edit`, `people/remove`. */
export const personAckSchema = z.looseObject({
  id: id,
  /** A number on create and edit; absent on remove. */
  family_id: z.union([z.number(), z.string()]).optional(),
})
export type PersonAck = z.output<typeof personAckSchema>

/** `groups/create`, `groups/edit`, `groups/remove`. */
export const groupAckSchema = z.looseObject({
  id: id,
})
export type GroupAck = z.output<typeof groupAckSchema>

/** `groups/addPerson`, `groups/removePerson`. */
export const groupMemberAckSchema = z.looseObject({
  id: id,
  person_id: id,
})
export type GroupMemberAck = z.output<typeof groupMemberAckSchema>

/**
 * `peopleFlows/steps/addPerson`: the ids of the step-membership records made.
 * A plain array, like the rest of the People Flows endpoints.
 */
export const stepPersonAckSchema = z.array(id)
export type StepPersonAck = z.output<typeof stepPersonAckSchema>
