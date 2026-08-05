import { z } from 'zod'
import {
  dateParam,
  fieldsParam,
  idOrIds,
  paginationParams,
  yesNo,
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

/** How to pull the payload out of a response envelope. */
export type ResultShape =
  /** A paginated collection: `{ <collectionKey>: { total, <itemKey>: [...] } }`. */
  | { readonly kind: 'page'; readonly collectionKey: string; readonly itemKey: string; readonly item: z.ZodType }
  /** A single record under `<key>`, as either a one-element array or an object. */
  | { readonly kind: 'single'; readonly key: string; readonly item: z.ZodType }

export interface EndpointDefinition {
  /** Canonical dotted id, e.g. `songs.arrangements.getAll`. Drives every name. */
  readonly id: string
  /** Elvanto's own path, e.g. `songs/arrangements/getAll`. */
  readonly path: string
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
   * Set when the documentation page could not be read and the shape below is
   * inferred from sibling endpoints. Verify against a live account.
   */
  readonly unverified?: true
}

function defineEndpoint<const D extends EndpointDefinition>(definition: D): D {
  return definition
}

/**
 * Every read-only endpoint, keyed by canonical id.
 *
 * Adding an entry here is all that's required to expose a new endpoint on the
 * SDK (one binding line in `client.ts`), the CLI, and the MCP server.
 *
 * Mutating endpoints (`create`, `edit`, `remove`, `addPerson`, …) are
 * deliberately absent in this version.
 */
export const endpoints = {
  // ── People ────────────────────────────────────────────────────────────────
  'people.getAll': defineEndpoint({
    id: 'people.getAll',
    path: 'people/getAll',
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
  }),

  'people.search': defineEndpoint({
    id: 'people.search',
    path: 'people/search',
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
  }),

  'people.getInfo': defineEndpoint({
    id: 'people.getInfo',
    path: 'people/getInfo',
    summary: 'Get one person by ID.',
    params: z.object({
      id: z.string().min(1).describe('The ID of the person.'),
      fields: fieldsParam('Optional person fields to include.'),
    }),
    result: { kind: 'single', key: 'person', item: personSchema },
    docs: 'https://www.elvanto.com/api/people/getInfo/',
  }),

  'people.currentUser': defineEndpoint({
    id: 'people.currentUser',
    path: 'people/currentUser',
    summary: 'Get the person record of the authenticated OAuth user.',
    notes:
      'Requires OAuth. Elvanto does not support this endpoint with an API key, ' +
      'because an API key identifies an account rather than a user.',
    params: z.object({}),
    result: { kind: 'single', key: 'person', item: personSchema },
    auth: 'oauth-only',
    docs: 'https://www.elvanto.com/api/people/currentUser/',
  }),

  'people.categories.getAll': defineEndpoint({
    id: 'people.categories.getAll',
    path: 'people/categories/getAll',
    summary: 'List all people categories.',
    params: z.object({}),
    result: { kind: 'page', collectionKey: 'categories', itemKey: 'category', item: peopleCategorySchema },
    docs: 'https://www.elvanto.com/api/people/categories/getAll/',
  }),

  'people.customFields.getAll': defineEndpoint({
    id: 'people.customFields.getAll',
    path: 'people/customFields/getAll',
    summary: 'List all custom field definitions for people.',
    notes:
      'Use this to discover the `custom_<uuid>` keys accepted by the `fields` ' +
      'and `search` parameters on the people endpoints.',
    params: z.object({}),
    result: { kind: 'page', collectionKey: 'custom_fields', itemKey: 'custom_field', item: customFieldSchema },
    docs: 'https://www.elvanto.com/api/people/customFields/getAll/',
  }),

  // ── People Flows ──────────────────────────────────────────────────────────
  'peopleFlows.getAll': defineEndpoint({
    id: 'peopleFlows.getAll',
    path: 'peopleFlows/getAll',
    summary: 'List all People Flows, with a summary of their steps.',
    notes:
      'Step summaries here omit descriptions and instructions; use ' +
      'peopleFlows.steps.getAll for those.',
    params: z.object({}),
    result: { kind: 'page', collectionKey: 'people_flows', itemKey: 'people_flow', item: peopleFlowSchema },
    docs: 'https://www.elvanto.com/api/peopleFlows/getAll/',
  }),

  'peopleFlows.steps.getAll': defineEndpoint({
    id: 'peopleFlows.steps.getAll',
    path: 'peopleFlows/steps/getAll',
    summary: 'List the steps of one People Flow in full detail.',
    params: z.object({
      flow_id: z.string().min(1).describe('The ID of the People Flow.'),
    }),
    result: { kind: 'page', collectionKey: 'people_flow_steps', itemKey: 'people_flow_step', item: peopleFlowStepSchema },
    docs: 'https://www.elvanto.com/api/peopleFlows/steps/getAll/',
  }),

  'peopleFlows.steps.people': defineEndpoint({
    id: 'peopleFlows.steps.people',
    path: 'peopleFlows/steps/people',
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
  }),

  // ── Groups ────────────────────────────────────────────────────────────────
  'groups.getAll': defineEndpoint({
    id: 'groups.getAll',
    path: 'groups/getAll',
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
  }),

  'groups.getInfo': defineEndpoint({
    id: 'groups.getInfo',
    path: 'groups/getInfo',
    summary: 'Get one group by ID.',
    params: z.object({
      id: z.string().min(1).describe('The ID of the group.'),
      fields: fieldsParam(
        'Optional group fields: people, categories, departments, demographics, locations.',
      ),
    }),
    result: { kind: 'single', key: 'group', item: groupSchema },
    docs: 'https://www.elvanto.com/api/groups/getInfo/',
  }),

  // ── Services ──────────────────────────────────────────────────────────────
  'services.getAll': defineEndpoint({
    id: 'services.getAll',
    path: 'services/getAll',
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
  }),

  'services.getInfo': defineEndpoint({
    id: 'services.getInfo',
    path: 'services/getInfo',
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
  }),

  // ── Songs ─────────────────────────────────────────────────────────────────
  'songs.getAll': defineEndpoint({
    id: 'songs.getAll',
    path: 'songs/getAll',
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
  }),

  'songs.getInfo': defineEndpoint({
    id: 'songs.getInfo',
    path: 'songs/getInfo',
    summary: 'Get one song by ID.',
    params: z.object({
      id: z.string().min(1).describe('The ID of the song.'),
      files: z.boolean().optional().describe('Include attached files.'),
    }),
    result: { kind: 'single', key: 'song', item: songSchema },
    docs: 'https://www.elvanto.com/api/songs/getInfo/',
  }),

  'songs.categories.getAll': defineEndpoint({
    id: 'songs.categories.getAll',
    path: 'songs/categories/getAll',
    summary: 'List all song categories.',
    params: z.object({ ...paginationParams }),
    result: { kind: 'page', collectionKey: 'categories', itemKey: 'category', item: songCategorySchema },
    // The docs page returns HTTP 500, but appends the error *after* the rendered
    // documentation, so the parameter table and example response are readable in
    // the response body and confirm this shape.
    docs: 'https://www.elvanto.com/api/songs/categories/getAll/',
  }),

  'songs.arrangements.getAll': defineEndpoint({
    id: 'songs.arrangements.getAll',
    path: 'songs/arrangements/getAll',
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
  }),

  'songs.arrangements.getInfo': defineEndpoint({
    id: 'songs.arrangements.getInfo',
    path: 'songs/arrangements/getInfo',
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
  }),

  'songs.keys.getAll': defineEndpoint({
    id: 'songs.keys.getAll',
    path: 'songs/keys/getAll',
    summary: 'List the keys of one arrangement.',
    params: z.object({
      ...paginationParams,
      arrangement_id: z.string().min(1).describe('The ID of the arrangement.'),
      files: z.boolean().optional().describe('Include attached files.'),
    }),
    result: { kind: 'page', collectionKey: 'keys', itemKey: 'key', item: songKeySchema },
    docs: 'https://www.elvanto.com/api/songs/keys/getAll/',
  }),

  'songs.keys.getInfo': defineEndpoint({
    id: 'songs.keys.getInfo',
    path: 'songs/keys/getInfo',
    summary: 'Get one arrangement key by ID.',
    params: z.object({
      id: z.string().min(1).describe('The ID of the key.'),
      files: z.boolean().optional().describe('Include attached files.'),
    }),
    result: { kind: 'single', key: 'key', item: songKeySchema },
    docs: 'https://www.elvanto.com/api/songs/keys/getInfo/',
  }),

  // ── Calendar ──────────────────────────────────────────────────────────────
  'calendar.getAll': defineEndpoint({
    id: 'calendar.getAll',
    path: 'calendar/getAll',
    summary: 'List all calendars that events can be assigned to.',
    params: z.object({}),
    result: { kind: 'page', collectionKey: 'calendars', itemKey: 'calendar', item: calendarSchema },
    docs: 'https://www.elvanto.com/api/calendar/getAll/',
  }),

  'calendar.events.getAll': defineEndpoint({
    id: 'calendar.events.getAll',
    path: 'calendar/events/getAll',
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
  }),

  // ── Financial ─────────────────────────────────────────────────────────────
  'financial.transactions.getAll': defineEndpoint({
    id: 'financial.transactions.getAll',
    path: 'financial/transactions/getAll',
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
  }),

  'financial.transactions.getInfo': defineEndpoint({
    id: 'financial.transactions.getInfo',
    path: 'financial/transactions/getInfo',
    summary: 'Get one financial transaction by ID.',
    params: z.object({
      id: z.string().min(1).describe('The ID of the transaction.'),
    }),
    result: { kind: 'single', key: 'transaction', item: transactionSchema },
    docs: 'https://www.elvanto.com/api/financial/transactions/getInfo/',
  }),

  'financial.categories.getAll': defineEndpoint({
    id: 'financial.categories.getAll',
    path: 'financial/categories/getAll',
    summary: 'List all chart-of-accounts categories.',
    params: z.object({ ...paginationParams }),
    result: { kind: 'page', collectionKey: 'categories', itemKey: 'category', item: financialCategorySchema },
    docs: 'https://www.elvanto.com/api/financial/categories/getAll/',
  }),
} as const satisfies Record<string, EndpointDefinition>

export type EndpointRegistry = typeof endpoints
export type EndpointId = keyof EndpointRegistry & string

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

// The intersection matters: the literal type carries the precise parameter
// schema, while EndpointDefinition guarantees the optional fields (`notes`,
// `auth`, `unverified`) exist to be read on every endpoint.
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
