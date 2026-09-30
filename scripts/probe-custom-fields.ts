/**
 * Finds out how Elvanto accepts custom-field writes, against a real account.
 *
 * A live sweep saw `people/edit` answer "problem when saving to the database" for
 * some custom-field writes and not others, and the documentation does not say
 * what format each field type takes. This runs one small experiment per
 * hypothesis and reports what Elvanto answered and what the record then held.
 *
 * Three modes, from harmless to less so:
 *
 *   (default)          Read only. Prints the field definitions it would use, and
 *                      the *shape* of stored values across the account (digits as
 *                      9, letters as a) — never a value.
 *   --noop <personId>  Writes each probed field of that person back with the
 *                      value it already has. Changes nothing either way; tells
 *                      whether an established record accepts a custom-field write
 *                      at all. Prints that person's values for those fields.
 *   --write            Creates throwaway people named "Zz Probe … / Delete-Me",
 *                      one per experiment, and deletes them all at the end, even
 *                      on failure. Prints any it could not delete.
 *
 * The fields are picked by type: the first multi-select (checkbox) and the first
 * single-select (drop-down) with two or more options, the first date, the first
 * text field. Override with PROBE_MULTI, PROBE_SELECT, PROBE_DATE or PROBE_TEXT,
 * set to a field's name or its custom_<uuid> key.
 *
 * Elvanto's field reference says drop-down and checkbox values must be arrays and
 * everything else a string (https://www.elvanto.com/api/people-fields/). A live
 * account disagreed about drop-downs, which take a string; the experiments try
 * both, and names against ids.
 *
 * Steps are spaced a second and a half apart. Elvanto refuses a second edit to
 * the same person within the same wall-clock second, which would otherwise make
 * every format look broken at random. Pass --no-spacing to see that for yourself.
 *
 * Usage:
 *   ELVANTO_API_KEY=... pnpm probe:fields
 *   ELVANTO_API_KEY=... pnpm probe:fields --noop <personId>
 *   ELVANTO_API_KEY=... pnpm probe:fields --write
 */
import {
  ElvantoClient,
  customFieldSchema,
  readMulti,
  type CustomField,
} from '../packages/elvanto/src/index.js'

const API = (process.env['ELVANTO_BASE_URL']?.trim() || 'https://api.elvanto.com/v1').replace(/\/+$/, '')
const KEY = process.env['ELVANTO_API_KEY']?.trim()
if (!KEY) {
  process.stderr.write('Set ELVANTO_API_KEY.\n')
  process.exit(2)
}

const args = process.argv.slice(2)
const mode = args.includes('--write') ? 'write' : args.includes('--noop') ? 'noop' : 'inspect'
const noopPerson = mode === 'noop' ? args[args.indexOf('--noop') + 1] : undefined

const client = new ElvantoClient({ auth: { apiKey: KEY }, validate: 'off', maxRetries: 0 })

interface Probed {
  multi: CustomField
  select: CustomField
  date: CustomField
  text: CustomField
}

const key = (field: CustomField): string => `custom_${field.id}`
const options = (field: CustomField) => field.values ?? []

async function pickFields(): Promise<Probed> {
  // Parsed explicitly: with validation off, options would still be wrapped.
  const all = (await client.people.customFields.getAll()).items.map((f) => customFieldSchema.parse(f))
  const pick = (env: string, test: (f: CustomField) => boolean, what: string): CustomField => {
    const wanted = process.env[env]?.trim()
    const found = wanted
      ? all.find((f) => key(f) === wanted || f.name?.toLowerCase() === wanted.toLowerCase())
      : all.find(test)
    if (!found) throw new Error(`No ${what} field found${wanted ? ` matching ${env}=${wanted}` : ''}.`)
    return found
  }
  return {
    multi: pick('PROBE_MULTI', (f) => f.type === 'select_multi' && options(f).length >= 2, 'multi-select (2+ options)'),
    select: pick('PROBE_SELECT', (f) => f.type === 'select' && options(f).length >= 2, 'drop-down (2+ options)'),
    date: pick('PROBE_DATE', (f) => f.type === 'datepicker', 'date'),
    text: pick('PROBE_TEXT', (f) => f.type === 'text', 'text'),
  }
}

