/**
 * Live verification against a real Elvanto account.
 *
 * Every schema in this repo is derived from Elvanto's documentation examples,
 * not from a machine-readable spec, so the only way to know they are right is to
 * call the API. This script exercises each read-only endpoint, chains IDs from
 * one call into the next, and reports three things per endpoint:
 *
 *   - whether the call succeeded
 *   - fields Elvanto returned that our schema does not declare (docs incomplete)
 *   - fields we declare but never saw (possibly wrong, possibly just not in use)
 *
 * Values are redacted by default: this touches real member data. Pass
 * --include-data to see samples, and --financial to include giving records.
 *
 * Usage:
 *   ELVANTO_API_KEY=... pnpm smoke
 *   ELVANTO_API_KEY=... pnpm smoke --financial --json report.json
 *   ELVANTO_API_KEY=... pnpm smoke --person <id>   # force the detail record
 *
 * The detail endpoints are given whichever record populates the most inferred
 * collections, rather than the first one returned — an empty collection cannot
 * tell a correct wrapper key from a wrong one.
 */
import { writeFile } from 'node:fs/promises'
import {
  ElvantoApiError,
  ElvantoClient,
  endpointIds,
  getEndpoint,
  type ElvantoValidationWarning,
  type EndpointDefinition,
  type EndpointId,
} from '../packages/elvanto/src/index.js'

interface EndpointReport {
  id: string
  /**
   * `empty` is separated from `api-error` because Elvanto answers "no records
   * match your criteria" with a 404 — an account with no songs is not a problem
   * with the endpoint, and reporting it as an error buries the real ones.
   */
  status: 'ok' | 'empty' | 'skipped' | 'api-error' | 'failed'
  detail?: string
  recordCount?: number
  /** Keys Elvanto returned that our schema does not declare. */
  undocumentedFields?: string[]
  /** Keys our schema declares that never appeared. */
  unseenFields?: string[]
  warnings?: string[]
  sample?: unknown
}

const args = new Set(process.argv.slice(2))
const includeData = args.has('--include-data')
const includeFinancial = args.has('--financial')
const jsonPathIndex = process.argv.indexOf('--json')
const jsonPath = jsonPathIndex > -1 ? process.argv[jsonPathIndex + 1] : undefined
const personIndex = process.argv.indexOf('--person')
const forcedPersonId = personIndex > -1 ? process.argv[personIndex + 1] : undefined

/**
 * Collections whose wrapper key and item shape are inferred rather than
 * documented — Elvanto names the field but publishes no populated example.
 *
 * These are the whole reason the sweep prefers a rich record over the first one:
 * an empty collection proves nothing, because a wrong key and a genuinely empty
 * list look identical. A populated one settles it, since a wrong key fails
 * validation rather than returning an empty array.
 */
const INFERRED_COLLECTIONS: Record<string, readonly string[]> = {
  'people.getAll': [
    'departments',
    'demographics',
    'service_types',
    'access_permissions',
    'locations',
    'family',
  ],
  'people.getInfo': [
    'departments',
    'demographics',
    'service_types',
    'access_permissions',
    'locations',
    'family',
  ],
  'groups.getAll': ['categories', 'departments', 'demographics', 'locations'],
  'groups.getInfo': ['categories', 'departments', 'demographics', 'locations'],
}

/** `endpoint.field` entries seen with at least one member, across the sweep. */
const provenPopulated = new Set<string>()

/**
 * Every documented optional field for a person.
 *
 * Requested in full so `unseenFields` means "Elvanto did not return this even
 * though we asked" — otherwise the report flags fields that were simply never
 * requested, which buries the real signal.
 */
const PERSON_OPTIONAL_FIELDS = [
  'gender', 'birthday', 'anniversary', 'school_grade', 'marital_status',
  'development_child', 'special_needs_child', 'security_code', 'receipt_name',
  'giving_number',
  'mailing_address', 'mailing_address2', 'mailing_city', 'mailing_state',
  'mailing_postcode', 'mailing_country',
  'home_address', 'home_address2', 'home_city', 'home_state', 'home_postcode',
  'home_country',
  'locations', 'departments', 'demographics', 'service_types',
  'access_permissions',
]

