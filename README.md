# Elvanto for TypeScript

Three things that share one source of truth, for the [Elvanto](https://www.elvanto.com)
church management API:

| Package | What it is | Install |
| --- | --- | --- |
| [`@criticalcodes/elvanto`](packages/elvanto) | Typed TypeScript/JavaScript client | `npm i @criticalcodes/elvanto` |
| [`@criticalcodes/elvanto-cli`](packages/elvanto-cli) | Command-line interface | `npm install -g @criticalcodes/elvanto-cli` |
| [`@criticalcodes/elvanto-mcp`](packages/elvanto-mcp) | MCP server, for LLM tools | `npx @criticalcodes/elvanto-mcp` |

This version covers **API key authentication** and **read-only endpoints** — all
25 of them. OAuth and mutations are designed for but not implemented; see
[Roadmap](#roadmap).

> Unofficial. Not affiliated with or endorsed by Elvanto.

```ts
import { createClient } from '@criticalcodes/elvanto'

const elvanto = createClient({ auth: { apiKey: process.env.ELVANTO_API_KEY! } })

const people = await elvanto.people.getAll({ page_size: 100, fields: ['birthday'] })
console.log(people.total, people.items[0]?.firstname)
```

```console
$ elvanto services get-all --fields songs --all
$ elvanto people search --search lastname=Smith -o json
```

## One registry, three surfaces

Every endpoint is declared once, in
[`packages/elvanto/src/registry.ts`](packages/elvanto/src/registry.ts): its path,
its zod parameter schema, its response schema, and its documentation link. The
SDK methods, the CLI commands and the MCP tools are all derived from it, so a
parameter cannot exist on one surface and be missing from another.

Names are derived mechanically, so each surface reads idiomatically rather than
leaking Elvanto's camelCase paths:

| Surface | Convention | Example |
| --- | --- | --- |
| TypeScript | camelCase | `client.peopleFlows.steps.getAll()` |
| CLI | kebab-case | `elvanto people-flows steps get-all` |
| MCP | snake_case | `elvanto_people_flows_steps_get_all` |

Adding an endpoint means adding one registry entry and one binding line in
`client.ts`. The CLI and MCP server pick it up with no further work.

## Response normalization

Elvanto's JSON is a mechanical translation of an XML document, which shows. This
library reshapes it on the way out, consistently and predictably:

1. **Singular-key collection wrappers are flattened.**
   `{ locations: { location: [...] } }` becomes `{ locations: [...] }`.
   An empty collection (Elvanto sends `""`) becomes `[]`. An absent one stays
   `undefined` — so you can tell "none" from "not requested".
2. **Single records are unwrapped**, whether Elvanto sent a one-element array
   (`person: [{...}]`, most endpoints) or a bare object (`transaction: {...}`,
   the financial endpoints).
3. **Pagination is lifted** into `{ items, page, perPage, onThisPage, total, hasMore }`.
4. **Documented booleans become booleans.** `1`/`0`, `"Yes"`/`"No"`,
   `"true"`/`"false"` and `""` all normalize. Elvanto's *numeric states* — like
   a service's `status` — are deliberately left alone, because `1` there means
   "published", not "true".
5. **Inconsistently quoted numbers become numbers.** The same field arrives as
   `125` from one endpoint and `"360.00"` from another.
6. **Everything else is verbatim, and unknown fields are always preserved** —
   accounts have custom fields, and Elvanto ships changes ahead of its docs.

Dates stay as Elvanto's strings, because converting them would lose fidelity.
Use `parseElvantoDate()`, which knows that Elvanto's `"2026-02-24 11:56:22"` is
UTC despite carrying no zone marker (`new Date()` would read it as local time).

## Response validation

Elvanto publishes no OpenAPI or JSON Schema. Every response schema here is
derived from the examples in its documentation, which means the schemas can be
wrong in two directions: fields that exist but aren't documented, and documented
fields that behave differently in practice.

So validation is configurable, and **strict by default**:

| Mode | Behaviour | Use it when |
| --- | --- | --- |
| `throw` (default) | Raises `ElvantoResponseValidationError` on a mismatch. The raw payload is on `error.data`. | Tests and CI — you want drift to be loud. |
| `warn` | Returns the data anyway and reports through `onWarning`. | Production, where a new Elvanto field must not break a working call. |
| `off` | Skips response validation. Structural normalization still applies. | Maximum throughput, or when you've decided to trust it. |

```ts
createClient({ validate: 'warn', onWarning: (w) => log.warn(w.message) })
```

Every surface exposes the opt-out: `--validate warn` on the CLI,
`ELVANTO_VALIDATE=warn` for the MCP server and the SDK.

Request parameters are always validated strictly, regardless of this setting —
those are well documented, so a bad parameter is your bug, not Elvanto's.

Two things worth knowing:

- **Under `warn`, records that validate keep their normalization** and only the
  offending record comes back raw. One unexpected field on one person doesn't cost
  the rest of the page its booleans.
- **Under `warn` and `off`, the static types are a claim rather than a
  guarantee** — a result typed `Person[]` may contain an unvalidated item. That's
  the trade those modes exist to make; run `throw` in tests so the claim is
  checked somewhere.

Errors can carry member data by design: `ElvantoApiError.body` and
`ElvantoResponseValidationError.data` hold the raw response, because a mismatch
can't be diagnosed without it. Log `error.message`, not the whole object.

## Debug logging

Off by default. `debug: true` (or `ELVANTO_DEBUG=1`) logs requests, HTTP status,
durations, retries and result counts to **stderr** — never stdout, so it can't
corrupt piped CLI output or the MCP stdio channel.

```console
$ elvanto people get-all --debug
[elvanto] request people/getAll — POST url=… bytes=16 params=page_size
[elvanto] response people/getAll — HTTP 200 durationMs=142 attempt=1 generatedIn=0.021
[elvanto] result people.getAll — page returned=25 total=668 page=1 hasMore=true
```

Because this library handles member records and giving data, the log stream is
treated as somewhere that data must not reach:

- **Credentials are never logged**, at any level, in any encoding.
- **Returned records are never logged** — only counts, statuses and timings. When
  you need a payload to diagnose a mismatch, use `validate: 'warn'` and read it
  from the warning.
- **Parameter values are only logged with `debug: 'verbose'`**; names alone are
  logged otherwise. Even in verbose, `search` values are redacted to a count,
  since those are the terms themselves.

Pass `logger` to route events into your own logging stack instead of stderr.

## Verifying against a real account

Because the schemas come from documentation examples, the honest way to check
them is to call the API. The smoke test sweeps every read-only endpoint, chains
IDs from one call into the next, and reports what it finds:

Pass the key per invocation. Nothing here reads a `.env`, deliberately: an
Elvanto API key grants read access to every member record and every giving
record in the account, and this script is run occasionally — not often enough to
justify leaving that on disk in plaintext. Pulling it from a secret manager keeps
it out of both the filesystem and your shell history:

```console
$ ELVANTO_API_KEY=$(op read "op://Private/Elvanto/api key") pnpm smoke
$ ELVANTO_API_KEY=$(security find-generic-password -s elvanto -w) pnpm smoke

$ ELVANTO_API_KEY=your-key pnpm smoke    # fine too; lands in shell history
  ok    people.getAll  (+1 undocumented)
  ok    people.search
  skip  people.currentUser
  …
24 ok, 1 skipped, 0 API errors, 0 failed

Fields Elvanto returned that our schemas do not declare:
  people.getAll: brand_new_field_from_elvanto
```

It reports **fields Elvanto returned that we don't declare** (the docs were
incomplete) and **fields we declare that never appeared** (we may be wrong).
Values are redacted by default — this reads real member data. Add
`--include-data` for samples, `--financial` to include giving records (excluded
by default), and `--json report.json` for the full report.

### What has actually been verified

Every endpoint's parameters and response shape is checked against Elvanto's
published example — that's the floor. A live sweep has additionally confirmed 14
of the 25 against real data, and each endpoint records which in its registry entry
(`verified: 'docs' | 'live'`). `elvanto endpoints` marks the difference, and the
MCP tool descriptions carry a caveat for the `docs`-only ones.

The distinction is worth keeping because a live sweep has already contradicted the
documentation twice: `school_grade` is an object rather than the name it's
documented as, and `family` is not the person collection its name implies. So a
`docs`-only endpoint is *probably* right, but nothing has tested it.

Still `docs`-only, and why:

| Endpoints | Why |
| --- | --- |
| `songs.*` (5) | No songs in the account swept, so nothing downstream was reachable |
| `financial.*` (3) | No chart of accounts and no transactions. Also where the published examples disagree with each other most |
| `peopleFlows.steps.people` | The endpoint answered, but no step had members to shape-check |
| `people.currentUser` | Requires OAuth, which isn't implemented yet |

Within services, the envelope, `service_times` and the whole `volunteers` tree
were exercised for real; `plans`, `songs`, `files` and `notes` came back empty
everywhere, so those four remain documentation-only.

## Development

```console
pnpm install
pnpm build          # all three packages
pnpm typecheck      # includes compile-time type assertions
pnpm test           # 258 tests, no network
pnpm test:coverage
pnpm smoke          # live sweep, needs a real API key
```

Tests never touch the network: the SDK takes an injected `fetch`, and the CLI and
MCP tests run against a local stub server and an in-memory MCP transport
respectively, so they exercise real sockets and the real protocol.

Both `pnpm test` and `pnpm typecheck` resolve `@criticalcodes/elvanto` to the
SDK's **source**, not its build output — via an alias in `vitest.config.ts` and
`paths` in the two consuming tsconfigs. Without that, a change to the SDK stays
invisible to two thirds of the suite until someone runs `pnpm build`, and the
tests pass against the previous build.

## Using this from an agent

Two routes, and the choice matters more than it looks.

**The MCP server**, for a general-purpose agent that should be able to reach
anything. `@criticalcodes/elvanto-mcp` works today with any MCP-capable host — 25
read-only tools, schemas generated from the registry, a 25-record page default and
a response cap so a large account can't flood a context window.

**The SDK directly**, for an agent with a specific job. Everything needed to
generate tools is public, so a framework can enumerate the registry rather than
hand-writing wrappers:

```ts
import { endpointIds, getEndpoint, paramsJsonSchema, createClient } from '@criticalcodes/elvanto'

const client = createClient({ validate: 'warn' })
const tools = endpointIds.map((id) => {
  const endpoint = getEndpoint(id)
  return {
    name: id,
    description: endpoint.summary,
    // JSON Schema, or reach `endpoint.params` for the zod schema directly.
    inputSchema: paramsJsonSchema(endpoint),
    run: (args) => client.call(id, args),
  }
})
```

Three things worth deciding up front:

- **Exposing fewer tools beats exposing all 25.** An agent that only needs rosters
  does not need the giving endpoints, and the narrowest surface is the easiest to
  reason about.
- **`validate: 'warn'` is usually right for an agent**, so an undocumented Elvanto
  field degrades the response instead of failing the session. Keep `throw` in tests.
- **Cap what reaches the context.** The MCP server does this for you; direct SDK
  use does not — `fetchAll` on a large account will happily return 50,000 records.
  Use `paginate` with `maxRecords`, or a small `page_size`.

## Roadmap

Deliberately not in this version:

- **OAuth 2.** The transport already supports bearer tokens and a
  `getAccessToken` hook for refresh, so the remaining work is the authorization
  code flow and token storage. `people.currentUser` is registered and will start
  working the moment a token is supplied.
- **Mutations.** `create`, `edit`, `remove`, `addPerson` and the rest. The
  registry has no `method` field yet because every endpoint here is a POST that
  reads; adding writes should also add an explicit opt-in, so an MCP server
  cannot be handed the ability to delete a person by accident.

## Notes on the API itself

Things worth knowing, all of which this library handles for you:

- Every endpoint is a `POST`, including the reads.
- API keys authenticate as HTTP Basic with the key as the username and an ignored
  password.
- Failures sometimes arrive as HTTP 200 with `{"status":"fail"}` in the body, and
  the meaningful code is in `error.code` rather than the status line.
- A 404 means both "that ID doesn't exist" and "nothing matched your filters".
  `client.paginate()` treats the latter as an empty result rather than an error.
- `page_size` must be between 10 and 1000. Elvanto's default is 1000; the MCP
  server defaults to 25 instead, so a large account can't flood a model's context.
- Optional fields are only returned when named in a request's `fields` parameter.
  Use `people.customFields.getAll()` to discover the `custom_<uuid>` keys your
  account accepts.

## License

MIT