/** Digits as 9, letters as a, ids and names elided: the structure, never the data. */
function shape(value: unknown): string {
  if (typeof value === 'string') {
    return `"${value.replace(/[0-9]/g, '9').replace(/[A-Za-z]/g, 'a')}"`
  }
  if (Array.isArray(value)) return `[${value.map(shape).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value)
      .map(([k, v]) => `${k}:${k === 'id' || k === 'name' ? '…' : shape(v)}`)
      .join(',')}}`
  }
  return String(value)
}

async function inspect(fields: Probed): Promise<void> {
  console.log('Fields probed (definitions as Elvanto returns them):')
  for (const field of Object.values(fields)) console.log(`  ${JSON.stringify(field)}`)

  const tally = new Map<string, Map<string, number>>()
  let people = 0
  for await (const person of client.paginate('people.getAll', {
    page_size: 1000,
    fields: Object.values(fields).map(key),
  })) {
    people++
    for (const [label, field] of Object.entries(fields)) {
      const s = shape((person as Record<string, unknown>)[key(field)])
      const counts = tally.get(label) ?? new Map<string, number>()
      counts.set(s, (counts.get(s) ?? 0) + 1)
      tally.set(label, counts)
    }
  }
  console.log(`\nStored value shapes across ${people} people:`)
  for (const [label, counts] of tally) {
    console.log(`  ${label}:`)
    for (const [s, n] of [...counts].sort((a, b) => b[1] - a[1]).slice(0, 6)) {
      console.log(`    ${String(n).padStart(5)}  ${s.slice(0, 100)}`)
    }
  }
}

// ── Raw requests ───────────────────────────────────────────────────────────
// Bypassing the SDK, so a difference between encodings is Elvanto's and not ours.

type Encoding = 'json' | 'form'

async function rawPost(
  path: string,
  body: Record<string, unknown>,
  encoding: Encoding = 'json',
): Promise<{ ok: boolean; text: string; data: Record<string, unknown> }> {
  const headers: Record<string, string> = {
    Authorization: `Basic ${Buffer.from(`${KEY}:x`).toString('base64')}`,
    Accept: 'application/json',
  }
  let payload: string
  if (encoding === 'json') {
    headers['Content-Type'] = 'application/json'
    payload = JSON.stringify(body)
  } else {
    headers['Content-Type'] = 'application/x-www-form-urlencoded'
    payload = formEncode(body).toString()
  }
  const res = await fetch(`${API}/${path}.json`, { method: 'POST', headers, body: payload })
  const text = await res.text()
  let data: Record<string, unknown> = {}
  try {
    data = JSON.parse(text) as Record<string, unknown>
  } catch {
    // Left empty; `text` carries what came back.
  }
  return { ok: res.ok && data['status'] === 'ok', text, data }
}

/** PHP-style nesting — `fields[custom_x][]=A` — which is what Elvanto's stack reads natively. */
function formEncode(value: unknown, prefix = '', out = new URLSearchParams()): URLSearchParams {
  if (Array.isArray(value)) {
    for (const item of value) formEncode(item, `${prefix}[]`, out)
    if (value.length === 0) out.append(prefix, '')
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) formEncode(v, prefix ? `${prefix}[${k}]` : k, out)
  } else {
    out.append(prefix, String(value ?? ''))
  }
  return out
}

async function readBack(id: string, fields: Probed): Promise<string> {
  const res = await rawPost('people/getInfo', { id, fields: Object.values(fields).map(key) })
  const person = (res.data['person'] as Record<string, unknown>[] | undefined)?.[0]
  if (!person) return `(could not read: ${res.text.slice(0, 80)})`
  const multi = readMulti(person[key(fields.multi)])
  const select = person[key(fields.select)]
  const selected = select && typeof select === 'object' ? (select as { name?: unknown }).name : select
  return (
    `multi=${JSON.stringify(multi)} select=${JSON.stringify(selected)} ` +
    `date=${JSON.stringify(person[key(fields.date)])} ` +
    `text=${JSON.stringify(person[key(fields.text)])} family_id=${JSON.stringify(person['family_id'])}`
  )
}

// ── Experiments ────────────────────────────────────────────────────────────

