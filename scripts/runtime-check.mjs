/**
 * Checks that the *published* package runs on the oldest Node version it claims
 * to support.
 *
 * This exists because the development toolchain and the shipped artifact have
 * different floors: pnpm 11 needs Node 22, so the main CI job cannot run on Node
 * 20 at all. That says nothing about whether the library works there — and
 * narrowing `engines` to match a dev-tool constraint would be a false claim. So
 * this installs the built tarball with plain npm and exercises it directly.
 *
 * Deliberately dependency-free and plain JavaScript: it has to run under whatever
 * Node it is pointed at, without tsx, vitest or a build step.
 *
 * Usage: node scripts/runtime-check.mjs   (from a directory where the package is installed)
 */
import assert from 'node:assert/strict'

const { createClient, parseElvantoDate, endpointIds } = await import(
  '@criticalcodes/elvanto'
)

/** A response exercising the awkward parts: XML-shaped JSON, 1/0, quoted numbers. */
const body = {
  status: 'ok',
  people: {
    page: 1,
    per_page: 2,
    on_this_page: 2,
    total: 5,
    person: [
      {
        id: 'p1',
        firstname: 'Ada',
        volunteer: 1,
        admin: 0,
        family_id: 10,
        locations: { location: [{ id: 'l1', name: 'Central' }] },
      },
      // A single member as a bare object, and an empty collection as "".
      { id: 'p2', firstname: 'Bo', volunteer: 0, locations: '' },
    ],
  },
}

const client = createClient({
  auth: { apiKey: 'runtime-check' },
  maxRetries: 0,
  fetch: async () =>
    new Response(JSON.stringify(body), {
      headers: { 'content-type': 'application/json' },
    }),
})

const page = await client.people.getAll({ page_size: 10 })

// Pagination lifted.
assert.equal(page.total, 5)
assert.equal(page.items.length, 2)
assert.equal(page.hasMore, true)

// Booleans normalized from 1/0.
assert.equal(page.items[0].volunteer, true)
assert.equal(page.items[0].admin, false)

// Collections flattened, in both the populated and the "" form.
assert.deepEqual(page.items[0].locations, [{ id: 'l1', name: 'Central' }])
assert.deepEqual(page.items[1].locations, [])

// Integer id coerced to a string.
assert.equal(page.items[0].family_id, '10')

// Zone-less timestamps read as UTC.
assert.equal(
  parseElvantoDate('2026-02-24 11:56:22').toISOString(),
  '2026-02-24T11:56:22.000Z',
)
// A date that does not exist is rejected rather than rolled over.
assert.equal(parseElvantoDate('2026-02-31'), undefined)

// Errors still map, and the registry is intact.
await assert.rejects(
  () =>
    createClient({
      auth: { apiKey: 'k' },
      maxRetries: 0,
      fetch: async () =>
        new Response(JSON.stringify({ status: 'fail', error: { code: 401, message: 'nope' } }), {
          status: 401,
          headers: { 'content-type': 'application/json' },
        }),
    }).people.getAll(),
  (error) => error.isAuthError === true,
)

assert.equal(endpointIds.length, 25)

console.log(`runtime check passed on Node ${process.version}`)