/** Every documented optional field for a service. */
const SERVICE_OPTIONAL_FIELDS = [
  'series_name', 'service_times', 'rehearsal_times', 'other_times', 'plans',
  'volunteers', 'songs', 'files', 'notes', 'picture',
]

const warnings: ElvantoValidationWarning[] = []

if (!process.env['ELVANTO_API_KEY'] && !process.env['ELVANTO_ACCESS_TOKEN']) {
  // Caught here rather than letting the client throw, so the failure reads as
  // usage guidance instead of a stack trace.
  process.stderr.write(
    'No credentials. This script needs a real Elvanto account:\n\n' +
      '  ELVANTO_API_KEY=$(op read "op://Private/Elvanto/api key") pnpm smoke\n' +
      '  ELVANTO_API_KEY=your-key pnpm smoke\n\n' +
      'Find the key in Elvanto under Settings > Account Settings > Secret API Key.\n' +
      'Nothing here reads a .env file — the key is passed per run on purpose.\n',
  )
  process.exit(2)
}

const client = new ElvantoClient({
  // warn, not throw: one unexpected shape must not stop the sweep.
  validate: 'warn',
  onWarning: (warning) => warnings.push(warning),
  userAgent: 'elvanto-smoke-test/0.1.0',
  maxRetries: 1,
})

/** IDs discovered as the sweep runs, used to reach the detail endpoints. */
const discovered: Record<string, string | undefined> = {}

/** Parameters for each endpoint, given what has been discovered so far. */
function paramsFor(id: EndpointId): Record<string, unknown> | 'skip' {
  const today = new Date()
  const yearAgo = new Date(today.getTime() - 365 * 24 * 60 * 60 * 1000)
  const fmt = (d: Date) => d.toISOString().slice(0, 10)

  switch (id) {
    case 'people.getAll':
      // A wide page, because the record that settles the inferred collections is
      // whoever is in the most departments — usually an admin, rarely the first
      // person alphabetically.
      return { page_size: 100, fields: PERSON_OPTIONAL_FIELDS }
    case 'people.search':
      return { page_size: 10, search: { archived: 'no' } }
    case 'people.getInfo':
      // `family` and `reports_to` are documented as retrieve-only, so they appear
      // here but not on getAll.
      return requireId('personId', {
        fields: [...PERSON_OPTIONAL_FIELDS, 'family', 'reports_to'],
      })
    case 'people.currentUser':
      // API keys cannot use this endpoint; only meaningful under OAuth.
      return process.env['ELVANTO_ACCESS_TOKEN'] ? {} : 'skip'
    case 'groups.getAll':
      return {
        page_size: 100,
        fields: ['people', 'categories', 'departments', 'demographics', 'locations'],
      }
    case 'groups.getInfo':
      return requireId('groupId', {
        fields: ['people', 'categories', 'departments', 'demographics', 'locations'],
      })
    case 'services.getAll':
      return { page_size: 10, all: 'yes', fields: SERVICE_OPTIONAL_FIELDS }
    case 'services.getInfo':
      return requireId('serviceId', { fields: SERVICE_OPTIONAL_FIELDS })
    case 'songs.getAll':
      return { page_size: 10, files: true }
    case 'songs.getInfo':
      return requireId('songId', { files: true })
    case 'songs.arrangements.getAll':
      return requireId('songId', { page_size: 10, files: true }, 'song_id')
    case 'songs.arrangements.getInfo':
      return requireId('arrangementId', { files: true })
    case 'songs.keys.getAll':
      return requireId('arrangementId', { page_size: 10, files: true }, 'arrangement_id')
    case 'songs.keys.getInfo':
      return requireId('keyId', { files: true })
    case 'calendar.events.getAll':
      return { page_size: 10, start: fmt(yearAgo), end: fmt(today) }
    case 'peopleFlows.steps.getAll':
      return requireId('flowId', {}, 'flow_id')
    case 'peopleFlows.steps.people':
      return requireId('stepId', {}, 'step_id')
    case 'financial.transactions.getAll':
      return includeFinancial
        ? { page_size: 10, start: fmt(yearAgo), end: fmt(today) }
        : 'skip'
    case 'financial.transactions.getInfo':
      return includeFinancial ? requireId('transactionId', {}) : 'skip'
    case 'financial.categories.getAll':
      return includeFinancial ? { page_size: 10 } : 'skip'
    default:
      return {}
  }
}