interface Step {
  label: string
  body: Record<string, unknown>
  encoding?: Encoding
}

interface Experiment {
  name: string
  /** Extra parameters for people/create. */
  create?: Record<string, unknown>
  steps: Step[]
}

function experiments(f: Probed): Experiment[] {
  const [a, b] = options(f.multi)
  const A = a!.name!
  const B = b!.name!
  const [x, y] = options(f.select)
  const s = key(f.select)
  const m = key(f.multi)
  const d = key(f.date)
  const t = key(f.text)
  const fields = (values: Record<string, unknown>) => ({ fields: values })

  return [
    { name: 'text alone', steps: [{ label: 'set text', body: fields({ [t]: 'PROBE-1' }) }] },
    { name: 'date alone, YYYY-MM-DD', steps: [{ label: 'set date', body: fields({ [d]: '2027-03-17' }) }] },
    { name: 'date and text in one edit', steps: [{ label: 'set both', body: fields({ [d]: '2027-03-17', [t]: 'PROBE-1' }) }] },
    {
      name: 'second custom-field edit, different field',
      steps: [
        { label: 'set text', body: fields({ [t]: 'PROBE-1' }) },
        { label: 'then set date', body: fields({ [d]: '2027-03-17' }) },
      ],
    },
    {
      name: 'second edit to the same text field',
      steps: [
        { label: 'set text', body: fields({ [t]: 'PROBE-1' }) },
        { label: 'change text', body: fields({ [t]: 'PROBE-2' }) },
      ],
    },
    {
      name: 'a non-custom edit first',
      steps: [
        { label: 'set email', body: { email: 'probe@example.invalid' } },
        { label: 'then set text', body: fields({ [t]: 'PROBE-1' }) },
      ],
    },
    { name: 'drop-down as [name]', steps: [{ label: `set [${x!.name}]`, body: fields({ [s]: [x!.name] }) }] },
    { name: 'drop-down as "name"', steps: [{ label: `set "${x!.name}"`, body: fields({ [s]: x!.name }) }] },
    { name: 'drop-down as [id]', steps: [{ label: 'set [id]', body: fields({ [s]: [x!.id] }) }] },
    {
      name: 'drop-down: change',
      steps: [
        { label: `set [${x!.name}]`, body: fields({ [s]: [x!.name] }) },
        { label: `set [${y!.name}]`, body: fields({ [s]: [y!.name] }) },
      ],
    },
    {
      name: 'multi-select: replace',
      steps: [
        { label: `set [${A}]`, body: fields({ [m]: [A] }) },
        { label: `set [${B}]`, body: fields({ [m]: [B] }) },
      ],
    },
    {
      name: 'multi-select: grow',
      steps: [
        { label: `set [${A}]`, body: fields({ [m]: [A] }) },
        { label: `set [${A}, ${B}]`, body: fields({ [m]: [A, B] }) },
      ],
    },
    {
      name: 'multi-select: clear with "" then set',
      steps: [
        { label: `set [${A}]`, body: fields({ [m]: [A] }) },
        { label: 'clear ""', body: fields({ [m]: '' }) },
        { label: `set [${B}]`, body: fields({ [m]: [B] }) },
      ],
    },
    {
      name: 'multi-select: comma-separated names',
      steps: [
        { label: `set "${A}"`, body: fields({ [m]: A }) },
        { label: `set "${A},${B}"`, body: fields({ [m]: `${A},${B}` }) },
      ],
    },
    {
      name: 'multi-select: option ids',
      steps: [
        { label: 'set [id A]', body: fields({ [m]: [a!.id] }) },
        { label: 'set [id B]', body: fields({ [m]: [b!.id] }) },
      ],
    },
    {
      name: 'multi-select: set on create, then edit',
      create: fields({ [m]: [A] }),
      steps: [{ label: `set [${B}]`, body: fields({ [m]: [B] }) }],
    },
    {
      name: 'form-encoded: text then date',
      steps: [
        { label: 'set text (form)', body: fields({ [t]: 'PROBE-1' }), encoding: 'form' },
        { label: 'set date (form)', body: fields({ [d]: '2027-03-17' }), encoding: 'form' },
      ],
    },
    {
      name: 'form-encoded: multi-select replace',
      steps: [
        { label: `set [${A}] (form)`, body: fields({ [m]: [A] }), encoding: 'form' },
        { label: `set [${B}] (form)`, body: fields({ [m]: [B] }), encoding: 'form' },
      ],
    },
  ]
}

