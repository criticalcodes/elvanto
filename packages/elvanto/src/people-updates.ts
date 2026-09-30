import { z } from 'zod'
import type { ElvantoClient } from './client.js'
import { ElvantoError } from './errors.js'
import { customFieldSchema, type CustomField } from './schemas/people.js'

/**
 * Batch changes to people, planned against their current records.
 *
 * `people.edit` replaces a multi-select custom field wholesale, so "take Sam off
 * Kids" sent naively also wipes their Youth role. This reads each person
 * first, applies additions and removals to what is actually there, and writes the
 * merged set — and by default writes nothing at all, returning the before and
 * after for someone to approve.
 *
 * The scope is deliberately narrow: email, people category, and custom fields of
 * the text, date, single-select and multi-select kinds. Names, family, login and
 * the free-text note fields are out of reach, so a batch cannot damage them.
 *
 * People are addressed by Elvanto id only. Resolving a name is a judgement call
 * (the same name turns up twice, a surname is misspelt), and it belongs to
 * whoever builds the batch, before anything is written.
 */

/** One person's changes. Field keys are `custom_<uuid>` or the field's name. */
export interface PersonUpdate {
  id: string
  /** Multi-select options to add, by option name, keyed by field. */
  add?: Record<string, string[]>
  /** Multi-select options to remove, by option name, keyed by field. */
  remove?: Record<string, string[]>
  /**
   * Values to set: `email`, `category_id`, or a text, date (`YYYY-MM-DD`) or
   * single-select (option name) custom field. An empty string clears it.
   */
  set?: Record<string, string>
}

/** Most people one call will touch. Bigger batches go in several calls. */
export const MAX_PEOPLE_UPDATES = 100

export interface PeopleUpdateRequest {
  updates: PersonUpdate[]
  /** Write the changes. Default false: plan them and report, writing nothing. */
  apply?: boolean
}

export interface FieldChange {
  /** The key written: `email`, `category_id` or `custom_<uuid>`. */
  field: string
  /** Human name for the field. */
  label: string
  before: string | string[]
  after: string | string[]
  /** After applying: whether a read-back shows the new value. */
  landed?: boolean
  /** After applying, when it did not land: what the read-back shows. */
  found?: string | string[]
}

export type PersonUpdateStatus =
  /** Dry run: these changes would be written. */
  | 'would-change'
  /** Nothing to do — the record already matches. */
  | 'unchanged'
  /** The update itself is wrong: unknown field, option or format. */
  | 'invalid'
  /** The person could not be read. */
  | 'error'
  /** Every change was written and read back. */
  | 'applied'
  /** Some changes read back as written, others did not. */
  | 'partly-applied'
  /** None of the changes read back as written. */
  | 'not-applied'

export interface PersonUpdateResult {
  id: string
  /** "Firstname Lastname", once the person has been read. */
  name?: string
  status: PersonUpdateStatus
  changes: FieldChange[]
  problems: string[]
}

export interface PeopleUpdateReport {
  applied: boolean
  /** Why nothing was written, when `apply` was asked for but refused. */
  refused?: string
  results: PersonUpdateResult[]
  summary: Partial<Record<PersonUpdateStatus, number>>
}


/**
 * The request as a schema, for a tool's input. Structure only — whether a field
 * or option exists is checked against the account in {@link updatePeople}.
 */
export const peopleUpdateRequestSchema = z.object({
  apply: z
    .boolean()
    .optional()
    .describe(
      'Write the changes. Default false: a dry run that reads each person and ' +
        'returns the before and after without writing. Show the dry run to the ' +
        'user and apply only once they approve it.',
    ),
  updates: z
    .array(
      z.object({
        id: z
          .string()
          .min(1)
          .describe('The Elvanto person ID. Resolve names to IDs first; never guess.'),
        add: z
          .record(z.string(), z.array(z.string()))
          .optional()
          .describe(
            'Multi-select options to add, by option name, keyed by field ' +
              '(custom_<uuid> or the field name), e.g. {"Serving Roles": ["Music"]}. ' +
              'Options already there are kept.',
          ),
        remove: z
          .record(z.string(), z.array(z.string()))
          .optional()
          .describe('Multi-select options to remove, in the same form as add. Others are kept.'),
        set: z
          .record(z.string(), z.string())
          .optional()
          .describe(
            'Values to set: "email", "category_id", or a text, date (YYYY-MM-DD) or ' +
              'single-select (option name) custom field. "" clears a value.',
          ),
      }),
    )
    .min(1)
    .max(MAX_PEOPLE_UPDATES)
    .describe(`Up to ${MAX_PEOPLE_UPDATES} people per call.`),
})

