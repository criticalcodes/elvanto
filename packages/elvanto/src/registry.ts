import { z } from 'zod'
import {
  dateParam,
  fieldValuesParam,
  fieldsParam,
  idOrIds,
  optionalDateParam,
  paginationParams,
  yesNo,
  yesNoValue,
} from './zod-helpers.js'
import {
  customFieldSchema,
  peopleCategorySchema,
  personSchema,
} from './schemas/people.js'
import { groupSchema } from './schemas/groups.js'
import { serviceSchema } from './schemas/services.js'
import {
  arrangementSchema,
  songCategorySchema,
  songKeySchema,
  songSchema,
} from './schemas/songs.js'
import { calendarEventSchema, calendarSchema } from './schemas/calendar.js'
import {
  financialCategorySchema,
  transactionSchema,
} from './schemas/financial.js'
import {
  peopleFlowSchema,
  peopleFlowStepMemberSchema,
  peopleFlowStepSchema,
} from './schemas/peopleFlows.js'
import {
  groupAckSchema,
  groupMemberAckSchema,
  personAckSchema,
  stepPersonAckSchema,
} from './schemas/writes.js'

/** How to pull the payload out of a response envelope. */
export type ResultShape =
  /** A paginated collection: `{ <collectionKey>: { total, <itemKey>: [...] } }`. */
  | { readonly kind: 'page'; readonly collectionKey: string; readonly itemKey: string; readonly item: z.ZodType }
  /** A single record under `<key>`, as either a one-element array or an object. */
  | { readonly kind: 'single'; readonly key: string; readonly item: z.ZodType }
  /**
   * A write's acknowledgement under `<key>` — usually just the id it touched.
   *
   * Read leniently, because by the time it is read the write has happened: a
   * mismatch is reported but never thrown, whatever the validation mode. See
   * `ElvantoClient.extract`.
   */
  | { readonly kind: 'ack'; readonly key: string; readonly item: z.ZodType }

/**
 * What calling an endpoint does to the account.
 *
 * - `read` — nothing. Safe to repeat, safe to hand to a model.
 * - `write` — creates or changes something, and the change can be undone by
 *   another call.
 * - `destructive` — deletes something, or can drop data in a way another call
 *   cannot put back (e.g. `people.edit` with a blank `family_id` detaches a
 *   person from their family).
 */
export type EndpointEffect = 'read' | 'write' | 'destructive'

export interface EndpointDefinition {
  /** Canonical dotted id, e.g. `songs.arrangements.getAll`. Drives every name. */
  readonly id: string
  /** Elvanto's own path, e.g. `songs/arrangements/getAll`. */
  readonly path: string
  /**
   * What calling it does. Required, so adding an endpoint forces an explicit
   * answer — the surfaces decide what to expose from this, and a missing value
   * must not default to "harmless".
   */
  readonly effect: EndpointEffect
  /** One-line description, shown in CLI help and as the MCP tool description. */
  readonly summary: string
  /** Longer guidance for the MCP tool description, where a model needs the nuance. */
  readonly notes?: string
  readonly params: z.ZodObject
  readonly result: ResultShape
  /** `people/currentUser` is documented as OAuth-only; everything else takes either. */
  readonly auth?: 'oauth-only'
  /** Link to the endpoint's documentation page. */
  readonly docs: string
  /**
   * How far this endpoint's response shape has actually been confirmed.
   *
   * - `docs` — matches Elvanto's published example payload. Every endpoint here
   *   meets this bar; it is the floor, not a warning.
   * - `live` — additionally observed returning real data from a real account.
   *
   * The distinction is worth recording because Elvanto publishes no
   * machine-readable spec, and a live sweep has already contradicted the
   * documentation twice: `school_grade` is an object rather than a name, and
   * `family` is not the person collection its name implies. A `docs`-only
   * endpoint is probably right, but nothing has tested it against reality — so a
   * mismatch there is expected rather than surprising, and worth reporting.
   *
   * Required, so adding an endpoint forces an explicit answer.
   */
  readonly verified: 'docs' | 'live'
}

function defineEndpoint<const D extends EndpointDefinition>(definition: D): D {
  return definition
}

const FAMILY_RELATIONSHIPS = [
  'Primary Contact',
  'Spouse',
  'Partner',
  'Child',
  'Sibling',
  'Grandfather',
  'Grandmother',
  'Other',
] as const