async function runWrites(fields: Probed): Promise<void> {
  const created: string[] = []
  const summary: string[] = []
  try {
    let n = 0
    for (const experiment of experiments(fields)) {
      n++
      console.log(`\n## ${n}. ${experiment.name}`)
      const made = await rawPost('people/create', {
        firstname: `Zz Probe ${n}`,
        lastname: 'Delete-Me',
        ...experiment.create,
      })
      const id = (made.data['person'] as { id?: string } | undefined)?.id
      if (!id) {
        console.log(`   create failed: ${made.text.slice(0, 160)}`)
        summary.push(`${n}. ${experiment.name}: could not create`)
        continue
      }
      created.push(id)
      console.log(`   created            -> ${await readBack(id, fields)}`)

      const outcomes: string[] = []
      for (const step of experiment.steps) {
        if (!args.includes('--no-spacing')) await new Promise((resolve) => setTimeout(resolve, 1_500))
        const res = await rawPost('people/edit', { id, ...step.body }, step.encoding)
        const error = (res.data['error'] as { message?: string } | undefined)?.message
        const verdict = res.ok ? 'ok  ' : 'FAIL'
        outcomes.push(res.ok ? 'ok' : 'FAIL')
        console.log(`   ${verdict} ${step.label.padEnd(15)} -> ${await readBack(id, fields)}`)
        if (!res.ok) console.log(`        ${error ?? res.text.slice(0, 160)}`)
      }
      summary.push(`${n}. ${experiment.name}: ${outcomes.join(' → ')}`)
    }
  } finally {
    const leftovers: string[] = []
    for (const id of created) {
      const res = await rawPost('people/remove', { id })
      if (!res.ok) leftovers.push(id)
    }
    console.log(`\n## Summary\n${summary.map((line) => `   ${line}`).join('\n')}`)
    console.log(
      leftovers.length === 0
        ? `\nDeleted all ${created.length} throwaway people.`
        : `\nCOULD NOT DELETE ${leftovers.length}: ${leftovers.join(', ')} — remove them by hand.`,
    )
  }
}

async function runNoop(fields: Probed, id: string): Promise<void> {
  console.log(`Before: ${await readBack(id, fields)}`)
  const res = await rawPost('people/getInfo', { id, fields: Object.values(fields).map(key) })
  const person = (res.data['person'] as Record<string, unknown>[] | undefined)?.[0]
  if (!person) throw new Error(`Could not read ${id}: ${res.text.slice(0, 120)}`)

  const select = person[key(fields.select)]
  const selectName = select && typeof select === 'object' ? (select as { name?: string }).name : undefined
  const current: Record<string, unknown> = {
    [key(fields.multi)]: readMulti(person[key(fields.multi)]),
    [key(fields.select)]: selectName ? [selectName] : '',
    [key(fields.date)]: person[key(fields.date)] ?? '',
    [key(fields.text)]: person[key(fields.text)] ?? '',
  }
  for (const [k, v] of Object.entries(current)) {
    // Only fields that hold something: writing "" to an empty field proves little.
    if (v === '' || (Array.isArray(v) && v.length === 0)) {
      console.log(`skip ${k}: empty on this person`)
      continue
    }
    const edit = await rawPost('people/edit', { id, fields: { [k]: v } })
    const error = (edit.data['error'] as { message?: string } | undefined)?.message
    console.log(`${edit.ok ? 'ok  ' : 'FAIL'} same value back to ${k}${edit.ok ? '' : `: ${error ?? edit.text.slice(0, 120)}`}`)
  }
  console.log(`After:  ${await readBack(id, fields)}`)
}

const fields = await pickFields()
if (mode === 'inspect') await inspect(fields)
else if (mode === 'noop') {
  if (!noopPerson) throw new Error('--noop needs a person id.')
  await runNoop(fields, noopPerson)
} else await runWrites(fields)
