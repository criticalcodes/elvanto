# @criticalcodes/elvanto-mcp

An [MCP](https://modelcontextprotocol.io) server that exposes the
[Elvanto](https://www.elvanto.com) church management API to an LLM as tools.
Read-only by default; tools that change the account are an explicit opt-in.

> Unofficial. Not affiliated with or endorsed by Elvanto.

## Setup

Add it to your MCP client's configuration. For Claude Desktop
(`claude_desktop_config.json`) or Claude Code (`.mcp.json`):

```json
{
  "mcpServers": {
    "elvanto": {
      "command": "npx",
      "args": ["-y", "@criticalcodes/elvanto-mcp"],
      "env": { "ELVANTO_API_KEY": "your-secret-api-key" }
    }
  }
}
```

Your key is in Elvanto under **Settings → Account Settings → Secret API Key**.

### Or sign in as yourself

An API key identifies the account and reads every member and giving record in it.
To have the server act as *you* instead, sign in once with the CLI and leave the
key out of the configuration entirely:

```console
$ npm install -g @criticalcodes/elvanto-cli
$ ELVANTO_CLIENT_ID=… ELVANTO_CLIENT_SECRET=… elvanto login
```

```json
{
  "mcpServers": {
    "elvanto": { "command": "npx", "args": ["-y", "@criticalcodes/elvanto-mcp"] }
  }
}
```

The server picks up the stored grant, refreshes it as needed, and says so on
startup. `ELVANTO_API_KEY` and `ELVANTO_ACCESS_TOKEN` still win if set — an MCP
client's configuration names its environment explicitly, so a variable there is a
current instruction rather than a stale shell export.

Requires Node 20+.

## Transports

**stdio** is the default, and is what a desktop MCP client launches.

**Streamable HTTP** is for hosts that take a URL and cannot spawn a subprocess —
which includes most agent frameworks. Same 25 tools, same behaviour:

```console
$ ELVANTO_API_KEY=your-key ELVANTO_MCP_TOKEN=$(openssl rand -hex 32) \
    npx -y @criticalcodes/elvanto-mcp --http
[elvanto-mcp] Listening on http://127.0.0.1:3001/ (bearer token required)
```

Point the host at `http://127.0.0.1:3001/` with that token as
`Authorization: Bearer …`. `--port` and `--host` change where it binds.

The HTTP mode is **stateless** — no sessions, one server per request — so it also
runs behind a load balancer, or on a runtime with no process between requests.

Two guardrails, because this port answers with member and giving data:

- It **binds `127.0.0.1` by default**. Serving a reachable interface requires
  `ELVANTO_MCP_TOKEN`; without one, `--host 0.0.0.0` refuses to start rather than
  publishing the account to the local network.
- On loopback with no token it warns, because any process on the machine can then
  read the whole account through it.

### Mounting it in your own application

The server is also importable, so an application that already has an HTTP surface
can mount it instead of running a second process. The handler is a plain
`Request → Response` function with no Node dependencies, so it works on Workers
and Deno as well as Node:

```ts
import { configFromEnv, createHttpHandler } from '@criticalcodes/elvanto-mcp'

const handler = createHttpHandler(configFromEnv(), { token: process.env.ELVANTO_MCP_TOKEN })

app.all('/mcp', (c) => handler(c.req.raw))
```

## Tools

By default, 25 tools, one per read-only endpoint, named in snake_case:

```
elvanto_people_get_all                    elvanto_songs_get_all
elvanto_people_search                     elvanto_songs_get_info
elvanto_people_get_info                   elvanto_songs_categories_get_all
elvanto_people_current_user               elvanto_songs_arrangements_get_all
elvanto_people_categories_get_all         elvanto_songs_arrangements_get_info
elvanto_people_custom_fields_get_all      elvanto_songs_keys_get_all
                                          elvanto_songs_keys_get_info
elvanto_people_flows_get_all
elvanto_people_flows_steps_get_all        elvanto_calendar_get_all
elvanto_people_flows_steps_people         elvanto_calendar_events_get_all

elvanto_groups_get_all                    elvanto_financial_transactions_get_all
elvanto_groups_get_info                   elvanto_financial_transactions_get_info
                                          elvanto_financial_categories_get_all
elvanto_services_get_all
elvanto_services_get_info
```

Each is generated from the same endpoint registry as the `@criticalcodes/elvanto` SDK, so its
input schema is exactly the endpoint's documented parameters, and its description
carries Elvanto's own guidance plus a link to the relevant documentation page.
Read tools are annotated `readOnlyHint: true`; write tools carry
`readOnlyHint: false`, and `destructiveHint: true` where they delete or discard
data, so a client can ask before calling them.

Things a model would otherwise get wrong are stated in the descriptions: that
`elvanto_services_get_all` returns only upcoming services unless asked otherwise,
that `elvanto_people_search` takes a field-to-keyword map, that custom fields are
addressed by `custom_<uuid>` keys discoverable via
`elvanto_people_custom_fields_get_all`.

## Responses

Records are normalized out of Elvanto's XML-shaped JSON — collection wrappers
flattened, single records unwrapped, booleans and numbers made consistent — then
returned as JSON with pagination the model can act on:

```json
{
  "total": 668,
  "page": 1,
  "per_page": 25,
  "returned": 25,
  "has_more": true,
  "items": [ { "id": "b0b0d8d2-…", "firstname": "John", "volunteer": true } ]
}
```

**Page size defaults to 25**, not Elvanto's 1000, so a large account can't flood
the context window. A model can raise it explicitly up to 1000.

Responses are capped at 100,000 characters. If a response would exceed it,
records are dropped and the payload says so explicitly, with advice to narrow the
query — a truncated result never masquerades as a complete one.

## Errors

Failures come back as tool errors (`isError: true`) rather than protocol errors,
so the model can react, and they say who can fix the problem. An invalid argument
is the model's to correct; a bad API key is not:

> Elvanto rejected the credentials (Invalid API Key). Whoever runs this server
> needs to supply a valid ELVANTO_API_KEY, or sign in again with `elvanto login`
> if it is using a stored OAuth grant. This cannot be fixed by changing the
> request, so do not retry it.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `ELVANTO_API_KEY` | — | Secret API key. |
| `ELVANTO_ACCESS_TOKEN` | — | A fixed OAuth access token, instead of a key. |
| `ELVANTO_PROFILE` | `default` | Which stored `elvanto login` grant to use. |
| `ELVANTO_CREDENTIALS` | `~/.config/elvanto/credentials.json` | Where that grant is read from. |
| `ELVANTO_VALIDATE` | `throw` | `throw`, `warn`, or `off`. See below. |
| `ELVANTO_MCP_PAGE_SIZE` | `25` | Records per call when unspecified. |
| `ELVANTO_MCP_MAX_RESPONSE_CHARS` | `100000` | Response size cap. |
| `ELVANTO_MCP_TOKEN` | — | Bearer token required by `--http`. Mandatory for a non-loopback bind. |
| `ELVANTO_DEBUG` | off | `on` or `verbose` — log to stderr. |
| `ELVANTO_BASE_URL` | Elvanto's API | Override the API root. |

Starting without credentials is not fatal: the server still lists its tools and
explains the problem on the first call, rather than dying before the handshake and
leaving the client with no explanation.

### `ELVANTO_VALIDATE`

Elvanto publishes no machine-readable spec, so this server's response schemas are
derived from documentation examples. By default an unrecognised response is a tool
error that names the mismatch — silently passing through data we don't understand
would be worse. If you hit one, `ELVANTO_VALIDATE=warn` accepts the response
anyway and logs the mismatch to stderr.

## Privacy

This server can read church member records and giving data. Worth knowing before
you connect it to a model:

- **Financial tools are included.** `elvanto_financial_transactions_get_all` and
  friends return individual giving records. If that shouldn't be reachable, use an
  API key scoped without financial access, or don't run this server.
- **Whatever a tool returns enters the model's context**, and your MCP client may
  log or retain it. The 25-record default limits blast radius; it doesn't remove it.
- **Agent frameworks that persist sessions persist this data too.** A durable
  agent runtime records the conversation — including tool results — so member
  records and giving history end up in whatever store backs it, with a lifetime
  and access model that has nothing to do with Elvanto's. That is a materially
  different risk from an ephemeral chat, and worth deciding about deliberately
  before connecting this to one. Narrowing what the agent can reach (fewer tools,
  or a scoped API key) is more effective than trying to scrub it afterwards.
- **Debug logs never contain credentials or returned records** — only counts,
  statuses and timings. Logs go to stderr, so they can't corrupt the stdio
  protocol channel.

## Writes

Off unless `ELVANTO_MCP_WRITES` says otherwise, so a server set up before writes
existed does not gain them on upgrade:

| `ELVANTO_MCP_WRITES` | Adds |
| --- | --- |
| `off` (default) | nothing — reads only |
| `write` | `people_create`, `groups_create`, `groups_edit`, `groups_add_person`, `people_flows_steps_add_person` |
| `all` | also `people_edit`, `people_remove`, `groups_remove`, `groups_remove_person` |

`people_edit` sits with the destructive tools because a blank `family_id` detaches
a person from their family. A tool that is not enabled is not just unlisted — a
call to it by name is refused. The server says on startup when writes are on.

A write is never retried after a timeout, a dropped connection or a 5xx, because
any of those can follow Elvanto having made the change. The tool result says the
outcome is unknown and tells the model to read the record before trying again.

### What a live account showed

Checked against a real account with throwaway people and a throwaway group,
since deleted: create, edit, remove and every group write behave as documented,
and their acknowledgements match (`groups/remove` answers under `group`, not the
documented `person`). Custom fields take, in `fields`:

| Field type | Write | Clear |
| --- | --- | --- |
| checkbox (`select_multi`) | array of option names; replaces the whole selection | `""` — `[]` is accepted and changes nothing |
| drop-down (`select`) | a string: the option name or its id | `""` |
| text, date | a string; dates as `YYYY-MM-DD` | `""` |

Elvanto's field reference says a drop-down takes an array; a live account
rejects one with "Invalid Value for custom field".

**Two edits to the same person within the same wall-clock second fail** with
"we've run into a problem when saving to the database", and the second is not
applied. The SDK spaces writes to the same record by a little over a second
(`sameRecordWriteGapMs`), so callers do not meet this; writes to different
records are not held up. `peopleFlows.steps.addPerson` has not been exercised
live.

## License

MIT
