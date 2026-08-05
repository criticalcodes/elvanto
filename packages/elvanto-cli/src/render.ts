import type { Page } from '@criticalcodes/elvanto'

export type OutputFormat = 'table' | 'json' | 'ndjson'

/**
 * Columns worth showing first when a record has more scalar fields than fit.
 * Ordered by how much they help identify a row.
 */
const PREFERRED_COLUMNS = [
  'id',
  'name',
  'title',
  'firstname',
  'preferred_name',
  'lastname',
  'email',
  'date',
  'start_date',
  'transaction_date',
  'status',
  'type',
  'artist',
  'transaction_total',
  'total',
  'mobile',
  'phone',
  'date_modified',
]

export interface RenderOptions {
  format: OutputFormat
  /** Terminal width to wrap to. */
  width: number
  /** Cap on table columns, so a wide record stays readable. */
  maxColumns: number
}

/** True when the result is a page rather than a single record. */
export function isPage(value: unknown): value is Page<Record<string, unknown>> {
  return (
    typeof value === 'object' &&
    value !== null &&
    Array.isArray((value as { items?: unknown }).items) &&
    typeof (value as { total?: unknown }).total === 'number'
  )
}

/** Renders a result for stdout. Returns the text without a trailing newline. */
export function render(result: unknown, options: RenderOptions): string {
  if (options.format === 'json') {
    return JSON.stringify(result, null, 2)
  }

  if (options.format === 'ndjson') {
    const records = isPage(result) ? result.items : [result]
    return records.map((record) => JSON.stringify(record)).join('\n')
  }

  if (isPage(result)) return renderTable(result, options)
  return renderRecord(result as Record<string, unknown>, options)
}

function renderTable(
  page: Page<Record<string, unknown>>,
  options: RenderOptions,
): string {
  if (page.items.length === 0) return 'No records matched.'

  const columns = chooseColumns(page.items, options.maxColumns, options.width)
  if (columns.length === 0) {
    return `${page.items.length} record${page.items.length === 1 ? '' : 's'}, with no simple fields to tabulate. Use --output json.`
  }

  const rows = page.items.map((item) =>
    columns.map((column) => formatCell(item[column])),
  )
  const table = layout([columns, ...rows], options.width)

  const shown = page.items.length
  const footer =
    shown === page.total
      ? `\n${page.total} record${page.total === 1 ? '' : 's'}.`
      : `\n${shown} of ${page.total} records (page ${page.page}${
          page.hasMore ? ', more available — use --all' : ''
        }).`

  const hidden = countHiddenColumns(page.items, columns)
  const note = hidden > 0 ? ` ${hidden} more field${hidden === 1 ? '' : 's'} per record — use --output json.` : ''

  return table + footer + note
}

function renderRecord(
  record: Record<string, unknown>,
  options: RenderOptions,
): string {
  const entries = Object.entries(record)
  const width = Math.max(...entries.map(([key]) => key.length))
  // Never let the value column collapse: Elvanto's custom-field keys are 43
  // characters, so on a narrow terminal the remaining width can go negative and
  // erase every value.
  const valueWidth = Math.max(options.width - width - 2, MIN_VALUE_WIDTH)
  return entries
    .map(([key, value]) => `${key.padEnd(width)}  ${formatCell(value, valueWidth)}`)
    .join('\n')
}

/** Enough room for a short value plus an ellipsis. */
const MIN_VALUE_WIDTH = 12

/**
 * Picks table columns: the preferred identifying fields that this record set
 * actually has, then any remaining scalar fields, capped at `maxColumns`.
 */
function chooseColumns(
  items: Array<Record<string, unknown>>,
  maxColumns: number,
  width: number,
): string[] {
  const scalars = new Set<string>()
  for (const item of items) {
    for (const [key, value] of Object.entries(item)) {
      if (isScalar(value)) scalars.add(key)
    }
  }

  const chosen = PREFERRED_COLUMNS.filter((column) => scalars.has(column))
  for (const column of scalars) {
    if (chosen.length >= maxColumns) break
    if (!chosen.includes(column)) chosen.push(column)
  }

  // Shrinking columns alone cannot fit an arbitrary number of them into a narrow
  // terminal — below a readable minimum the table has to lose columns instead,
  // or it overflows and wraps into unreadable noise. Columns are ordered
  // most-identifying first, so dropping from the end keeps the useful ones.
  const affordable = Math.max(1, Math.floor((width + COLUMN_GAP) / (MIN_COLUMN_WIDTH + COLUMN_GAP)))
  return chosen.slice(0, Math.min(maxColumns, affordable))
}

const COLUMN_GAP = 2
const MIN_COLUMN_WIDTH = 6

function countHiddenColumns(
  items: Array<Record<string, unknown>>,
  shown: string[],
): number {
  const all = new Set<string>()
  for (const item of items) for (const key of Object.keys(item)) all.add(key)
  return Math.max(all.size - shown.length, 0)
}

function isScalar(value: unknown): boolean {
  return (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  )
}

function formatCell(value: unknown, limit = 40): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'boolean') return value ? 'yes' : 'no'
  if (Array.isArray(value)) return `[${value.length}]`
  if (typeof value === 'object') return '{…}'

  // Elvanto returns HTML in descriptions and notes; collapse it for a table.
  const text = String(value).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text
}

/** Lays out rows as aligned columns, shrinking to fit the terminal. */
function layout(rows: string[][], width: number): string {
  const columnCount = rows[0]?.length ?? 0
  const widths: number[] = []
  for (let i = 0; i < columnCount; i++) {
    widths.push(Math.max(...rows.map((row) => (row[i] ?? '').length)))
  }

  // Trim the widest columns until the whole table fits. `chooseColumns` has
  // already limited the count to what MIN_COLUMN_WIDTH allows, so this loop can
  // always reach the target.
  const gap = COLUMN_GAP
  let total = widths.reduce((sum, w) => sum + w + gap, -gap)
  while (total > width && Math.max(...widths) > MIN_COLUMN_WIDTH) {
    const widest = widths.indexOf(Math.max(...widths))
    widths[widest] = widths[widest]! - 1
    total--
  }

  return rows
    .map((row, rowIndex) =>
      row
        .map((cell, i) => {
          const columnWidth = widths[i]!
          const text =
            cell.length > columnWidth ? `${cell.slice(0, columnWidth - 1)}…` : cell
          return rowIndex === 0
            ? text.toUpperCase().padEnd(columnWidth)
            : text.padEnd(columnWidth)
        })
        .join(' '.repeat(gap))
        .trimEnd(),
    )
    .join('\n')
}
