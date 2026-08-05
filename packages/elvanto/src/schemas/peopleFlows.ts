import { z } from 'zod'
import {
  dateString,
  flag,
  id,
  numericOptional,
  optionalReference,
} from '../zod-helpers.js'

/**
 * People Flows are a newer part of the API and return idiomatic JSON arrays
 * rather than the singular-key wrappers used elsewhere. `status`, `access` and
 * `entry_point` come back as empty strings in the documented examples, so their
 * populated form is unknown and they are typed loosely.
 */

/**
 * The non-recursive half of a step summary.
 *
 * Split out so the exported type can be *inferred* from it rather than written by
 * hand. A recursive schema has to be annotated with its own output type, and that
 * annotation only checks the schema is assignable to the type — a hand-written
 * type that is wider than the schema passes silently. That bit once already:
 * `notifications` became a boolean in the schema while the type still said
 * `unknown`, and nothing caught it. Only the self-referential field is manual now.
 */
const peopleFlowStepSummaryBase = z.looseObject({
  id: id,
  name: z.string().optional(),
  /** Only ever observed as `""`, so the populated form is unknown. */
  status: z.string().optional(),
  entry_point: z.string().optional(),
  /** Bare person IDs here, unlike the objects on the detailed step schema. */
  admins: z.array(id).optional(),
})

export type PeopleFlowStepSummary = z.output<typeof peopleFlowStepSummaryBase> & {
  steps?: PeopleFlowStepSummary[] | undefined
}

/** A step as summarised inside `peopleFlows/getAll`, where admins are bare IDs. */
export const peopleFlowStepSummarySchema: z.ZodType<PeopleFlowStepSummary> =
  peopleFlowStepSummaryBase.extend({
    steps: z.lazy(() => z.array(peopleFlowStepSummarySchema)).optional(),
  })

/** A People Flow: an ordered set of steps people are moved through. */
export const peopleFlowSchema = z.looseObject({
  id: id,
  name: z.string().optional(),
  /** Only ever observed as `""`, so the populated form is unknown. */
  status: z.string().optional(),
  access: z.string().optional(),
  steps: z.array(peopleFlowStepSummarySchema).optional(),
  /** Bare person IDs. */
  admins: z.array(id).optional(),
  // Observed empty, so the member type is still unknown — unlike the person and
  // group equivalents, which a live sweep confirmed as {id, name}.
  locations: z.array(z.unknown()).optional(),
  demographics: z.array(z.unknown()).optional(),
})

export type PeopleFlow = z.output<typeof peopleFlowSchema>

/** An admin responsible for a step, as returned by `peopleFlows/steps/getAll`. */
export const peopleFlowStepAdminSchema = z.looseObject({
  id: id,
  role: z.string().optional(),
})

export type PeopleFlowStepAdmin = z.output<typeof peopleFlowStepAdminSchema>

/**
 * A step's due rule. Elvanto sends `""` when the step has no due date, so this
 * must tolerate an empty string rather than expecting an object.
 */
export const stepDueSchema = z.looseObject({
  /** e.g. `"days"`. `""` when the step has no due rule. */
  type: z.string().optional(),
  days: numericOptional,
  dayweek: z.unknown().optional(),
  daycount: numericOptional,
  date: dateString.optional(),
})

export type StepDue = z.output<typeof stepDueSchema>

/**
 * The non-recursive half of a step. See `peopleFlowStepSummaryBase` for why the
 * type is inferred from this rather than written by hand.
 */
const peopleFlowStepBase = z.looseObject({
  id: id,
  name: z.string().optional(),
  priority: numericOptional,
  /** Only ever observed as `""`, so the populated form is unknown. */
  status: z.string().optional(),
  description: z.string().optional(),
  instructions: z.string().optional(),
  /**
   * Documented as `"y"`, and a live account returns a single character, so it is
   * treated as a flag. This is the one boolean extrapolated from a single observed
   * value: an unrecognised third state fails loudly rather than being guessed at.
   */
  notifications: flag.optional(),
  entry_point: z.string().optional(),
  /** Only returned by `peopleFlows/steps/getAll`. */
  hide_pending: numericOptional,
  step_due: optionalReference(stepDueSchema),
  /** Objects here, unlike the bare ID strings on the summary schema. */
  admins: z.array(peopleFlowStepAdminSchema).optional(),
})

export type PeopleFlowStep = z.output<typeof peopleFlowStepBase> & {
  steps?: PeopleFlowStep[] | undefined
}

/**
 * A step in full detail, including the instructions and description that
 * `peopleFlows/getAll` omits.
 */
export const peopleFlowStepSchema: z.ZodType<PeopleFlowStep> =
  peopleFlowStepBase.extend({
    steps: z.lazy(() => z.array(peopleFlowStepSchema)).optional(),
  })

/**
 * A person sitting in a People Flow step.
 *
 * `id` is the person's ID; `flow_step_member_id` identifies their membership of
 * this step.
 *
 * Not yet confirmed against a live account: the endpoint answered, but no step
 * had members to shape-check. The nullable fields here come from the documented
 * example alone.
 */
export const peopleFlowStepMemberSchema = z.looseObject({
  id: id,
  flow_step_member_id: id.optional(),
  member_firstname: z.string().optional(),
  member_preferred_name: z.string().nullish(),
  // Returned as an explicit JSON null when unset, so nullish rather than optional.
  member_middle_name: z.string().nullish(),
  member_lastname: z.string().optional(),
  date_added: dateString.optional(),
  status: z.string().optional(),
  due_date: dateString.nullish(),
  assigned_admin_id: z.string().nullish(),
  completed_date: dateString.nullish(),
  completed_member: z.unknown().optional(),
})

export type PeopleFlowStepMember = z.output<typeof peopleFlowStepMemberSchema>
