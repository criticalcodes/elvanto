/**
 * Compile-time assertions. This file is deliberately named `.test-d.ts` so the
 * runtime suite skips it — `pnpm typecheck` is what enforces it, and a failure
 * shows up as a tsc error rather than a test failure.
 */
import { expectTypeOf } from 'vitest'
import type { ElvantoClient, ResultOf } from '../src/client.js'
import type { Page } from '../src/normalize.js'
import type { Person } from '../src/schemas/people.js'
import type { Transaction } from '../src/schemas/financial.js'
import type { Reference } from '../src/zod-helpers.js'

declare const client: ElvantoClient

/**
 * These assertions exist because the registry-driven types are inferred through
 * several layers of conditional types — a regression there would silently widen
 * every result to `unknown` without breaking a single runtime test.
 */
export function list_endpoints_resolve_to_a_page_of_typed_records() {
  expectTypeOf(client.people.getAll).returns.resolves.toEqualTypeOf<Page<Person>>()
  expectTypeOf(client.financial.transactions.getAll).returns.resolves.toEqualTypeOf<
    Page<Transaction>
  >()
  expectTypeOf<ResultOf<'services.getAll'>>().toHaveProperty('items')
}

export function single_record_endpoints_resolve_to_an_unwrapped_record() {
  expectTypeOf(client.people.getInfo).returns.resolves.toEqualTypeOf<Person>()
  expectTypeOf(client.financial.transactions.getInfo).returns.resolves.toEqualTypeOf<Transaction>()
}

export function normalization_is_reflected_in_the_types() {
  // Flags become booleans, not 0 | 1.
  expectTypeOf<Person['admin']>().toEqualTypeOf<boolean | undefined>()
  // Wrapped collections become plain arrays.
  expectTypeOf<Person['locations']>().toEqualTypeOf<Reference[] | undefined>()
  // Inconsistently quoted numbers become numbers.
  expectTypeOf<Transaction['transaction_total']>().toEqualTypeOf<number | undefined>()
  // Unknown fields stay reachable, since Elvanto returns account-specific keys.
  expectTypeOf<Person>().toHaveProperty('id')
  expectTypeOf<Person['id']>().toEqualTypeOf<string>()
}

export function nested_service_structures_stay_typed_all_the_way_down() {
  type Service = Awaited<ReturnType<typeof client.services.getInfo>>
  expectTypeOf<
    NonNullable<Service['volunteers']>[number]['positions']
  >().not.toBeUnknown()
  expectTypeOf<NonNullable<Service['songs']>[number]['title']>().toEqualTypeOf<
    string | undefined
  >()
}

export function paginate_yields_records_and_rejects_non_paginated_endpoints() {
  expectTypeOf(client.paginate('people.getAll')).toEqualTypeOf<
    AsyncGenerator<Person, void, undefined>
  >()
  expectTypeOf(client.fetchAll('people.getAll')).resolves.toEqualTypeOf<Person[]>()
  // @ts-expect-error people.getInfo returns a single record, not a page.
  client.paginate('people.getInfo')
}

export function required_parameters_are_enforced() {
  // @ts-expect-error `id` is required.
  client.people.getInfo({})
  // @ts-expect-error `search` is required.
  client.people.search({})
  // @ts-expect-error start and end are required.
  client.calendar.events.getAll({})
  // @ts-expect-error unknown endpoint id.
  client.call('people.destroyEverything')
}