function requireId(
  key: string,
  extra: Record<string, unknown>,
  paramName = 'id',
): Record<string, unknown> | 'skip' {
  const value = discovered[key]
  if (!value) return 'skip'
  return { [paramName]: value, ...extra }
}

/**
 * How many of an endpoint's inferred collections this record actually populates.
 *
 * Also records what was seen, so the run can report which keys are still
 * unproven rather than leaving the reader to infer it from empty arrays.
 */
function scoreCoverage(id: EndpointId, record: Record<string, unknown>): number {
  const fields = INFERRED_COLLECTIONS[id] ?? []
  let score = 0
  for (const field of fields) {
    const value = record[field]
    const populated = Array.isArray(value)
      ? value.length > 0
      : value != null && value !== '' && typeof value === 'object'
    if (populated) {
      score++
      provenPopulated.add(`${id.split('.')[0]}.${field}`)
    }
  }
  // An admin is the likeliest record to be attached to everything, so prefer one
  // when nothing else distinguishes the candidates.
  if (record['admin'] === true || record['admin'] === 1) score += 0.5
  return score
}

/** Picks the record that populates the most inferred collections. */
function richestRecord(
  id: EndpointId,
  records: Array<Record<string, unknown>>,
): Record<string, unknown> | undefined {
  let best: Record<string, unknown> | undefined
  let bestScore = -1
  for (const record of records) {
    const score = scoreCoverage(id, record)
    if (score > bestScore) {
      bestScore = score
      best = record
    }
  }
  return best
}

/** Remembers IDs from a result so later endpoints have something to ask for. */
function harvest(id: EndpointId, result: unknown): void {
  const records = (isPageResult(result) ? result.items : [result]).filter(
    (record): record is Record<string, unknown> =>
      typeof record === 'object' && record !== null,
  )
  const first = records[0]
  if (!first) return

  const rememberFrom = (target: string, source: unknown) => {
    if (typeof source === 'string' && source !== '') discovered[target] ??= source
  }

  switch (id) {
    case 'people.getAll': {
      if (forcedPersonId) {
        discovered['personId'] ??= forcedPersonId
        // Still score the page, so the coverage report reflects what was seen.
        for (const record of records) scoreCoverage(id, record)
        break
      }
      const best = richestRecord(id, records)
      rememberFrom('personId', best?.['id'])
      break
    }
    case 'people.getInfo':
      scoreCoverage(id, first)
      break
    case 'groups.getAll':
      rememberFrom('groupId', richestRecord(id, records)?.['id'])
      break
    case 'groups.getInfo':
      scoreCoverage(id, first)
      break
    case 'services.getAll': {
      // Prefer a service with a plan and songs: empty arrays prove nothing about
      // the plan-item and service-song schemas.
      const scored = records
        .map((record) => ({
          record,
          score:
            (Array.isArray(record['plans']) && record['plans'].length > 0 ? 2 : 0) +
            (Array.isArray(record['songs']) && record['songs'].length > 0 ? 2 : 0) +
            (Array.isArray(record['volunteers']) && record['volunteers'].length > 0 ? 1 : 0) +
            (Array.isArray(record['notes']) && record['notes'].length > 0 ? 1 : 0),
        }))
        .sort((a, b) => b.score - a.score)
      rememberFrom('serviceId', scored[0]?.record['id'])
      break
    }
    case 'songs.getAll':
      rememberFrom('songId', first['id'])
      break
    case 'songs.arrangements.getAll':
      rememberFrom('arrangementId', first['id'])
      break
    case 'songs.keys.getAll':
      rememberFrom('keyId', first['id'])
      break
    case 'financial.transactions.getAll':
      rememberFrom('transactionId', first['id'])
      break
    case 'peopleFlows.getAll': {
      rememberFrom('flowId', first['id'])
      const steps = first['steps']
      if (Array.isArray(steps) && steps.length > 0) {
        rememberFrom('stepId', (steps[0] as Record<string, unknown>)['id'])
      }
      break
    }
    case 'peopleFlows.steps.getAll':
      rememberFrom('stepId', first['id'])
      break
    default:
      break
  }
}