/** {@link peopleUpdateRequestSchema} as JSON Schema, for a tool definition. */
export function peopleUpdateRequestJsonSchema(): Record<string, unknown> {
  const schema = z.toJSONSchema(peopleUpdateRequestSchema, { io: 'input' }) as Record<string, unknown>
  delete schema['$schema']
  return schema
}

/**
 * Checks a tool's arguments against the request's structure.
 *
 * Returns the typed request, or a message naming each problem — for a caller that
 * hands the message back to a model rather than throwing.
 */
export function parsePeopleUpdateRequest(
  args: unknown,
): { ok: true; request: PeopleUpdateRequest } | { ok: false; message: string } {
  const parsed = peopleUpdateRequestSchema.safeParse(args ?? {})
  return parsed.success
    ? { ok: true, request: parsed.data }
    : { ok: false, message: z.prettifyError(parsed.error) }
}

const DIRECT_FIELDS: Record<string, string> = {
  email: 'Email',
  category_id: 'People category',
}

/** Custom field types `set` may write. Free-text notes are left out on purpose. */
const SETTABLE_TYPES = new Set(['text', 'datepicker', 'select'])

/**
 * Plans, and with `apply: true` writes, a batch of person updates.
 *
 * Applying re-reads every record rather than trusting an earlier dry run, so the
 * merge is against the record as it is now. If any update in the batch is
 * invalid, nothing is written: a batch that is partly wrong is better fixed and
 * re-run whole than half applied.
 *
 * Each write is followed by a read, and the result reports what landed rather
 * than what was sent — Elvanto has been seen to answer a custom-field edit with a
 * "problem saving to the database" error, which leaves the outcome to be found
 * out rather than assumed.
 */
export async function updatePeople(
  client: ElvantoClient,
  request: PeopleUpdateRequest,
): Promise<PeopleUpdateReport> {
  const { updates, apply = false } = request
  if (updates.length === 0) {
    throw new ElvantoError('No updates given.')
  }
  if (updates.length > MAX_PEOPLE_UPDATES) {
    throw new ElvantoError(
      `${updates.length} updates in one call; the limit is ${MAX_PEOPLE_UPDATES}. Split the batch.`,
    )
  }

  const definitions = await client.people.customFields.getAll()
  const fields = new FieldIndex(definitions.items)

  const counts = new Map<string, number>()
  for (const update of updates) counts.set(update.id, (counts.get(update.id) ?? 0) + 1)

  const plans: Plan[] = []
  for (const update of updates) {
    plans.push(await plan(client, fields, update, counts.get(update.id)! > 1))
  }

  const blocked = plans.filter((p) => p.result.status === 'invalid' || p.result.status === 'error')
  if (!apply || blocked.length > 0) {
    return report(
      plans.map((p) => p.result),
      false,
      apply && blocked.length > 0
        ? `${blocked.length} update(s) are invalid or unreadable, so nothing was written. ` +
            `Fix them and run again.`
        : undefined,
    )
  }

  const results: PersonUpdateResult[] = []
  for (const p of plans) {
    results.push(p.result.status === 'would-change' ? await write(client, fields, p) : p.result)
  }
  return report(results, true)
}

interface Plan {
  result: PersonUpdateResult
  /** The `people.edit` parameters, when there is something to write. */
  edit?: Record<string, unknown>
}

