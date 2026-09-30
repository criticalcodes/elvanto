# @criticalcodes/elvanto-agent

A [Flue](https://flueframework.com) agent toolkit for the
[Elvanto](https://www.elvanto.com) church management API. Six tools that each
answer a whole question, all 25 raw endpoints in-process, and one binary that runs
the agent as a CLI, an HTTP server or a Worker.

Read-only: nothing here can modify your Elvanto data.

> Unofficial. Not affiliated with or endorsed by Elvanto.

```ts
// src/agents/church.ts — in your project, not this package
'use agent'
import { useModel } from '@flue/runtime'
import { useElvantoBase } from '@criticalcodes/elvanto-agent'

export function Church() {
  useModel('anthropic/claude-sonnet-5')
  useElvantoBase()
  return 'You help our office team with rosters and member admin.'
}
```

```console
$ church "Who is on the roster this Sunday?"   # see the one-binary section
$ flue run src/agents/church.ts --message "Who is on the roster this Sunday?"
```

## It ships a toolkit, not an agent

Flue discovers agents by scanning **your project's** source root for `'use agent'`
modules — never `node_modules`. An agent function imported from a package is never
registered, so no package can ship one that works. What a package *can* ship is
everything an agent is composed of, which is what this is:

| Export | What it is |
| --- | --- |
| `useElvantoBase()` | Mounts the tools, the raw endpoints and the base instruction |
| `findPerson`, `roster`, `nextServing`, `serviceBrief`, `songHistory`, `listCustomFields` | The tools individually, as factories |
| `endpointTools()`, `CORE_ENDPOINTS`, `ALL_ENDPOINTS` | The 25 raw endpoints as native tools |
| `elvantoRoutes()` (from `/routes`) | The HTTP surface: agent API, web chat, Elvanto sign-in |
| `runElvantoCli()` (from `/cli`) | The terminal runner: one-shot and interactive chat |
| `elvantoMcpConnection()` | A remote MCP connection, if you have one |
| `clientFromEnv()`, `clientForPerson()` | The shared Elvanto client, from the environment or from a signed-in person's grant |
| `elvantoAuthRoutes()`, `requireElvantoSession()`, `createSessionStoreClass()` | Per-user Elvanto sign-in |
| `personCard`, `rosterEntries`, `serviceHeader`, … | The shaping helpers, for building your own tools |

`src/` is published in the tarball too, so `src/agents/elvanto.ts` — a complete
working agent in about a dozen lines — can be copied straight into your project.

## The tools

Each one collapses a multi-call workflow into a single call with a small result.
That is the whole justification: the raw endpoints are faithful to Elvanto, which
is right for a library and wrong for a model's context window.

| Tool | Answers | Why it isn't just the raw endpoint |
| --- | --- | --- |
| `find_person` | "Who is Josh Cuneo?" | Elvanto ANDs search keys, so free text needs several attempts merged. Returns four fields per person, not forty. |
| `roster` | "Who is serving this Sunday?" | The roster is four levels of nesting, keyed `plan` — the same word Elvanto uses for running sheets. Flattened to one row per person. |
| `next_serving` | "When is Ada next on?" | Elvanto has **no** person-centric roster endpoint. The only way is to walk services and search each volunteer tree. |
| `service_brief` | "What's on this Sunday?" | Optional sections only come back when named in `fields`, which a model forgets — then concludes there are no songs. |
| `song_history` | "When did we last sing this?" | Song usage lives on services, not songs. Sweeps a year and aggregates. |
| `list_custom_fields` | "What custom fields exist?" | Custom fields are `custom_<uuid>` keys that differ per account and cannot be guessed. |

Every tool caps its result and **says when it trimmed**. A silently shortened list
reads as a complete answer, and a model will present it as one.

## Setup

```console
$ npm install @criticalcodes/elvanto-agent @flue/runtime
```

`@flue/runtime` is a peer dependency on purpose: Flue's hooks rely on
module-scoped state, so your project must own the single runtime instance. Two
copies would not work.

`@criticalcodes/elvanto-mcp` is **not** a dependency, and is not needed to reach
Elvanto — the endpoint tools do that in-process. `src/app.ts` imports it only to
*serve* MCP to other hosts from the same deployment; add it yourself if you copy
that file.

| Variable | Required | Purpose |
| --- | --- | --- |
| `ELVANTO_API_KEY` | unless signing people in | Secret API key. Elvanto → Settings → Account Settings. |
| `ELVANTO_ACCESS_TOKEN` | — | A fixed OAuth token, instead of a key. |
| `ELVANTO_CLIENT_ID` | for sign-in | OAuth application. Elvanto → Settings → Integrations. |
| `ELVANTO_CLIENT_SECRET` | for sign-in | Same application. Elvanto has no PKCE, so this is unavoidable. |
| `ELVANTO_SESSION_SECRET` | for sign-in | Signs the OAuth `state`. `openssl rand -hex 32`. |
| `ELVANTO_REDIRECT_URI` | — | Pin the callback when a proxy rewrites the host. |
| `ELVANTO_MCP_URL` | — | Only for a *remote* MCP server. Not needed for the Elvanto endpoints. |
| `ELVANTO_MCP_TOKEN` | — | Bearer token for that server. |
| `ELVANTO_VALIDATE` | — | `warn` (default here), `throw`, or `off`. |
| `ELVANTO_MIN_REQUEST_INTERVAL_MS` | — | Request pacing. Default 100. |
| `ELVANTO_DEBUG` | — | `on` or `verbose` — to stderr, never records. |

Two defaults differ from the SDK's, both because an agent session is a poor place
to be strict:

- **`validate: 'warn'`.** These response schemas are derived from Elvanto's
  documentation, so an undocumented field is expected rather than exceptional.
  Under `throw` one new field fails a tool call mid-conversation with nothing the
  model can do about it.
- **Request pacing is on.** Several tools walk pages of services to answer one
  question, and Elvanto documents no rate limit — so the ceiling is found by
  hitting it.

Credentials are read lazily, at the first tool call rather than during the agent
render. A missing key would otherwise throw before the agent exists, killing the
session with an internal error instead of a message the model can relay.

## The raw endpoints — no second process

The six tools cover the common questions; the other 25 read-only endpoints are
mounted too, as **native Flue tools calling the SDK in-process**. No MCP server, no
port, no bearer token, nothing to supervise.

This used to require running `@criticalcodes/elvanto-mcp` over HTTP and pointing
the agent at it, because Flue's MCP client speaks HTTP only. That was a round trip
to nowhere: serialise a call to JSON-RPC, push it over a socket to a second process,
and have that process call the same `client.call()` this one could have called
directly. The MCP server's tools are generated from the same registry these are, so
it bought nothing.

Names and descriptions are identical to the MCP surface, so an instruction, an
allowlist or a transcript reads the same either way.

`'core'` is the default — the endpoints that *add* to the six tools rather than
duplicating them, with three deliberate omissions:

- **Every financial endpoint.** Individual giving records are the most sensitive
  thing an API key reaches, and an agent runtime persists tool results. Opt in with
  `endpoints: 'all'` if you have decided to.
- **`people.search`** — `find_person` does the same job better; offering both
  invites the model to pick the harder one.
- **`people.currentUser`** — OAuth-only, so with an API key it can only fail. When
  people sign in, the deployment already knows who it is talking to.

```ts
useElvantoBase({ endpoints: 'all' })                      // giving data included
useElvantoBase({ endpoints: ['groups.getAll'] })          // an explicit list
useElvantoBase({ endpoints: false })                      // the six tools only
useElvantoBase({ tools: ['find_person', 'roster'] })      // narrow those too
```

**MCP still matters — for other hosts.** `@criticalcodes/elvanto-mcp` is the right
answer when the host is somebody else's: Claude Desktop, a remote connector,
another framework. It is the wrong answer for talking to yourself. If you do have a
genuinely remote MCP server, `mcp: { url, token }` connects one.

## Running it: a binary for the terminal, Flue's build for HTTP

The split is deliberate, and it took a wrong turn to find. Flue has no interactive
chat, so this package provides one. Flue *does* build a server — `vite build` emits
`dist/server.mjs` for Node and a Worker for Cloudflare — so this package does not,
and an earlier version that did has been deleted. It reproduced the build with an
extra dependency and worked only on Node.

### The terminal

`@criticalcodes/elvanto-agent/cli` leans on Flue's `start({ agents })`, which boots
the runtime in the current process with no server, no `app.ts` and no `'use agent'`
scan — so it needs neither Vite nor Wrangler.

```ts
#!/usr/bin/env node
import { runElvantoCli } from '@criticalcodes/elvanto-agent/cli'
import { Church } from './agents/church.ts'

await runElvantoCli({ agent: Church, name: 'church' })
```

```console
$ church "who is on the roster this Sunday?"   # one question, answer on stdout
$ church                                       # interactive terminal chat
$ echo "who is serving?" | church              # pipeable
$ church --json "…" | jq -r .message           # scriptable
```

- A plain `readline` transcript, not a full-screen renderer, so scrollback, copy
  and piping keep working.
- Conversations persist in `./<name>.db`, so `--id` continues one across runs.
- `.env` is loaded, with real environment variables winning — matching `flue run`.
- Extra subcommands come from `commands`, for a scheduled job worth running by hand.

`flue run` remains the right tool for a CI one-shot: it has `--new` for
exactly-once conversation creation, which the `init()` handle deliberately does not
expose.

### HTTP, and the web chat

Mount the routes in your `app.ts` and let Flue build the server:

```ts
// src/app.ts
import { elvantoRoutes } from '@criticalcodes/elvanto-agent/routes'
import { Church } from './agents/church.ts'

export default elvantoRoutes({ agent: Church, title: 'Church office' })
```

```console
$ FLUE_TARGET=node vite build && node dist/server.mjs   # Node
$ vite build && wrangler deploy                          # Cloudflare
```

That serves the agent's API and a self-contained web chat at `/` — one HTML file,
no bundler, no framework, identical on both targets. It polls rather than streams;
for a real application use
[`@flue/react`](https://flueframework.com/docs/guide/react/)'s `useFlueAgent()`.
Pass `chatUi: false` if your application has its own front end.

### Signing people in

Flue mounts agents with **no authentication** — its routing guide is explicit that
anyone who can reach a conversation URL can talk to it, read its full history and
abort its work. Behind an Elvanto agent is every member record the credential can
see. Pass `auth` and each visitor signs in to Elvanto as themselves instead:

```ts
import { authOptionsFromEnv, elvantoRoutes } from '@criticalcodes/elvanto-agent'

const auth = authOptionsFromEnv({ store: () => sessionStore() })

export default elvantoRoutes({
  agent: Church,
  title: 'Church office',
  ...(auth ? { auth } : {}),
})
```

`authOptionsFromEnv` returns `undefined` unless `ELVANTO_CLIENT_ID`,
`ELVANTO_CLIENT_SECRET` and `ELVANTO_SESSION_SECRET` are all set — so the same
route map runs signed-in in production and unauthenticated on a laptop. Setting
only some of them throws, naming the missing one: running unauthenticated because
a variable was misspelled is the failure worth being noisy about.

| `auth` | Behaviour |
| --- | --- |
| set | `/auth/login`, `/auth/callback`, `/auth/logout`, `/auth/session`; a guard over the agent mount; a sign-in page at `/` for a visitor with no session |
| unset | No access control at all, and a warning on every start saying so |

**Per-conversation authorization is included.** Conversation ids are caller-chosen
path segments, so the guard derives each person's id from their session
(`user-<personId>`) and refuses anything else — the ownership check Flue's
[routing guide](https://flueframework.com/docs/guide/routing/) insists on. It also
refuses `initialData` naming a different person, so a signed-in user cannot have
the agent act with someone else's Elvanto permissions inside a conversation they
legitimately own.

An external gate — [Cloudflare
Access](https://developers.cloudflare.com/cloudflare-one/policies/access/), an
authenticating proxy — still composes in front of all this, and is worth adding if
you want the agent reachable only from your own people before Elvanto is consulted
at all. Pass `quiet: true` to silence the warning if that gate is your answer and
you are not using `auth`.

### Where sessions live

`auth.store` takes a `SessionStore`: sessions keyed by an opaque cookie value,
grants keyed by the Elvanto person id. Two implementations ship, and the split is
forced by where the code runs.

```ts
// Cloudflare — the router and the agent are separate isolates
export class ElvantoSessionStore extends createSessionStoreClass() {}   // src/cloudflare.ts
durableObjectSessionStore(env.ELVANTO_SESSIONS)

// Node — one process serves both
new MemorySessionStore()
```

A Durable Object rather than a KV namespace because this is a token store: it is
single-threaded and strongly consistent, so two tool calls refreshing the same
expiring grant cannot both win and leave the loser's refresh token spent. Declare
its binding and a migration in `wrangler.jsonc`.

`MemorySessionStore` loses sessions on restart, which is an inconvenience, and
cannot be shared across instances, which is not — a multi-instance Node deployment
should supply its own store over whatever database it already runs.

**Tokens never reach the durable record log.** Only the person's id does, via
`initialData`; the grant is looked up server-side. Flue's own reference is explicit
that the record log "is still not a secrets channel", and a refresh token there
would be a standing grant on the member database, replayed on every recovery.

### What sign-in does not cover

- **A scheduled run has no signed-in user.** Cron-triggered work cannot borrow
  anyone's grant, so it either keeps an account-wide `ELVANTO_API_KEY` or does not
  run. Decide which deliberately — a sweep quietly running as the whole account is
  the kind of thing per-user auth was meant to stop.
- **A mounted `/mcp` route.** MCP hosts carry a bearer token, not a browser cookie,
  so that surface still uses the environment's credential.

## Extending it

`useElvantoBase()` is a custom hook in Flue's own idiom, so composition is just
more hooks. This is how anything account-specific stays out of a public package:

```ts
'use agent'
import { useModel, useTool } from '@flue/runtime'
import { useElvantoBase } from '@criticalcodes/elvanto-agent'
import { credentialTools } from '../compliance/index.ts'   // yours
import { profile } from '../compliance/profile.ts'         // yours

export function Church() {
  useModel('anthropic/claude-sonnet-5')
  useElvantoBase()
  for (const tool of credentialTools(profile)) useTool(tool)
  return 'You help our office team, and you chase expiring credentials.'
}
```

Build your own tools on the exported shaping helpers, so their results look like
the rest of the toolkit's:

```ts
import { defineTool } from '@flue/runtime'
import { clientFromEnv, personCard, isoDate } from '@criticalcodes/elvanto-agent'
```

## Running and deploying

`flue run` is a complete shipping method, not a fallback — it needs no server:

```console
$ pnpm agent -- --message "Who is serving on Sunday?"
$ pnpm agent -- --id office --message "And the week after?"   # continues a conversation
```

For an HTTP surface, `src/app.ts` mounts the agent and — when `ELVANTO_MCP_TOKEN`
is set — an MCP endpoint, so one deployment can also serve other MCP hosts:

```console
$ pnpm dev                                    # :5173
$ pnpm deploy                                 # Cloudflare Worker
$ FLUE_TARGET=node pnpm build:app             # dist-app/server.mjs, for Docker/Fly/Railway/…
```

Cloudflare needs its secrets set with `wrangler secret put` — an API key that reads
every member and giving record does not belong in `wrangler.jsonc`.

## Privacy

This toolkit reads church member records. Worth deciding about deliberately:

- **An agent runtime persists conversations, tool results included.** Member
  details retrieved during a session end up in whatever store backs it, with a
  lifetime and access model that has nothing to do with Elvanto's. That is a
  materially different risk from an ephemeral chat.
- **The compact shapes are a privacy measure, not only a token one.**
  `src/shape.ts` names the fields that leave, so addresses, giving numbers,
  security codes and custom fields cannot reach a transcript just because they
  happened to be on the record.
- **Tool logs carry counts, never content** — no names, no query strings, no
  records.
- **Narrowing what the agent can reach beats scrubbing afterwards.** Fewer tools,
  or an API key scoped without financial access.

## License

MIT