/**
 * The fields `people/create` and `people/edit` share. Edit makes the names
 * optional and adds the id; everything else is the same.
 */
const personWriteParams = {
  preferred_name: z.string().optional().describe('Preferred name, e.g. a nickname.'),
  email: z.string().optional().describe('Email address.'),
  phone: z
    .string()
    .optional()
    .describe('Phone number. Non-digits are stripped and it is reformatted to the account settings.'),
  mobile: z
    .string()
    .optional()
    .describe('Mobile number. Non-digits are stripped and it is reformatted to the account settings.'),
  category_id: z.string().optional().describe('People category ID to place the person in.'),
  archived: yesNoValue('Whether the person is archived.'),
  contact: yesNoValue('Whether the person is a contact rather than a member.'),
  volunteer: yesNoValue('Whether the person is a volunteer.'),
  status: z
    .enum(['active', 'suspended'])
    .optional()
    .describe('Login status. Only meaningful when the person has a username.'),
  username: z.string().optional().describe('Login username.'),
  password: z
    .string()
    .optional()
    .describe('Login password. A random one is generated when a username is set without it.'),
  family_id: z
    .union([z.number().int().positive(), z.string().regex(/^(\d+|new)?$/)])
    .optional()
    .describe(
      'Family to put the person in: an existing family ID joins that family, ' +
        '"new" starts a new family. An empty string "" REMOVES the person from ' +
        'their current family — only send it when that is the intent.',
    ),
  family_relationship: z
    .enum(FAMILY_RELATIONSHIPS)
    .optional()
    .describe('Relationship to the family.'),
  fields: fieldValuesParam(
    'Extra and custom fields to set, as name → value, e.g. ' +
      '{"gender": "Female", "birthday": "1990-04-23", "custom_<uuid>": "value"}. ' +
      'Use people.customFields.getAll to find custom field keys. A checkbox ' +
      '(select_multi) custom field takes an ARRAY of option names, which replaces ' +
      'the whole selection — include the options to keep; clear it with "". ' +
      'Every other custom field, drop-downs included, takes a string (a drop-down ' +
      'takes the option name). Dates are YYYY-MM-DD. "" clears any field.',
  ),
}

/** The fields `groups/create` and `groups/edit` share. */
const groupWriteParams = {
  status: z.enum(['active', 'suspended']).optional().describe('Group status.'),
  meeting_address: z.string().optional().describe('Meeting street address.'),
  meeting_city: z.string().optional().describe('Meeting city.'),
  meeting_state: z.string().optional().describe('Meeting state.'),
  meeting_postcode: z.string().optional().describe('Meeting postcode or zip.'),
  meeting_country: z.string().optional().describe('Meeting country.'),
  meeting_start_date: optionalDateParam('Date the group started, YYYY-MM-DD.'),
  meeting_end_date: optionalDateParam('Date the group finishes, YYYY-MM-DD.'),
  meeting_start_time: z
    .string()
    .optional()
    .describe('Time of day the group meets, e.g. "1:00 PM" or "13:00".'),
  meeting_end_time: z
    .string()
    .optional()
    .describe('Time of day the group finishes, e.g. "2:30 PM" or "14:30".'),
  meeting_frequency: z
    .object({
      type: z.enum(['weekly', 'monthly']).describe('Weekly or monthly.'),
      count: z.number().int().positive().optional().describe('Every this many weeks or months.'),
      day: z.string().optional().describe('Day of the week, e.g. "Tuesday".'),
      occurrence: z
        .enum(['1', '2', '3', '4', '5', 'last'])
        .optional()
        .describe('Monthly only: which occurrence of the day in the month.'),
    })
    .optional()
    .describe('How often the group meets.'),
  fields: fieldValuesParam('Extra group fields to set, as name → value.'),
}

/**
 * Every endpoint, keyed by canonical id.
 *
 * Adding an entry here is all that's required to expose a new endpoint on the
 * SDK (one binding line in `client.ts`), the CLI, and the MCP server. Writes
 * reach the model-facing surfaces only when an operator opts in; see
 * {@link EndpointDefinition.effect}.
 */