async function plan(
  client: ElvantoClient,
  fields: FieldIndex,
  update: PersonUpdate,
  duplicated: boolean,
): Promise<Plan> {
  const result: PersonUpdateResult = { id: update.id, status: 'invalid', changes: [], problems: [] }
  if (duplicated) {
    result.problems.push('This id appears more than once in the batch; combine its updates.')
  }

  // Resolve every key before reading, so a typo is reported without a request.
  const touched = new Map<string, CustomField>()
  const resolve = (key: string, want: 'multi' | 'set'): CustomField | undefined => {
    const field = fields.find(key)
    if (!field) {
      result.problems.push(`Unknown field "${key}". Use people.customFields.getAll for the keys.`)
      return undefined
    }
    const multi = field.type === 'select_multi'
    if (want === 'multi' && !multi) {
      result.problems.push(`"${field.name}" is not a multi-select, so it cannot take add/remove. Use set.`)
      return undefined
    }
    if (want === 'set' && multi) {
      result.problems.push(`"${field.name}" is a multi-select; use add/remove rather than set.`)
      return undefined
    }
    if (want === 'set' && !SETTABLE_TYPES.has(field.type ?? '')) {
      result.problems.push(`"${field.name}" is a ${field.type} field, which this tool does not change.`)
      return undefined
    }
    touched.set(fieldKey(field), field)
    return field
  }

  const multiEdits = new Map<string, { field: CustomField; add: string[]; remove: string[] }>()
  for (const [mode, entries] of [['add', update.add], ['remove', update.remove]] as const) {
    for (const [key, names] of Object.entries(entries ?? {})) {
      const field = resolve(key, 'multi')
      if (!field) continue
      const entry = multiEdits.get(fieldKey(field)) ?? { field, add: [], remove: [] }
      for (const name of names) {
        const option = fields.option(field, name)
        if (option) entry[mode].push(option)
        else result.problems.push(`"${name}" is not an option of "${field.name}". Options: ${optionNames(field).join(', ')}.`)
      }
      multiEdits.set(fieldKey(field), entry)
    }
  }
  for (const entry of multiEdits.values()) {
    const both = entry.add.filter((name) => entry.remove.includes(name))
    if (both.length > 0) {
      result.problems.push(`"${both.join('", "')}" is both added to and removed from "${entry.field.name}".`)
    }
  }

  const sets: Array<{ key: string; label: string; value: string; field?: CustomField }> = []
  for (const [key, value] of Object.entries(update.set ?? {})) {
    if (key in DIRECT_FIELDS) {
      sets.push({ key, label: DIRECT_FIELDS[key]!, value })
      continue
    }
    const field = resolve(key, 'set')
    if (!field) continue
    let written = value
    if (value !== '' && field.type === 'datepicker' && !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      result.problems.push(`"${field.name}" takes a date as YYYY-MM-DD, not "${value}".`)
      continue
    }
    if (value !== '' && field.type === 'select') {
      const option = fields.option(field, value)
      if (!option) {
        result.problems.push(`"${value}" is not an option of "${field.name}". Options: ${optionNames(field).join(', ')}.`)
        continue
      }
      written = option
    }
    sets.push({ key: fieldKey(field), label: field.name ?? key, value: written, field })
  }

  if (multiEdits.size === 0 && sets.length === 0 && result.problems.length === 0) {
    result.problems.push('No changes given: pass add, remove or set.')
  }
  if (result.problems.length > 0) return { result }

  let record: Record<string, unknown>
  try {
    record = await readPerson(client, update.id, [...touched.keys()])
  } catch (error) {
    result.status = 'error'
    result.problems.push(`Could not read this person: ${error instanceof Error ? error.message : String(error)}`)
    return { result }
  }
  result.name = personName(record)

  const edit: Record<string, unknown> = { id: update.id }
  const customValues: Record<string, unknown> = {}

  for (const [key, entry] of multiEdits) {
    const before = readMulti(record[key])
    const wanted = new Set(before.filter((name) => !entry.remove.includes(name)))
    for (const name of entry.add) wanted.add(name)
    // In the field's own option order, so the diff reads the way Elvanto shows it.
    const after = optionNames(entry.field).filter((name) => wanted.has(name))
    if (sameSet(before, after)) continue
    result.changes.push({ field: key, label: entry.field.name ?? key, before, after })
    customValues[key] = customValue(entry.field, after)
  }

  for (const set of sets) {
    const before = set.field ? readSingle(record[set.key]) : String(record[set.key] ?? '')
    if (sameValue(before, set.value, set.field?.type)) continue
    result.changes.push({ field: set.key, label: set.label, before, after: set.value })
    if (set.field) customValues[set.key] = customValue(set.field, set.value)
    else edit[set.key] = set.value
  }

  if (result.changes.length === 0) {
    result.status = 'unchanged'
    return { result }
  }
  if (Object.keys(customValues).length > 0) edit['fields'] = customValues
  result.status = 'would-change'
  return { result, edit }
}

