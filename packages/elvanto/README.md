# @criticalcodes/elvanto

Typed, read-only TypeScript client for the [Elvanto](https://www.elvanto.com)
church management API.

> Unofficial. Not affiliated with or endorsed by Elvanto.

```console
npm install @criticalcodes/elvanto
```

Requires Node 20+. ESM only.

```ts
import { createClient } from '@criticalcodes/elvanto'

const elvanto = createClient({ auth: { apiKey: process.env.ELVANTO_API_KEY! } })

const people = await elvanto.people.getAll({ page_size: 100, fields: ['birthday'] })
for (const person of people.items) {
  console.log(person.firstname, person.lastname, person.birthday)
}
```

Omit `auth` and it reads `ELVANTO_API_KEY`, then `ELVANTO_ACCESS_TOKEN`, from the
environment. Find your key in Elvanto under **Settings → Account Settings →
Secret API Key**.

## Endpoints

Namespaced to mirror the API. All 25 read-only endpoints:

```ts
elvanto.people.getAll(params?)                  elvanto.songs.getAll(params?)
elvanto.people.search({ search })               elvanto.songs.getInfo({ id })
elvanto.people.getInfo({ id })                  elvanto.songs.categories.getAll()
elvanto.people.currentUser()          // OAuth  elvanto.songs.arrangements.getAll({ song_id })
elvanto.people.categories.getAll()              elvanto.songs.arrangements.getInfo({ id })
elvanto.people.customFields.getAll()            elvanto.songs.keys.getAll({ arrangement_id })
                                                elvanto.songs.keys.getInfo({ id })
elvanto.peopleFlows.getAll()
elvanto.peopleFlows.steps.getAll({ flow_id })   elvanto.calendar.getAll()
elvanto.peopleFlows.steps.people({ step_id })   elvanto.calendar.events.getAll({ start, end })

elvanto.groups.getAll(params?)                  elvanto.financial.transactions.getAll({ start, end })
elvanto.groups.getInfo({ id })                  elvanto.financial.transactions.getInfo({ id })
                                                elvanto.financial.categories.getAll(params?)
elvanto.services.getAll(params?)
elvanto.services.getInfo({ id })
```

Or reach any of them dynamically, still fully typed:

```ts
await elvanto.call('songs.arrangements.getAll', { song_id: id })
```

## Results

List endpoints return a page; single endpoints return the record itself.

```ts
const page = await elvanto.people.getAll()
page.items      // Person[]
page.total      // matching records across all pages
page.page       // 1-based
page.perPage
page.onThisPage
page.hasMore

const person = await elvanto.people.getInfo({ id })
person.firstname   // no array to unwrap
```

## Pagination

```ts
// Stream — one request per page, constant memory.
for await (const person of elvanto.paginate('people.getAll')) {
  console.log(person.id)
}

// Collect. Unbounded by default; cap it.
const everyone = await elvanto.fetchAll('people.getAll', undefined, { maxRecords: 5000 })
```

Both accept `maxPages` and `maxRecords`, and both treat Elvanto's "no records
match your criteria" 404 as an empty result rather than an error — iterating an
unmatched query yields nothing instead of throwing. A direct `getAll()` call
still surfaces that 404 faithfully.

## Normalization

Elvanto's JSON is a mechanical translation of XML. This library reshapes it:
collection wrappers are flattened (`{locations:{location:[…]}}` → `Location[]`),
single-record envelopes are unwrapped, documented 1/0 and "Yes"/"No" booleans
become booleans, and inconsistently quoted numbers become numbers. Unknown fields
are always preserved. See the
[root README](https://github.com/criticalcodes/elvanto#response-normalization) for the
complete rules.

Dates stay as strings — `parseElvantoDate()` converts them, correctly treating
Elvanto's zone-less timestamps as UTC:

```ts
import { parseElvantoDate } from '@criticalcodes/elvanto'
parseElvantoDate('2026-02-24 11:56:22')  // → 2026-02-24T11:56:22.000Z
parseElvantoDate('')                     // → undefined ("never" / not set)
```

## Options

```ts
createClient({
  auth: { apiKey: '…' },       // or { accessToken }, or { getAccessToken }
  validate: 'throw',           // 'throw' (default) | 'warn' | 'off'
  onWarning: (w) => …,         // called when 'warn' swallows a mismatch
  debug: false,                // true | 'verbose'; or ELVANTO_DEBUG
  logger: (event) => …,        // route log events into your own stack
  timeoutMs: 30_000,
  maxRetries: 2,               // rate limits, 5xx and network faults
  minRequestIntervalMs: 0,     // pace requests; see below
  baseUrl: '…',                // or ELVANTO_BASE_URL
  fetch: myFetch,              // injectable, for tests
  userAgent: 'my-app/1.0',
})
```

### Rate limits

Elvanto documents none, so this library reacts to a `429` (honouring `Retry-After`)
rather than predicting one. `minRequestIntervalMs` lets you avoid provoking one:

```ts
createClient({ minRequestIntervalMs: 100 })   // at most ~10 requests/second
```

It's enforced in the transport, so it applies to concurrent callers too — a
`Promise.all` of 100 `getInfo` calls is spaced out rather than arriving at once.
Pagination is already sequential, so this matters most when you fan out yourself.

### Validation

Elvanto publishes no machine-readable spec, so the response schemas here are
derived from its documentation examples and can be wrong. `validate` decides what
happens on a mismatch: `throw` (default, loud — best for tests), `warn` (returns
the data and reports it — best for production), or `off`. Request parameters are
always validated strictly.

```ts
try {
  await elvanto.people.getAll()
} catch (error) {
  if (error instanceof ElvantoResponseValidationError) {
    error.data     // the raw, unvalidated payload — still usable
    error.issues   // [{ path, message }]
  }
}
```

Per-call override: `elvanto.people.getAll(params, { validate: 'off' })`.

### Debug logging

`debug: true` logs requests, statuses, durations, retries and result counts to
stderr. Credentials and returned records are **never** logged; parameter values
only with `debug: 'verbose'`. Pass `logger` to capture events yourself:

```ts
createClient({ logger: (event) => myLogger.debug(event.message, event.data) })
```

## Errors

All extend `ElvantoError`:

| Error | Meaning |
| --- | --- |
| `ElvantoApiError` | Elvanto answered with a failure. `httpStatus`, `code`, `body`, plus `isAuthError` / `isNotFound` / `isRateLimited`. |
| `ElvantoTransportError` | The request never completed — network fault, timeout, abort. |
| `ElvantoRequestValidationError` | Your parameters were invalid; nothing was sent. |
| `ElvantoResponseValidationError` | The response didn't match our schema. Carries `data`. |

`isNotFound` covers both "that ID doesn't exist" and "nothing matched your
filters", because Elvanto uses 404 for both.

> **Errors can carry member data.** `ElvantoApiError.body` and
> `ElvantoResponseValidationError.data` hold the raw response, because a schema
> mismatch can't be diagnosed without it. If you ship errors to a log aggregator
> or crash reporter, send `error.message` rather than the whole object, or strip
> those two fields — `message` alone never contains a field value, since
> mismatches are reported by path. Debug logging never includes response records;
> an error object is the one place they can escape.

## Types

Every resource is exported: `Person`, `Group`, `Service`, `Song`, `Arrangement`,
`SongKey`, `Calendar`, `CalendarEvent`, `Transaction`, `TransactionAmount`,
`PeopleFlow`, `PeopleFlowStep`, `CustomField`, and the nested `Plan`, `PlanItem`,
`VolunteerPosition`, `ScheduledVolunteer` and friends — alongside the zod schemas
they're inferred from, if you want to validate elsewhere.

Optional fields are typed optional because Elvanto only returns them when named
in `fields`. Records carry an index signature, since accounts add custom
`custom_<uuid>` fields.

## Cancellation

```ts
const controller = new AbortController()
setTimeout(() => controller.abort(), 1000)
await elvanto.people.getAll(undefined, { signal: controller.signal })
```

## Escape hatch

For a parameter Elvanto supports but this version doesn't model yet:

```ts
await elvanto.people.getAll({ page: 1 }, { extraParams: { undocumented_filter: 'x' } })
```

These bypass parameter validation and are sent as-is, so a typo reaches Elvanto
rather than being caught locally.

## Scope

Read-only, API key or a supplied OAuth token. Mutating endpoints and the OAuth
authorization-code flow are not implemented yet.

## License

MIT