export const endpoints = {
  // ── People ────────────────────────────────────────────────────────────────
  'people.getAll': defineEndpoint({
    id: 'people.getAll',
    path: 'people/getAll',
    effect: 'read',
    summary: 'List all people.',
    notes:
      'Returns the documented default fields only. Pass `fields` to include ' +
      'extras such as gender, birthday, locations, or a custom field by its ' +
      '`custom_<uuid>` key.',
    params: z.object({
      ...paginationParams,
      category_id: idOrIds('Only people in these people-category IDs.'),
      suspended: yesNo('Filter suspended people. Omit for all.'),
      contact: yesNo('Filter people marked as contacts. Omit for all.'),
      archived: yesNo('Filter archived people. Omit for all.'),
      fields: fieldsParam('Optional person fields to include.'),
    }),
    result: { kind: 'page', collectionKey: 'people', itemKey: 'person', item: personSchema },
    docs: 'https://www.elvanto.com/api/people/getAll/',
    verified: 'live',
  }),

  'people.search': defineEndpoint({
    id: 'people.search',
    path: 'people/search',
    effect: 'read',
    summary: 'Find people matching a search query.',
    notes:
      'Each key in `search` is a field name and each value is the keyword to ' +
      'match, e.g. {"lastname": "Smith", "volunteer": "yes"}. Searchable keys ' +
      'include firstname, preferred_name, lastname, email, phone, mobile, ' +
      'category_id, groups, gender, birthday, anniversary, marital_status, ' +
      'school_grade, giving_number, security_code, receipt_name, date_added, ' +
      'date_modified, last_login, archived, contact, deceased, volunteer, ' +
      'development_child, special_needs_child, and custom_<uuid> fields.',
    params: z.object({
      ...paginationParams,
      search: z
        .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
        // Elvanto answers an empty search with "250: No search parameters
        // provided"; catching it here turns a round trip into a local error.
        .refine((value) => Object.keys(value).length > 0, {
          message: 'Provide at least one search criterion.',
        })
        .describe('Field name to keyword map. At least one entry is required.'),
      fields: fieldsParam('Optional person fields to include.'),
    }),
    result: { kind: 'page', collectionKey: 'people', itemKey: 'person', item: personSchema },
    docs: 'https://www.elvanto.com/api/people/search/',
    verified: 'live',
  }),

  'people.getInfo': defineEndpoint({
    id: 'people.getInfo',
    path: 'people/getInfo',
    effect: 'read',
    summary: 'Get one person by ID.',
    params: z.object({
      id: z.string().min(1).describe('The ID of the person.'),
      fields: fieldsParam('Optional person fields to include.'),
    }),
    result: { kind: 'single', key: 'person', item: personSchema },
    docs: 'https://www.elvanto.com/api/people/getInfo/',
    verified: 'live',
  }),

  'people.currentUser': defineEndpoint({
    id: 'people.currentUser',
    path: 'people/currentUser',
    effect: 'read',
    summary: 'Get the person record of the authenticated OAuth user.',
    notes:
      'Requires OAuth. Elvanto does not support this endpoint with an API key, ' +
      'because an API key identifies an account rather than a user.',
    params: z.object({}),
    result: { kind: 'single', key: 'person', item: personSchema },
    auth: 'oauth-only',
    docs: 'https://www.elvanto.com/api/people/currentUser/',
    verified: 'docs',
  }),

  'people.categories.getAll': defineEndpoint({
    id: 'people.categories.getAll',
    path: 'people/categories/getAll',
    effect: 'read',
    summary: 'List all people categories.',
    params: z.object({}),
    result: { kind: 'page', collectionKey: 'categories', itemKey: 'category', item: peopleCategorySchema },
    docs: 'https://www.elvanto.com/api/people/categories/getAll/',
    verified: 'live',
  }),

  'people.customFields.getAll': defineEndpoint({
    id: 'people.customFields.getAll',
    path: 'people/customFields/getAll',
    effect: 'read',
    summary: 'List all custom field definitions for people.',
    notes:
      'Use this to discover the `custom_<uuid>` keys accepted by the `fields` ' +
      'and `search` parameters on the people endpoints.',
    params: z.object({}),
    result: { kind: 'page', collectionKey: 'custom_fields', itemKey: 'custom_field', item: customFieldSchema },
    docs: 'https://www.elvanto.com/api/people/customFields/getAll/',
    verified: 'live',
  }),

  'people.create': defineEndpoint({
    id: 'people.create',
    path: 'people/create',
    effect: 'write',
    summary: 'Create a person.',
    notes:
      'Returns the new person\'s id. Check with people.search first — Elvanto ' +
      'does not detect duplicates, and a second call makes a second person.',
    params: z.object({
      firstname: z.string().min(1).describe('First name.'),
      lastname: z.string().min(1).describe('Last name.'),
      ...personWriteParams,
    }),
    result: { kind: 'ack', key: 'person', item: personAckSchema },
    docs: 'https://www.elvanto.com/api/people/create/',
    verified: 'live',
  }),

  'people.edit': defineEndpoint({
    id: 'people.edit',
    path: 'people/edit',
    // Destructive rather than a plain write: a blank family_id detaches the
    // person from their family, which no later call can undo without knowing
    // the old id.
    effect: 'destructive',
    summary: 'Change a person\'s details.',
    notes:
      'Only the parameters given are changed; everything else is left as it is.',
    params: z.object({
      id: z.string().min(1).describe('The ID of the person.'),
      firstname: z.string().min(1).optional().describe('First name.'),
      lastname: z.string().min(1).optional().describe('Last name.'),
      ...personWriteParams,
    }),
    result: { kind: 'ack', key: 'person', item: personAckSchema },
    docs: 'https://www.elvanto.com/api/people/edit/',
    verified: 'live',
  }),

  'people.remove': defineEndpoint({
    id: 'people.remove',
    path: 'people/remove',
    effect: 'destructive',
    summary: 'Delete a person.',
    notes:
      'Permanent. Consider people.edit with archived "yes" instead, which keeps ' +
      'their history.',
    params: z.object({
      id: z.string().min(1).describe('The ID of the person to delete.'),
    }),
    result: { kind: 'ack', key: 'person', item: personAckSchema },
    docs: 'https://www.elvanto.com/api/people/remove/',
    verified: 'live',
  }),

  // ── People Flows ──────────────────────────────────────────────────────────
  'peopleFlows.getAll': defineEndpoint({
    id: 'peopleFlows.getAll',
    path: 'peopleFlows/getAll',
    effect: 'read',
    summary: 'List all People Flows, with a summary of their steps.',
    notes:
      'Step summaries here omit descriptions and instructions; use ' +
      'peopleFlows.steps.getAll for those.',
    params: z.object({}),
    result: { kind: 'page', collectionKey: 'people_flows', itemKey: 'people_flow', item: peopleFlowSchema },
    docs: 'https://www.elvanto.com/api/peopleFlows/getAll/',
    verified: 'live',
  }),

  'peopleFlows.steps.getAll': defineEndpoint({
    id: 'peopleFlows.steps.getAll',
    path: 'peopleFlows/steps/getAll',
    effect: 'read',
    summary: 'List the steps of one People Flow in full detail.',
    params: z.object({
      flow_id: z.string().min(1).describe('The ID of the People Flow.'),
    }),
    result: { kind: 'page', collectionKey: 'people_flow_steps', itemKey: 'people_flow_step', item: peopleFlowStepSchema },
    docs: 'https://www.elvanto.com/api/peopleFlows/steps/getAll/',
    verified: 'live',
  }),

  'peopleFlows.steps.people': defineEndpoint({
    id: 'peopleFlows.steps.people',
    path: 'peopleFlows/steps/people',
    effect: 'read',
    summary: 'List the people currently in a People Flow step.',
    notes: 'Elvanto documents this endpoint as unpaginated.',
    params: z.object({
      step_id: z.string().min(1).describe('The ID of the People Flow step.'),
      status: z
        .enum(['complete', 'notstarted', 'pending', 'inprogress'])
        .optional()
        .describe('Only members with this status.'),
      assigned: z
        .string()
        .optional()
        .describe('An admin ID, or "unassigned".'),
    }),
    result: { kind: 'page', collectionKey: 'people_flow_step_members', itemKey: 'people_flow_step_member', item: peopleFlowStepMemberSchema },
    docs: 'https://www.elvanto.com/api/peopleFlows/steps/people/',
    verified: 'docs',
  }),

  'peopleFlows.steps.addPerson': defineEndpoint({
    id: 'peopleFlows.steps.addPerson',
    path: 'peopleFlows/steps/addPerson',
    effect: 'write',
    summary: 'Add a person to a People Flow step.',
    params: z.object({
      step_id: z.string().min(1).describe('The ID of the People Flow step.'),
      person_id: z.string().min(1).describe('The ID of the person to add.'),
      assign_to: z
        .string()
        .optional()
        .describe('The ID of a step admin to assign the person to.'),
    }),
    result: { kind: 'ack', key: 'step_person', item: stepPersonAckSchema },
    docs: 'https://www.elvanto.com/api/peopleFlows/steps/addPerson/',
    verified: 'docs',
  }),

  // ── Groups ────────────────────────────────────────────────────────────────
  'groups.getAll': defineEndpoint({
    id: 'groups.getAll',
    path: 'groups/getAll',
    effect: 'read',
    summary: 'List all groups.',
    params: z.object({
      ...paginationParams,
      category_id: idOrIds('Only groups in these group-category IDs.'),
      suspended: yesNo('Filter suspended groups. Omit for all.'),
      fields: fieldsParam(
        'Optional group fields: people, categories, departments, demographics, locations.',
      ),
    }),
    result: { kind: 'page', collectionKey: 'groups', itemKey: 'group', item: groupSchema },
    docs: 'https://www.elvanto.com/api/groups/getAll/',
    verified: 'live',
  }),

  'groups.getInfo': defineEndpoint({
    id: 'groups.getInfo',
    path: 'groups/getInfo',
    effect: 'read',
    summary: 'Get one group by ID.',
    params: z.object({
      id: z.string().min(1).describe('The ID of the group.'),
      fields: fieldsParam(
        'Optional group fields: people, categories, departments, demographics, locations.',
      ),
    }),
    result: { kind: 'single', key: 'group', item: groupSchema },
    docs: 'https://www.elvanto.com/api/groups/getInfo/',
    verified: 'live',
  }),

  'groups.create': defineEndpoint({
    id: 'groups.create',
    path: 'groups/create',
    effect: 'write',
    summary: 'Create a group.',
    notes:
      'Returns the new group\'s id. Check with groups.getAll first — Elvanto ' +
      'does not detect duplicates.',
    params: z.object({
      name: z.string().min(1).describe('The name of the group.'),
      ...groupWriteParams,
    }),
    result: { kind: 'ack', key: 'group', item: groupAckSchema },
    docs: 'https://www.elvanto.com/api/groups/create/',
    verified: 'live',
  }),

  'groups.edit': defineEndpoint({
    id: 'groups.edit',
    path: 'groups/edit',
    effect: 'write',
    summary: 'Change a group\'s details.',
    notes:
      'Only the parameters given are changed; everything else is left as it is.',
    params: z.object({
      id: z.string().min(1).describe('The ID of the group.'),
      name: z.string().min(1).optional().describe('The name of the group.'),
      ...groupWriteParams,
    }),
    result: { kind: 'ack', key: 'group', item: groupAckSchema },
    docs: 'https://www.elvanto.com/api/groups/edit/',
    verified: 'live',
  }),

  'groups.remove': defineEndpoint({
    id: 'groups.remove',
    path: 'groups/remove',
    effect: 'destructive',
    summary: 'Delete a group.',
    notes:
      'Permanent. Consider groups.edit with status "suspended" instead.',
    params: z.object({
      id: z.string().min(1).describe('The ID of the group to delete.'),
    }),
    // Elvanto's example answers under "person"; a live call answers under
    // "group". The ack reader would accept either.
    result: { kind: 'ack', key: 'group', item: groupAckSchema },
    docs: 'https://www.elvanto.com/api/groups/remove/',
    verified: 'live',
  }),

  'groups.addPerson': defineEndpoint({
    id: 'groups.addPerson',
    path: 'groups/addPerson',
    effect: 'write',
    summary: 'Add a person to a group, or change their position in it.',
    notes:
      'Calling it for someone already in the group changes their position ' +
      'rather than adding them twice.',
    params: z.object({
      id: z.string().min(1).describe('The ID of the group.'),
      person_id: z.string().min(1).describe('The ID of the person.'),
      position: z
        .enum(['Leader', 'Assistant Leader'])
        .optional()
        .describe('Their position in the group. Omit for an ordinary member.'),
    }),
    result: { kind: 'ack', key: 'group', item: groupMemberAckSchema },
    docs: 'https://www.elvanto.com/api/groups/addPerson/',
    verified: 'live',
  }),

  'groups.removePerson': defineEndpoint({
    id: 'groups.removePerson',
    path: 'groups/removePerson',
    effect: 'destructive',
    summary: 'Remove a person from a group.',
    notes:
      'Their position in the group is lost; groups.addPerson puts them back as ' +
      'an ordinary member unless a position is given again.',
    params: z.object({
      id: z.string().min(1).describe('The ID of the group.'),
      person_id: z.string().min(1).describe('The ID of the person.'),
    }),
    result: { kind: 'ack', key: 'group', item: groupMemberAckSchema },
    docs: 'https://www.elvanto.com/api/groups/removePerson/',
    verified: 'live',
  }),

  // ── Services ──────────────────────────────────────────────────────────────
  'services.getAll': defineEndpoint({
    id: 'services.getAll',
    path: 'services/getAll',
    effect: 'read',
    summary: 'List services.',
    notes:
      'Defaults to upcoming services only — pass all: "yes" or a start/end ' +
      'range to reach past ones. Plans, volunteers and songs are returned only ' +
      'when requested via `fields`.',
    params: z.object({
      ...paginationParams,
      all: yesNo('Include past services. Default: no.'),
      start: dateParam('Start date, YYYY-MM-DD.').optional(),
      end: dateParam('End date, YYYY-MM-DD.').optional(),
      status: z
        .enum(['published', 'draft'])
        .optional()
        .describe('Only services with this status.'),
      service_types: idOrIds('Only services of these service type IDs.'),
      fields: fieldsParam(
        'Optional service fields: series_name, service_times, rehearsal_times, ' +
          'other_times, plans, volunteers, songs, files, notes, picture.',
      ),
    }),
    result: { kind: 'page', collectionKey: 'services', itemKey: 'service', item: serviceSchema },
    docs: 'https://www.elvanto.com/api/services/getAll/',
    verified: 'live',
  }),

  'services.getInfo': defineEndpoint({
    id: 'services.getInfo',
    path: 'services/getInfo',
    effect: 'read',
    summary: 'Get one service by ID.',
    params: z.object({
      id: z.string().min(1).describe('The ID of the service.'),
      fields: fieldsParam(
        'Optional service fields: series_name, service_times, rehearsal_times, ' +
          'other_times, plans, volunteers, songs, files, notes, picture.',
      ),
    }),
    result: { kind: 'single', key: 'service', item: serviceSchema },
    docs: 'https://www.elvanto.com/api/services/getInfo/',
    verified: 'live',
  }),

  // ── Songs ─────────────────────────────────────────────────────────────────
  'songs.getAll': defineEndpoint({
    id: 'songs.getAll',
    path: 'songs/getAll',
    effect: 'read',
    summary: 'List songs.',
    params: z.object({
      ...paginationParams,
      title: z.string().optional().describe('Filter by song title.'),
      artist: z.string().optional().describe('Filter by artist.'),
      lyrics: z.string().optional().describe('Filter by lyrics content.'),
      files: z.boolean().optional().describe('Include attached files.'),
    }),
    result: { kind: 'page', collectionKey: 'songs', itemKey: 'song', item: songSchema },
    docs: 'https://www.elvanto.com/api/songs/getAll/',
    verified: 'docs',
  }),

  'songs.getInfo': defineEndpoint({
    id: 'songs.getInfo',
    path: 'songs/getInfo',
    effect: 'read',
    summary: 'Get one song by ID.',
    params: z.object({
      id: z.string().min(1).describe('The ID of the song.'),
      files: z.boolean().optional().describe('Include attached files.'),
    }),
    result: { kind: 'single', key: 'song', item: songSchema },
    docs: 'https://www.elvanto.com/api/songs/getInfo/',
    verified: 'docs',
  }),

  'songs.categories.getAll': defineEndpoint({
    id: 'songs.categories.getAll',
    path: 'songs/categories/getAll',
    effect: 'read',
    summary: 'List all song categories.',
    params: z.object({ ...paginationParams }),
    result: { kind: 'page', collectionKey: 'categories', itemKey: 'category', item: songCategorySchema },
    // The docs page returns HTTP 500, but appends the error *after* the rendered
    // documentation, so its parameter table and example response are readable in
    // the response body.
    docs: 'https://www.elvanto.com/api/songs/categories/getAll/',
    verified: 'live',
  }),

  'songs.arrangements.getAll': defineEndpoint({
    id: 'songs.arrangements.getAll',
    path: 'songs/arrangements/getAll',
    effect: 'read',
    summary: 'List the arrangements of one song.',
    params: z.object({
      ...paginationParams,
      song_id: z.string().min(1).describe('The ID of the song.'),
      chord_chart_key: z
        .string()
        .optional()
        .describe('Transpose returned chord charts to this key, e.g. "F#".'),
      files: z.boolean().optional().describe('Include attached files.'),
    }),
    result: { kind: 'page', collectionKey: 'arrangements', itemKey: 'arrangement', item: arrangementSchema },
    docs: 'https://www.elvanto.com/api/songs/arrangements/getAll/',
    verified: 'docs',
  }),

  'songs.arrangements.getInfo': defineEndpoint({
    id: 'songs.arrangements.getInfo',
    path: 'songs/arrangements/getInfo',
    effect: 'read',
    summary: 'Get one arrangement by ID.',
    params: z.object({
      id: z.string().min(1).describe('The ID of the arrangement.'),
      chord_chart_key: z
        .string()
        .optional()
        .describe('Transpose the chord chart to this key, e.g. "F#".'),
      files: z.boolean().optional().describe('Include attached files.'),
    }),
    result: { kind: 'single', key: 'arrangement', item: arrangementSchema },
    docs: 'https://www.elvanto.com/api/songs/arrangements/getInfo/',
    verified: 'docs',
  }),

  'songs.keys.getAll': defineEndpoint({
    id: 'songs.keys.getAll',
    path: 'songs/keys/getAll',
    effect: 'read',
    summary: 'List the keys of one arrangement.',
    params: z.object({
      ...paginationParams,
      arrangement_id: z.string().min(1).describe('The ID of the arrangement.'),
      files: z.boolean().optional().describe('Include attached files.'),
    }),
    result: { kind: 'page', collectionKey: 'keys', itemKey: 'key', item: songKeySchema },
    docs: 'https://www.elvanto.com/api/songs/keys/getAll/',
    verified: 'docs',
  }),

  'songs.keys.getInfo': defineEndpoint({
    id: 'songs.keys.getInfo',
    path: 'songs/keys/getInfo',
    effect: 'read',
    summary: 'Get one arrangement key by ID.',
    params: z.object({
      id: z.string().min(1).describe('The ID of the key.'),
      files: z.boolean().optional().describe('Include attached files.'),
    }),
    result: { kind: 'single', key: 'key', item: songKeySchema },
    docs: 'https://www.elvanto.com/api/songs/keys/getInfo/',
    verified: 'docs',
  }),

  // ── Calendar ──────────────────────────────────────────────────────────────
  'calendar.getAll': defineEndpoint({
    id: 'calendar.getAll',
    path: 'calendar/getAll',
    effect: 'read',
    summary: 'List all calendars that events can be assigned to.',
    params: z.object({}),
    result: { kind: 'page', collectionKey: 'calendars', itemKey: 'calendar', item: calendarSchema },
    docs: 'https://www.elvanto.com/api/calendar/getAll/',
    verified: 'live',
  }),

  'calendar.events.getAll': defineEndpoint({
    id: 'calendar.events.getAll',
    path: 'calendar/events/getAll',
    effect: 'read',
    summary: 'List calendar events between two dates.',
    notes:
      'start and end are required. Pass calendar: "services" to include events ' +
      'generated from services. All returned dates are UTC.',
    params: z.object({
      ...paginationParams,
      start: dateParam('First date to include, YYYY-MM-DD.'),
      end: dateParam('Last date to include, YYYY-MM-DD.'),
      calendar: idOrIds('Only these calendar IDs, or "services".'),
      fields: fieldsParam(
        'Optional event fields: locations, assets, register_url.',
      ),
    }),
    result: { kind: 'page', collectionKey: 'events', itemKey: 'event', item: calendarEventSchema },
    docs: 'https://www.elvanto.com/api/calendar/events/getAll/',
    verified: 'live',
  }),

  // ── Financial ─────────────────────────────────────────────────────────────
  'financial.transactions.getAll': defineEndpoint({
    id: 'financial.transactions.getAll',
    path: 'financial/transactions/getAll',
    effect: 'read',
    summary: 'List financial transactions between two dates.',
    notes:
      'start and end are required. This is giving data — treat the response as ' +
      'confidential.',
    params: z.object({
      ...paginationParams,
      start: dateParam('First transaction date to include, YYYY-MM-DD.'),
      end: dateParam('Last transaction date to include, YYYY-MM-DD.'),
      category_id: z
        .string()
        .optional()
        .describe('Only transactions in this chart-of-accounts category.'),
    }),
    result: { kind: 'page', collectionKey: 'transactions', itemKey: 'transaction', item: transactionSchema },
    docs: 'https://www.elvanto.com/api/financial/transactions/getAll/',
    verified: 'docs',
  }),

  'financial.transactions.getInfo': defineEndpoint({
    id: 'financial.transactions.getInfo',
    path: 'financial/transactions/getInfo',
    effect: 'read',
    summary: 'Get one financial transaction by ID.',
    params: z.object({
      id: z.string().min(1).describe('The ID of the transaction.'),
    }),
    result: { kind: 'single', key: 'transaction', item: transactionSchema },
    docs: 'https://www.elvanto.com/api/financial/transactions/getInfo/',
    verified: 'docs',
  }),

  'financial.categories.getAll': defineEndpoint({
    id: 'financial.categories.getAll',
    path: 'financial/categories/getAll',
    effect: 'read',
    summary: 'List all chart-of-accounts categories.',
    params: z.object({ ...paginationParams }),
    result: { kind: 'page', collectionKey: 'categories', itemKey: 'category', item: financialCategorySchema },
    docs: 'https://www.elvanto.com/api/financial/categories/getAll/',
    verified: 'docs',
  }),
} as const satisfies Record<string, EndpointDefinition>