function isPageResult(value: unknown): value is { items: unknown[]; total: number } {
  return (
    typeof value === 'object' &&
    value !== null &&
    Array.isArray((value as { items?: unknown }).items)
  )
}

/** The keys a schema declares, when it is an object schema we can introspect. */
function declaredKeys(endpoint: EndpointDefinition): string[] | undefined {
  const item = endpoint.result.item as unknown
  const shape = (item as { shape?: Record<string, unknown> }).shape
  if (shape && typeof shape === 'object') return Object.keys(shape)
  // People Flows use z.lazy for their recursive steps; unwrap one level.
  const inner = (item as { _zod?: { def?: { getter?: () => unknown } } })._zod?.def?.getter
  if (typeof inner === 'function') {
    const resolved = inner() as { shape?: Record<string, unknown> }
    if (resolved.shape) return Object.keys(resolved.shape)
  }
  return undefined
}

/** Compares returned keys against declared keys, both directions. */
function compareFields(
  endpoint: EndpointDefinition,
  result: unknown,
): Pick<EndpointReport, 'undocumentedFields' | 'unseenFields'> {
  const declared = declaredKeys(endpoint)
  if (!declared) return {}

  const records = (isPageResult(result) ? result.items : [result]).filter(
    (record): record is Record<string, unknown> =>
      typeof record === 'object' && record !== null,
  )
  if (records.length === 0) return {}

  const seen = new Set<string>()
  for (const record of records) for (const key of Object.keys(record)) seen.add(key)

  const undocumented = [...seen].filter(
    // custom_<uuid> keys are expected and account-specific, not schema gaps.
    (key) => !declared.includes(key) && !key.startsWith('custom_'),
  )
  const unseen = declared.filter((key) => !seen.has(key))

  return {
    ...(undocumented.length > 0 ? { undocumentedFields: undocumented.sort() } : {}),
    ...(unseen.length > 0 ? { unseenFields: unseen.sort() } : {}),
  }
}

/** Strips values, keeping structure, so real member data is not printed. */
function redact(value: unknown, depth = 0): unknown {
  if (depth > 4) return '…'
  if (Array.isArray(value)) {
    return value.length === 0 ? [] : [redact(value[0], depth + 1), `…${value.length} total`]
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, inner]) => [key, redact(inner, depth + 1)]),
    )
  }
  if (typeof value === 'string') return value === '' ? '' : `<string:${value.length}>`
  if (typeof value === 'number') return '<number>'
  if (typeof value === 'boolean') return '<boolean>'
  return value
}

