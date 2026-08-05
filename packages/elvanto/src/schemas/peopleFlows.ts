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

/** A step as summarised inside `peopleFlows/getAll`, where admins are bare IDs. */
export const peopleFlowStepSummarySchema: z.ZodType<PeopleFlowStepSummary> = z.lazy(() =>
  z.looseObject({
    id: id,
    name: z.string().optional(),
    status: z.unknown().optional(),
    entry_point: z.unknown().optional(),
    admins: z.array(z.unknown()).optional(),
    steps: z.array(peopleFlowStepSummarySchema).optional(),
  }),
)

export interface PeopleFlowStepSummary {
  id: string
  name?: string | undefined
  status?: unknown
  entry_point?: unknown
  admins?: unknown[] | undefined
  steps?: PeopleFlowStepSummary[] | undefined
  [key: string]: unknown
}

/** A People Flow: an ordered set of steps people are moved through. */
export const peopleFlowSchema = z.looseObject({
  id: id,
  name: z.string().optional(),
  status: z.unknown().optional(),
  access: z.unknown().optional(),
  steps: z.array(peopleFlowStepSummarySchema).optional(),
  admins: z.array(z.unknown()).optional(),
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
 * A step in full detail, including the instructions and description that
 * `peopleFlows/getAll` omits.
 *
 * Note `admins` here is a list of objects, whereas the same key on the flow
 * summary is a list of ID strings.
 */
/**
 * A step's due rule. Elvanto sends `""` when the step has no due date, so this
 * must tolerate an empty string rather than expecting an object.
 */
export const stepDueSchema = z.looseObject({
  type: z.unknown().optional(),
  days: numericOptional,
  dayweek: z.unknown().optional(),
  daycount: numericOptional,
  date: dateString.optional(),
})

export const peopleFlowStepSchema: z.ZodType<PeopleFlowStep> = z.lazy(() =>
  z.looseObject({
    id: id,
    name: z.string().optional(),
    priority: numericOptional,
    status: z.unknown().optional(),
    description: z.string().optional(),
    instructions: z.string().optional(),
    /**
     * Documented as `"y"`, and a live account returns a single character, so it
     * is treated as a flag. This is the one boolean extrapolated from a single
     * observed value: an unrecognised third state would fail loudly rather than
     * being guessed at.
     */
    notifications: flag.optional(),
    entry_point: z.unknown().optional(),
    /** Only returned by `peopleFlows/steps/getAll`. */
    hide_pending: numericOptional,
    step_due: optionalReference(stepDueSchema),
    admins: z.array(peopleFlowStepAdminSchema).optional(),
    steps: z.array(peopleFlowStepSchema).optional(),
  }),
)

export type StepDue = z.output<typeof stepDueSchema>

export interface PeopleFlowStep {
  id: string
  name?: string | undefined
  priority?: number | undefined
  status?: unknown
  description?: string | undefined
  instructions?: string | undefined
  notifications?: unknown
  entry_point?: unknown
  hide_pending?: number | undefined
  step_due?: StepDue | undefined
  admins?: PeopleFlowStepAdmin[] | undefined
  steps?: PeopleFlowStep[] | undefined
  [key: string]: unknown
}

/**
 * A person sitting in a People Flow step.
 *
 * `id` is the person's ID; `flow_step_member_id` identifies their membership of
 * this step.
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
