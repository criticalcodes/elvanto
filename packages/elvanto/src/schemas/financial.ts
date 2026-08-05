import { z } from 'zod'
import {
  dateString,
  flag,
  id,
  numericOptional,
  optionalReference,
  reference,
  wrapped,
} from '../zod-helpers.js'

/** A chart-of-accounts category a gift can be allocated to. */
export const financialCategorySchema = z.looseObject({
  id: id,
  /** Elvanto's own state: `1` active, `0` archived. */
  status: numericOptional,
  name: z.string().optional(),
})

export type FinancialCategory = z.output<typeof financialCategorySchema>

/** The batch a transaction was entered in. */
export const batchSchema = z.looseObject({
  id: id.optional(),
  /** Quoted on some endpoints and numeric on others; normalized to a number. */
  number: numericOptional,
  name: z.string().optional(),
})

export type Batch = z.output<typeof batchSchema>

/**
 * One line of a transaction: an amount allocated to a single category.
 *
 * A transaction split across funds has several of these.
 */
export const transactionAmountSchema = z.looseObject({
  id: id.optional(),
  category: optionalReference(reference),
  // Optional, not required: Elvanto sends `""` for unset scalars, and a single
  // blank total on one line would otherwise fail the whole page.
  total: numericOptional,
  tax_deductible: flag.optional(),
  memo: z.string().optional(),
  external_notes: z.string().optional(),
})

export type TransactionAmount = z.output<typeof transactionAmountSchema>

/**
 * A financial transaction.
 *
 * Elvanto quotes monetary values inconsistently — `125` from `getAll` and
 * `"360.00"` from `getInfo` for the same field — so totals are normalized to
 * numbers. The `created_by_*` / `updated_by_*` name fields are explicitly `null`
 * for system-created records.
 */
export const transactionSchema = z.looseObject({
  id: id,
  person_id: id.optional(),
  person_first_name: z.string().nullish(),
  person_last_name: z.string().nullish(),
  person_email: z.string().nullish(),
  transaction_date: dateString.optional(),
  transaction_datetime: dateString.optional(),
  transaction_method: z.string().optional(),
  check_number: z.string().nullish(),
  batch: optionalReference(batchSchema),
  transaction_total: numericOptional,
  amounts: wrapped('amount', transactionAmountSchema).optional(),

  created_by_id: z.string().nullish(),
  created_by_first_name: z.string().nullish(),
  created_by_last_name: z.string().nullish(),
  created_at: dateString.nullish(),
  updated_by_id: z.string().nullish(),
  updated_by_first_name: z.string().nullish(),
  updated_by_last_name: z.string().nullish(),
  updated_at: dateString.nullish(),
})

export type Transaction = z.output<typeof transactionSchema>
