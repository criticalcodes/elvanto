/**
 * Typed, read-only TypeScript client for the Elvanto church management API.
 *
 * ```ts
 * import { createClient } from '@criticalcodes/elvanto'
 *
 * const elvanto = createClient({ auth: { apiKey: process.env.ELVANTO_API_KEY! } })
 * const services = await elvanto.services.getAll({ fields: ['songs'] })
 * ```
 *
 * ## Response normalization
 *
 * Elvanto's JSON is a mechanical translation of XML, so this library reshapes it
 * on the way out. The rules, applied consistently everywhere:
 *
 * 1. Singular-key collection wrappers are flattened:
 *    `{ locations: { location: [...] } }` becomes `{ locations: [...] }`.
 *    An empty collection (`""`) becomes `[]`; an absent one stays `undefined`,
 *    which distinguishes "none" from "not requested".
 * 2. Single-record responses are unwrapped, whether Elvanto sent a one-element
 *    array (`person: [{...}]`) or a bare object (`transaction: {...}`).
 * 3. Pagination counters are lifted into a {@link Page} with `items`, `total`
 *    and `hasMore`.
 * 4. Documented 1/0 and "Yes"/"No" booleans become real booleans.
 * 5. Numbers Elvanto quotes inconsistently (`125` vs `"360.00"`) become numbers.
 * 6. Everything else is verbatim, and unknown fields are always preserved.
 *
 * Dates are left as Elvanto's strings — see {@link parseElvantoDate}.
 */

export { ElvantoClient, createClient, type PaginateOptions, type ResultOf } from './client.js'

export {
  Transport,
  parseValidationMode,
  resolveAuth,
  DEFAULT_BASE_URL,
  DEFAULT_MAX_RETRIES,
  DEFAULT_TIMEOUT_MS,
  type AccessTokenAuth,
  type ApiKeyAuth,
  type ElvantoAuth,
  type ElvantoClientOptions,
  type ElvantoValidationWarning,
  type RequestOptions,
  type TokenProviderAuth,
  type ValidationMode,
} from './http.js'

export {
  createStderrLogger,
  parseDebugMode,
  resolveLogging,
  type DebugMode,
  type ElvantoLogEvent,
  type ElvantoLogger,
  type ResolvedLogging,
} from './logging.js'

export {
  ElvantoApiError,
  ElvantoError,
  ElvantoRequestValidationError,
  ElvantoResponseValidationError,
  ElvantoTransportError,
  type ValidationIssue,
} from './errors.js'

export {
  endpointIds,
  endpoints,
  getEndpoint,
  isPageEndpoint,
  type EndpointDefinition,
  type EndpointId,
  type EndpointRegistry,
  type PageEndpointId,
  type ParamsOf,
  type RecordOf,
  type ResultShape,
} from './registry.js'

export {
  describeParams,
  paramsJsonSchema,
  type JsonSchema,
  type ParamDescriptor,
  type ParamKind,
} from './json-schema.js'

export {
  toCliPath,
  toKebabCase,
  toMcpToolName,
  toSnakeCase,
  words,
} from './naming.js'

export {
  envelopeSchema,
  pageSchema,
  singleSchema,
  type Envelope,
  type Page,
} from './normalize.js'

export { parseElvantoDate, type Reference } from './zod-helpers.js'

// Resource schemas and their inferred types.
export {
  customFieldSchema,
  familyMemberSchema,
  familySchema,
  peopleCategorySchema,
  personReferenceSchema,
  personSchema,
  type CustomField,
  type Family,
  type FamilyMember,
  type PeopleCategory,
  type Person,
  type PersonReference,
} from './schemas/people.js'

export {
  demographicSchema,
  departmentSchema,
  type Demographic,
  type Department,
} from './schemas/common.js'

export {
  groupMemberSchema,
  groupSchema,
  type Group,
  type GroupMember,
} from './schemas/groups.js'

export {
  planItemSchema,
  planSchema,
  scheduledVolunteerSchema,
  serviceFileSchema,
  serviceNoteSchema,
  serviceSchema,
  serviceSongSchema,
  serviceTimeSchema,
  volunteerPlanSchema,
  volunteerPositionSchema,
  type Plan,
  type PlanItem,
  type ScheduledVolunteer,
  type Service,
  type ServiceFile,
  type ServiceNote,
  type ServiceSong,
  type ServiceTime,
  type VolunteerPlan,
  type VolunteerPosition,
} from './schemas/services.js'

export {
  arrangementSchema,
  songCategorySchema,
  songFileSchema,
  songKeySchema,
  songSchema,
  type Arrangement,
  type Song,
  type SongCategory,
  type SongFile,
  type SongKey,
} from './schemas/songs.js'

export {
  calendarEventSchema,
  calendarSchema,
  type Calendar,
  type CalendarEvent,
} from './schemas/calendar.js'

export {
  batchSchema,
  financialCategorySchema,
  transactionAmountSchema,
  transactionSchema,
  type Batch,
  type FinancialCategory,
  type Transaction,
  type TransactionAmount,
} from './schemas/financial.js'

export {
  peopleFlowSchema,
  peopleFlowStepAdminSchema,
  peopleFlowStepMemberSchema,
  peopleFlowStepSchema,
  peopleFlowStepSummarySchema,
  type PeopleFlow,
  type PeopleFlowStep,
  type PeopleFlowStepAdmin,
  type PeopleFlowStepMember,
  type PeopleFlowStepSummary,
} from './schemas/peopleFlows.js'