async function write(
  client: ElvantoClient,
  fields: FieldIndex,
  { result, edit }: Plan,
): Promise<PersonUpdateResult> {
  const out: PersonUpdateResult = { ...result, changes: result.changes.map((c) => ({ ...c })) }
  try {
    await client.people.edit(edit as never)
  } catch (error) {
    // Recorded, then checked: a failed write may still have landed.
    out.problems.push(`Elvanto reported: ${error instanceof Error ? error.message : String(error)}`)
  }

  let record: Record<string, unknown>
  try {
    const custom = out.changes.map((c) => c.field).filter((f) => f.startsWith('custom_'))
    record = await readPerson(client, out.id, custom)
  } catch (error) {
    out.status = 'not-applied'
    out.problems.push(
      `Could not read the person back to check the write, so whether it landed is unknown: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    )
    return out
  }

  for (const change of out.changes) {
    const type = fields.find(change.field)?.type
    const found = Array.isArray(change.after)
      ? readMulti(record[change.field])
      : change.field.startsWith('custom_')
        ? readSingle(record[change.field])
        : String(record[change.field] ?? '')
    change.landed = Array.isArray(change.after)
      ? sameSet(found as string[], change.after)
      : sameValue(found as string, change.after, type)
    if (!change.landed) change.found = found
  }
  const landed = out.changes.filter((c) => c.landed).length
  out.status =
    landed === out.changes.length ? 'applied' : landed === 0 ? 'not-applied' : 'partly-applied'
  return out
}

async function readPerson(
  client: ElvantoClient,
  id: string,
  customKeys: string[],
): Promise<Record<string, unknown>> {
  // `off`: this reads a handful of fields, and a schema quirk elsewhere in the
  // record should not stop a batch.
  const person = await client.people.getInfo(
    { id, ...(customKeys.length > 0 ? { fields: customKeys } : {}) },
    { validate: 'off' },
  )
  return person as unknown as Record<string, unknown>
}

function report(
  results: PersonUpdateResult[],
  applied: boolean,
  refused?: string,
): PeopleUpdateReport {
  const summary: Partial<Record<PersonUpdateStatus, number>> = {}
  for (const r of results) summary[r.status] = (summary[r.status] ?? 0) + 1
  return { applied, ...(refused ? { refused } : {}), results, summary }
}

/** Custom field lookup by key or by name, and option lookup by name. */
class FieldIndex {
  private readonly byKey = new Map<string, CustomField>()
  private readonly byName = new Map<string, CustomField>()

  constructor(definitions: unknown[]) {
    for (const raw of definitions) {
      // Parsed here rather than trusted: under validate "off" the client returns
      // definitions unflattened, with options still wrapped as { value: [...] },
      // and every option lookup would silently find nothing.
      const parsed = customFieldSchema.safeParse(raw)
      if (!parsed.success) continue
      const field = parsed.data
      this.byKey.set(fieldKey(field), field)
      if (field.name) this.byName.set(field.name.trim().toLowerCase(), field)
    }
  }

  find(key: string): CustomField | undefined {
    return this.byKey.get(key) ?? this.byName.get(key.trim().toLowerCase())
  }

  /** The option's canonical name, matched case-insensitively. */
  option(field: CustomField, name: string): string | undefined {
    const wanted = name.trim().toLowerCase()
    return optionNames(field).find((option) => option.toLowerCase() === wanted)
  }
}

/**
 * A custom field value in the form `people/edit` accepts, as established against
 * a live account: a checkbox takes an array of option names, and is cleared with
 * `""` (an empty array is accepted and changes nothing); everything else,
 * drop-downs included, takes a string. Elvanto's field reference says a drop-down
 * takes an array, but a live account rejects one as "Invalid Value".
 */
function customValue(field: CustomField, value: string | string[]): string | string[] {
  if (Array.isArray(value)) return value.length === 0 ? '' : value
  return value
}

function fieldKey(field: CustomField): string {
  return `custom_${field.id}`
}

function optionNames(field: CustomField): string[] {
  return (field.values ?? []).map((v) => v.name).filter((n): n is string => !!n)
}

/**
 * A multi-select as Elvanto returns it: `{ custom_field: [{ id, name }] }`, or
 * `""` when empty. Confirmed against a live account.
 */
export function readMulti(value: unknown): string[] {
  if (value == null || value === '') return []
  const inner =
    typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)['custom_field']
      : value
  const items = Array.isArray(inner) ? inner : inner == null ? [] : [inner]
  return items
    .map((item) =>
      typeof item === 'string' ? item : (item as { name?: unknown })?.name,
    )
    .filter((name): name is string => typeof name === 'string' && name !== '')
}

/**
 * A text, date or single-select value. The single-select shape has not been
 * seen live, so the multi-select wrapper and a bare `{ name }` are both accepted.
 */
function readSingle(value: unknown): string {
  if (value == null) return ''
  if (typeof value === 'string' || typeof value === 'number') return String(value)
  const names = readMulti(value)
  if (names.length > 0) return names[0]!
  const name = (value as { name?: unknown }).name
  return typeof name === 'string' ? name : ''
}

function sameSet(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((x) => b.includes(x))
}

/**
 * Compares a read value with a written one. Dates are compared as dates, since
 * the read-back format has not been seen live and may not be `YYYY-MM-DD`.
 */
function sameValue(read: string, written: string, type: string | undefined): boolean {
  if (type === 'datepicker') return isoDate(read) === isoDate(written)
  if (type === 'select') return read.trim().toLowerCase() === written.trim().toLowerCase()
  return read.trim() === written.trim()
}

function isoDate(value: string): string {
  const v = value.trim()
  if (v === '' || v.startsWith('0000-00-00')) return ''
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(v)
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`
  const dmy = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(v)
  if (dmy) return `${dmy[3]}-${dmy[2]!.padStart(2, '0')}-${dmy[1]!.padStart(2, '0')}`
  return v
}

function personName(record: Record<string, unknown>): string {
  const preferred = typeof record['preferred_name'] === 'string' ? record['preferred_name'] : ''
  const first = preferred || (typeof record['firstname'] === 'string' ? record['firstname'] : '')
  const last = typeof record['lastname'] === 'string' ? record['lastname'] : ''
  return `${first} ${last}`.trim()
}
