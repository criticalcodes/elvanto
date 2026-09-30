# Elvanto for TypeScript

[![CI](https://github.com/criticalcodes/elvanto/actions/workflows/ci.yml/badge.svg)](https://github.com/criticalcodes/elvanto/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Four things that share one source of truth, for the [Elvanto](https://www.elvanto.com)
church management API:

| Package | What it is | Install |
| --- | --- | --- |
| [`@criticalcodes/elvanto`](packages/elvanto) | Typed TypeScript/JavaScript client | `npm i @criticalcodes/elvanto` |
| [`@criticalcodes/elvanto-cli`](packages/elvanto-cli) | Command-line interface | `npm install -g @criticalcodes/elvanto-cli` |
| [`@criticalcodes/elvanto-mcp`](packages/elvanto-mcp) | MCP server, for LLM tools | `npx @criticalcodes/elvanto-mcp` |
| [`@criticalcodes/elvanto-agent`](packages/elvanto-agent) | Agent toolkit for [Flue](https://flueframework.com) | `npm i @criticalcodes/elvanto-agent` |

This version covers **API key and OAuth 2 authentication**, **every read
endpoint** — all 25 — and **writes for people, groups and People Flow steps**.
Writes are off by default on the model-facing surfaces; see
[Writes](packages/elvanto-mcp/README.md#writes).

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

## One registry, every surface

Every endpoint is declared once, in
[`packages/elvanto/src/registry.ts`](packages/elvanto/src/registry.ts): its path,
its zod parameter schema, its response schema, and its documentation link. The
SDK methods, the CLI commands and the MCP tools are all derived from it, so a
parameter cannot exist on one surface and be missing from another. The agent
toolkit generates its tools from the same registry too — same names, same
descriptions, same page and response caps — so a renamed endpoint is a compile
error rather than a runtime surprise.

Names are derived mechanically, so each surface reads idiomatically rather than
leaking Elvanto's camelCase paths:

| Surface | Convention | Example |
| --- | --- | --- |
| TypeScript | camelCase | `client.peopleFlows.steps.getAll()` |
| CLI | kebab-case | `elvanto people-flows steps get-all` |
| MCP | snake_case | `elvanto_people_flows_steps_get_all` |

Adding an endpoint means adding one registry entry and one binding line in
`client.ts`. The CLI, the MCP server and the agent's endpoint tools pick it up with
no further work.

## Authentication

Two ways in, and which one you want depends on whether "who is asking" matters.

**An API key** identifies the *account*. One secret, no expiry, read access to
every member record and every giving record. Right for a script, a cron job, or a
server-side integration where there is no user to speak of.

```console
$ ELVANTO_API_KEY=$(op read "op://Private/Elvanto/api key") elvanto people get-all
```

**OAuth 2** identifies a *person*. Each caller signs in themselves, the library
acts with their permissions, and `people.currentUser` starts working. Right for
anything with more than one human in front of it — and required if you are
deploying the agent, because otherwise every visitor shares one all-seeing key.

```console
$ elvanto login          # opens a browser, stores the grant
$ elvanto whoami
Using: stored grant (profile "default")
Signed in as: Ada Lovelace
```

Once a grant is stored, the CLI and the MCP server use it and refresh it on their
own; no secrets need to stay in the environment.

> **Not yet exercised against a live Elvanto account.** The OAuth flow, token
> refresh and the agent's sign-in routes are covered by tests against Elvanto's
> documented behaviour only. Treat it as unverified until someone has signed in
> for real; the API key path is the one that has been used live.

### Registering an OAuth application

There is no shared client id here, and there cannot be: **Elvanto's flow has no
PKCE**, so exchanging an authorization code requires the client secret. A public
client would mean publishing that secret. So each deployment registers its own
application under **Settings > Integrations** in Elvanto, and configures:

| Variable | Needed by | When |
| --- | --- | --- |
| `ELVANTO_CLIENT_ID` | CLI, agent | Signing in |
| `ELVANTO_CLIENT_SECRET` | CLI, agent | Signing in |
| `ELVANTO_SESSION_SECRET` | agent | Always — signs the OAuth `state` |

Register the redirect URI to match the surface:

| Surface | Redirect URI |
| --- | --- |
| `elvanto login` | `http://127.0.0.1:8975/callback` (`--port` to change) |
| Deployed agent | `https://<your-origin>/auth/callback` |
| Agent under `vite dev` | `http://localhost:5173/auth/callback` |

The client secret is only needed for `login` itself. Elvanto's refresh request
carries just the grant type and the refresh token, so day-to-day commands need
nothing in the environment at all.

### Scopes are write-shaped

Worth being plain about, because it cuts against the intuition that OAuth is the
safer option in every respect. Elvanto's entire scope list is `ManagePeople`,
`ManageGroups`, `ManageServices`, `ManageSongs`, `ManageCalendar`,
`ManageFinancials` and `AdministerAccount`. **There is no read-only scope.**

This library only ever issues reads — there are no write endpoints in it — but a
token it holds is capable of more than it does with it. The default requests the
first five, omitting financials and account administration, which matches the
agent toolkit's endpoint allowlist. Narrow it further with `--scope` if your use
does not need all five.

### Where credentials live

| | Stored | Why there |
| --- | --- | --- |
| CLI, MCP server | `~/.config/elvanto/credentials.json`, mode 0600 in a 0700 directory | A refresh token is needed on every command, so prompting each time would mean a browser round trip to list a roster |
| Deployed agent | Server-side session store, keyed by an opaque httpOnly cookie | Never in the cookie, and never in Flue's durable record log — its own reference says that log "is still not a secrets channel" |

`ELVANTO_CREDENTIALS` overrides the path and `ELVANTO_PROFILE` picks between
grants, for anyone working across two churches.

Note that this is the one place the repository writes a credential to disk, which
is a different trade from the API key the smoke test deliberately refuses to
store: an API key is account-wide and permanent until rotated by hand, while a
refresh token belongs to one person and can be revoked from Elvanto's own
settings. `elvanto logout` forgets the local grant; revoking it entirely is done
under Settings > Integrations.

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
| `people.currentUser` | Needs OAuth, which is itself untested live, and the sweep authenticates with an API key, which by design cannot call it |

Within services, the envelope, `service_times` and the whole `volunteers` tree
were exercised for real; `plans`, `songs`, `files` and `notes` came back empty
everywhere, so those four remain documentation-only.

## Development

```console
pnpm install
pnpm build          # all four packages
pnpm typecheck      # includes compile-time type assertions
pnpm test           # 507 tests, no network
pnpm test:coverage
pnpm smoke          # live sweep, needs a real API key
```

The agent package additionally builds a deployable server, which is a separate
step from the publishable toolkit and writes to `dist-app/` rather than `dist/`:

```console
pnpm --filter @criticalcodes/elvanto-agent build:app             # Cloudflare Worker
FLUE_TARGET=node pnpm --filter @criticalcodes/elvanto-agent build:app   # Node server
```

Developing here needs **Node 22.13+**, because pnpm 11 does. The published packages
support **Node 20+**, which is a separate claim and tested separately: CI packs the
SDK and runs `scripts/runtime-check.mjs` against the tarball on Node 20, 22 and 24,
installed with plain npm. Narrowing `engines` to match the toolchain would have been
easier and false.

`pnpm check:secrets` fails on credential-shaped strings and on sweep output in
tracked files, and runs first in CI. It also works as a pre-commit hook:

```console
echo 'node scripts/check-no-secrets.mjs --staged' > .git/hooks/pre-commit
chmod +x .git/hooks/pre-commit
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the conventions that aren't obvious from
the code, and [SECURITY.md](SECURITY.md) for what's worth reporting.

Tests never touch the network: the SDK takes an injected `fetch`, and the CLI and
MCP tests run against a local stub server and an in-memory MCP transport
respectively, so they exercise real sockets and the real protocol.

Both `pnpm test` and `pnpm typecheck` resolve `@criticalcodes/elvanto` to the
SDK's **source**, not its build output — via aliases in `vitest.config.ts` and
`paths` in the consuming tsconfigs. Without that, a change to the SDK stays
invisible to most of the suite until someone runs `pnpm build`, and the
tests pass against the previous build. `@criticalcodes/elvanto-mcp` is aliased the
same way, since the agent package imports it.

`packages/elvanto-agent/tsconfig.json` is the one package config that does **not**
extend `tsconfig.base.json`: Flue's agent and app modules import each other with
explicit `.ts` extensions, which needs bundler resolution. The base's strictness
flags are repeated there rather than dropped.

## Using this from an agent

Three routes now, in increasing order of how much is done for you.

**The agent toolkit**, if you use [Flue](https://flueframework.com).
`@criticalcodes/elvanto-agent` ships six tools that each answer a whole question —
`find_person`, `roster`, `next_serving`, `service_brief`, `song_history`,
`list_custom_fields` — plus all 25 raw endpoints as native tools, a
`useElvantoBase()` hook that mounts them, and a one-binary runner that gives you a
terminal chat, an HTTP server and a web chat UI from the same executable. Each
purpose-built tool collapses a multi-call workflow into one small result, which
matters because the raw endpoints are faithful to Elvanto and Elvanto's shapes are
large.

**The MCP server**, for a host that is somebody else's — Claude Desktop, a remote
connector, another framework. (Not needed to give *your own* Flue agent the raw
endpoints; the toolkit mounts those in-process.) `@criticalcodes/elvanto-mcp` works today with any MCP-capable host — 25
read-only tools, schemas generated from the registry, a 25-record page default and
a response cap so a large account can't flood a context window. It speaks stdio for
desktop clients and streamable HTTP for hosts that only take a URL, which includes
most agent frameworks.

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

Four things worth deciding up front. The agent toolkit has made each of these
decisions already, so they double as a description of what it does:

- **Exposing fewer tools beats exposing all 25.** An agent that only needs rosters
  does not need the giving endpoints, and the narrowest surface is the easiest to
  reason about. The toolkit's default allowlist omits every financial endpoint.
- **`validate: 'warn'` is usually right for an agent**, so an undocumented Elvanto
  field degrades the response instead of failing the session. Keep `throw` in tests.
- **Cap what reaches the context.** The MCP server does this for you; direct SDK
  use does not — `fetchAll` on a large account will happily return 50,000 records.
  Use `paginate` with `maxRecords`, or a small `page_size`. Say when you truncate:
  a silently shortened list reads as a complete answer, and a model will present it
  as one.
- **Build the client lazily.** A framework that constructs it while composing the
  agent turns a missing API key into an internal error before the agent exists,
  instead of a message the model can relay.

### If you are building on this for your own church

The toolkit is deliberately generic — it takes configuration and has no policy of
its own. Anything specific to an account (which custom fields carry your
safe-ministry credentials, renewal windows, notice wording, who gets chased) belongs
in a repository you control, not in a public package. `useElvantoBase()` is a
composition hook, so your agent mounts the shared tools and then its own:

```ts
useElvantoBase()
for (const tool of myCredentialTools(profile)) useTool(tool)
```

### Deploying the agent

Until now the honest advice was "don't" — the HTTP surface had no access control,
and behind it is every member record the API key can see. With OAuth configured,
each visitor signs in as themselves instead:

```ts
// src/app.ts
const auth = authOptionsFromEnv({ store: () => sessionStore() })
export default elvantoRoutes({ agent: Church, title: 'Church office', ...(auth ? { auth } : {}) })
```

`authOptionsFromEnv` returns `undefined` when no OAuth application is configured,
so the same route map runs signed-in in production and unauthenticated on a
laptop — with the existing loud warning in the second case. What it mounts:

- `/auth/login`, `/auth/callback`, `/auth/logout` and `/auth/session`.
- A guard over the agent mount doing both checks Flue's routing guide insists on:
  authentication, and the **ownership check** — conversation ids are derived from
  the signed-in person, so nobody reads anyone else's history by editing a URL.
- A sign-in page at `/` instead of the chat, for a visitor with no session.

Sessions and grants live in a Durable Object on Cloudflare
(`createSessionStoreClass()`, exported from `src/cloudflare.ts` with a binding and
migration in `wrangler.jsonc`) and in a process-local store on Node. A Durable
Object rather than KV deliberately: it is a token store, and KV's eventual
consistency would let two concurrent refreshes both win, leaving the loser's
refresh token spent and the session dead at an arbitrary boundary.

Three things worth knowing before deploying:

- **Only the person's id is durable.** The agent reads it from `initialData` and
  looks the grant up server-side. Tokens never enter Flue's record log.
- **A scheduled run has no signed-in user.** Cron-triggered work cannot use anyone's
  grant, so it either keeps an account-wide API key or does not run.
- **`/mcp` is not covered by any of this.** MCP hosts carry a bearer token, not a
  browser cookie, so that route still speaks to Elvanto with the environment's key.

## Roadmap

Deliberately not in this version:

- **Song, calendar and financial writes.** Songs and calendar events are next.
  Financial writes (transactions, chart of accounts) are deliberately left out.
- **Writes from the agent toolkit.** It stays read-only: its endpoint presets
  and selections are typed to read endpoints, so a write cannot be mounted by
  accident.
- **Anything outbound from the agent.** The toolkit reads and reports; it sends no
  email or SMS. Notifying people is a mutation of the world rather than of Elvanto,
  and it should be an explicit, separately-authorised step rather than something a
  model can decide to do.
- **`song_history` against real data.** It reads the `songs` sub-structure of a
  service, which came back empty on every service in the live sweep — so its shape
  still rests on Elvanto's documentation. An empty result may mean the shape is
  wrong rather than that nothing was sung; the tool says so rather than asserting.

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
