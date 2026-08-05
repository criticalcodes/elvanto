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
 */
import { existsSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import {
  ElvantoApiError,
  ElvantoClient,
  endpointIds,
  getEndpoint,
  type ElvantoValidationWarning,
  type EndpointDefinition,
  type EndpointId,
} from '../packages/elvanto/src/index.js'

/**
 * Load the repository's `.env` before anything reads credentials.
 *
 * Must run before the client is constructed below, since that is when the
 * environment is consulted. Existing environment variables win, so an explicit
 * `ELVANTO_API_KEY=… pnpm smoke` still overrides the file.
 */
function loadDotEnv(): void {
  const path = fileURLToPath(new URL('../.env', import.meta.url))
  if (!existsSync(path)) return

  if (typeof process.loadEnvFile !== 'function') {
    process.stderr.write(
      'Found .env but this Node version cannot read it (needs 20.12+). ' +
        'Pass the variables directly instead.\n',
    )
    return
  }
  process.loadEnvFile(path)
}

loadDotEnv()

interface EndpointReport {
  id: string
  status: 'ok' | 'skipped' | 'api-error' | 'failed'
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

const warnings: ElvantoValidationWarning[] = []

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
      // Ask for the optional fields too — that is where the schema is least sure.
      return {
        page_size: 10,
        fields: [
          'gender', 'birthday', 'anniversary', 'school_grade', 'marital_status',
          'locations', 'departments', 'demographics', 'service_types',
          'access_permissions', 'mailing_address', 'home_address',
        ],
      }
    case 'people.search':
      return { page_size: 10, search: { archived: 'no' } }
    case 'people.getInfo':
      return requireId('personId', { fields: ['locations', 'family', 'reports_to'] })
    case 'people.currentUser':
      // API keys cannot use this endpoint; only meaningful under OAuth.
      return process.env['ELVANTO_ACCESS_TOKEN'] ? {} : 'skip'
    case 'groups.getAll':
      return { page_size: 10, fields: ['people'] }
    case 'groups.getInfo':
      return requireId('groupId', { fields: ['people'] })
    case 'services.getAll':
      return {
        page_size: 10,
        all: 'yes',
        fields: [
          'series_name', 'service_times', 'rehearsal_times', 'other_times',
          'plans', 'volunteers', 'songs', 'files', 'notes', 'picture',
        ],
      }
    case 'services.getInfo':
      return requireId('serviceId', {
        fields: ['series_name', 'service_times', 'plans', 'volunteers', 'songs', 'files', 'notes'],
      })
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

/** Remembers IDs from a result so later endpoints have something to ask for. */
function harvest(id: EndpointId, result: unknown): void {
  const records = isPageResult(result) ? result.items : [result]
  const first = records[0] as Record<string, unknown> | undefined
  if (!first) return

  const rememberFrom = (target: string, source: unknown) => {
    if (typeof source === 'string' && source !== '') discovered[target] ??= source
  }

  switch (id) {
    case 'people.getAll':
      rememberFrom('personId', first['id'])
      break
    case 'groups.getAll':
      rememberFrom('groupId', first['id'])
      break
    case 'services.getAll':
      rememberFrom('serviceId', first['id'])
      break
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
  `\n${counts['ok'] ?? 0} ok, ${counts['skipped'] ?? 0} skipped, ` +
    `${counts['api-error'] ?? 0} API errors, ${counts['failed'] ?? 0} failed\n`,
)

const undocumented = reports.filter((r) => r.undocumentedFields?.length)
if (undocumented.length > 0) {
  process.stderr.write('\nFields Elvanto returned that our schemas do not declare:\n')
  for (const report of undocumented) {
    process.stderr.write(`  ${report.id}: ${report.undocumentedFields!.join(', ')}\n`)
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