export type EndpointRegistry = typeof endpoints
export type EndpointId = keyof EndpointRegistry & string

/** Endpoint ids that only read. */
export type ReadEndpointId = {
  [K in EndpointId]: EndpointRegistry[K]['effect'] extends 'read' ? K : never
}[EndpointId]

/** Endpoint ids whose result is a paginated collection. */
export type PageEndpointId = {
  [K in EndpointId]: EndpointRegistry[K]['result'] extends { kind: 'page' }
    ? K
    : never
}[EndpointId]

/** The accepted parameter object for an endpoint. */
export type ParamsOf<K extends EndpointId> = z.input<EndpointRegistry[K]['params']>

/** A single record as returned by an endpoint. */
export type RecordOf<K extends EndpointId> =
  EndpointRegistry[K]['result'] extends { item: infer I }
    ? I extends z.ZodType
      ? z.output<I>
      : never
    : never

export const endpointIds = Object.keys(endpoints) as EndpointId[]

/** The endpoints that only read — what a surface exposes when writes are off. */
export const readEndpointIds = endpointIds.filter(
  (id) => endpoints[id].effect === 'read',
) as ReadEndpointId[]

/** True when calling the endpoint changes the account. */
export function isWriteEndpoint(endpoint: EndpointDefinition): boolean {
  return endpoint.effect !== 'read'
}

// The intersection matters: the literal type carries the precise parameter
// schema, while EndpointDefinition guarantees the optional fields (`notes`,
// `auth`, `verified`) exist to be read on every endpoint.
export function getEndpoint<K extends EndpointId>(
  id: K,
): EndpointRegistry[K] & EndpointDefinition
export function getEndpoint(id: string): EndpointDefinition
export function getEndpoint(id: string): EndpointDefinition {
  const endpoint = (endpoints as Record<string, EndpointDefinition | undefined>)[id]
  if (!endpoint) {
    throw new Error(
      `Unknown Elvanto endpoint "${id}". Known ids: ${endpointIds.join(', ')}`,
    )
  }
  return endpoint
}

export function isPageEndpoint(
  endpoint: EndpointDefinition,
): endpoint is EndpointDefinition & { result: Extract<ResultShape, { kind: 'page' }> } {
  return endpoint.result.kind === 'page'
}