async function run(): Promise<EndpointReport[]> {
  const reports: EndpointReport[] = []

  for (const id of endpointIds) {
    const endpoint = getEndpoint(id)
    const before = warnings.length
    const params = paramsFor(id)

    if (params === 'skip') {
      reports.push({
        id,
        status: 'skipped',
        detail:
          id.startsWith('financial') && !includeFinancial
            ? 'giving data — pass --financial to include'
            : id === 'people.currentUser'
              ? 'requires OAuth (set ELVANTO_ACCESS_TOKEN)'
              : 'no ID available from an earlier endpoint',
      })
      process.stderr.write(`  skip  ${id}\n`)
      continue
    }

    try {
      const result = await client.call(id, params as never)
      harvest(id, result)

      const raised = warnings.slice(before).map((warning) => warning.message)
      const report: EndpointReport = {
        id,
        status: 'ok',
        ...(isPageResult(result)
          ? { recordCount: result.items.length }
          : { recordCount: 1 }),
        ...compareFields(endpoint, result),
        ...(raised.length > 0 ? { warnings: raised } : {}),
      }
      if (includeData) {
        report.sample = isPageResult(result) ? result.items[0] : result
      } else {
        const first = isPageResult(result) ? result.items[0] : result
        report.sample = redact(first)
      }
      reports.push(report)

      const flags = [
        report.undocumentedFields?.length ? `+${report.undocumentedFields.length} undocumented` : '',
        raised.length ? `${raised.length} warning(s)` : '',
      ]
        .filter(Boolean)
        .join(', ')
      process.stderr.write(`  ok    ${id}${flags ? `  (${flags})` : ''}\n`)
    } catch (error) {
      if (error instanceof ElvantoApiError && error.isNotFound) {
        reports.push({
          id,
          status: 'empty',
          recordCount: 0,
          detail: error.message,
        })
        process.stderr.write(`  empty ${id}  (nothing in this account)\n`)
        continue
      }

      const isApiError = error instanceof ElvantoApiError
      reports.push({
        id,
        status: isApiError ? 'api-error' : 'failed',
        detail: error instanceof Error ? error.message : String(error),
      })
      process.stderr.write(
        `  FAIL  ${id}\n        ${error instanceof Error ? error.message.split('\n')[0] : String(error)}\n`,
      )
    }
  }

  return reports
}

process.stderr.write('Sweeping Elvanto read-only endpoints…\n\n')
const reports = await run()

const counts = reports.reduce<Record<string, number>>((acc, report) => {
  acc[report.status] = (acc[report.status] ?? 0) + 1
  return acc
}, {})

process.stderr.write(
  `\n${counts['ok'] ?? 0} ok, ${counts['empty'] ?? 0} empty, ` +
    `${counts['skipped'] ?? 0} skipped, ${counts['api-error'] ?? 0} API errors, ` +
    `${counts['failed'] ?? 0} failed\n`,
)

const undocumented = reports.filter((r) => r.undocumentedFields?.length)
if (undocumented.length > 0) {
  process.stderr.write('\nFields Elvanto returned that our schemas do not declare:\n')
  for (const report of undocumented) {
    process.stderr.write(`  ${report.id}: ${report.undocumentedFields!.join(', ')}\n`)
  }
}

// The inferred collections: which are now proven, and which are still guesses.
const inferredFields = [
  ...new Set(
    Object.entries(INFERRED_COLLECTIONS).flatMap(([id, fields]) =>
      fields.map((field) => `${id.split('.')[0]}.${field}`),
    ),
  ),
].sort()
const proven = inferredFields.filter((field) => provenPopulated.has(field))
const unproven = inferredFields.filter((field) => !provenPopulated.has(field))

if (inferredFields.length > 0) {
  process.stderr.write('\nInferred collection keys (no documented example exists):\n')
  if (proven.length > 0) {
    process.stderr.write(`  confirmed by real data: ${proven.join(', ')}\n`)
  }
  if (unproven.length > 0) {
    process.stderr.write(
      `  still unproven:          ${unproven.join(', ')}\n` +
        `  Every record swept had these empty, which cannot distinguish a correct\n` +
        `  key from a wrong one. Re-run against a record that has them —\n` +
        `  pnpm smoke --person <id> — to settle it.\n`,
    )
  }
}

const warned = reports.filter((r) => r.warnings?.length)
if (warned.length > 0) {
  process.stderr.write('\nSchema mismatches (these are the ones worth reporting):\n')
  for (const report of warned) {
    for (const warning of report.warnings!) {
      process.stderr.write(`  ${warning}\n`)
    }
  }
}

if (jsonPath) {
  await writeFile(jsonPath, JSON.stringify({ reports }, null, 2))
  process.stderr.write(`\nFull report written to ${jsonPath}\n`)
} else {
  process.stdout.write(`${JSON.stringify({ reports }, null, 2)}\n`)
}

// Non-zero only for genuine failures; an API error may just be an empty account.
process.exitCode = (counts['failed'] ?? 0) > 0 ? 1 : 0
