# @criticalcodes/elvanto-mcp

An [MCP](https://modelcontextprotocol.io) server that exposes the
[Elvanto](https://www.elvanto.com) church management API to an LLM as tools.
Read-only: no tool can modify your Elvanto data.

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

Requires Node 20+.

## Tools

25 tools, one per read-only endpoint, named in snake_case:

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
All are annotated `readOnlyHint: true`.

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

> Elvanto rejected the credentials (Invalid API Key). The server needs a valid
> ELVANTO_API_KEY. This cannot be fixed by changing the request.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `ELVANTO_API_KEY` | — | Secret API key. Required. |
| `ELVANTO_ACCESS_TOKEN` | — | OAuth access token, instead of a key. |
| `ELVANTO_VALIDATE` | `throw` | `throw`, `warn`, or `off`. See below. |
| `ELVANTO_MCP_PAGE_SIZE` | `25` | Records per call when unspecified. |
| `ELVANTO_MCP_MAX_RESPONSE_CHARS` | `100000` | Response size cap. |
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

## Scope

Read-only. Mutating endpoints (`create`, `edit`, `remove`, `addPerson`) are not
exposed, and when they are added they will require an explicit opt-in — an MCP
server shouldn't gain the ability to delete a person as a side effect of an
upgrade.

## License

MIT
