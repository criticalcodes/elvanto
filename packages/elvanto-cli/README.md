# @criticalcodes/elvanto-cli

Command-line access to the [Elvanto](https://www.elvanto.com) church management
API. Read-only.

> Unofficial. Not affiliated with or endorsed by Elvanto.

```console
npm install -g @criticalcodes/elvanto-cli
export ELVANTO_API_KEY=your-secret-api-key   # Settings → Account Settings
elvanto people get-all
```

Or without installing: `npx @criticalcodes/elvanto-cli people get-all`.

## Commands

Commands mirror the API. `elvanto endpoints` lists all 25:

```console
$ elvanto endpoints
people get-all                   List all people.
people search                    Find people matching a search query.
people get-info                  Get one person by ID.
services get-all                 List services.
songs arrangements get-all       List the arrangements of one song.
financial transactions get-all   List financial transactions between two dates.
…
```

Every command's `--help` lists its parameters and links to Elvanto's
documentation for that endpoint:

```console
$ elvanto services get-all --help
Usage: elvanto services get-all [options]

List services. Defaults to upcoming services only — pass all: "yes" or a
start/end range to reach past ones.

Options:
  --page <number>       Results page to retrieve. Default: 1
  --page-size <number>  Records per page, 10–1000. Default: 1000
  --all <yes|no>        Include past services. Default: no.
  --start <value>       Start date, YYYY-MM-DD.
  --fields <values...>  Optional service fields: series_name, service_times, …

Documentation: https://www.elvanto.com/api/services/getAll/
```

## Examples

```console
# Volunteers, as a table
elvanto people get-all --fields volunteer,birthday

# Search — repeat --search for several criteria
elvanto people search --search lastname=Smith --search volunteer=yes

# Every service in a window, with its songs
elvanto services get-all --start 2026-01-01 --end 2026-06-30 --fields songs

# Walk every page and stream to jq
elvanto people get-all --all -o ndjson | jq -r '[.firstname, .lastname] | @tsv'

# Group with its members, as JSON
elvanto groups get-info --id 57beccc8-af4a-11e0-9b4e-f27fa4b6a61b --fields people
```

## Output

`-o table` (default in a terminal), `-o json` (default when piped), or
`-o ndjson` for one record per line.

```console
$ elvanto people get-all --columns 4
ID                                    FIRSTNAME  LASTNAME  EMAIL
b0b0d8d2-48dc-426e-aaba-774936274c99  John       Smith     john@johnsmith.com
aaaa1111-48dc-426e-aaba-774936274c00  Sandra     Cook      sandra@cook.example.com
2 of 668 records (page 1, more available — use --all). 3 more fields per record — use --output json.
```

Tables show scalar fields only and shrink to your terminal width; the footer says
what was left out. Records go to stdout, diagnostics to stderr, so piping is safe.

## Pagination

One page per call by default. `--all` walks every page:

```console
elvanto people get-all --all --max-records 5000 -o ndjson > people.ndjson
```

## Global options

| Option | Description |
| --- | --- |
| `--api-key <key>` | Secret API key. Defaults to `$ELVANTO_API_KEY`. |
| `--token <token>` | OAuth access token instead of a key. `$ELVANTO_ACCESS_TOKEN`. |
| `-o, --output <format>` | `table`, `json`, `ndjson`. |
| `--all` | Fetch every page. |
| `--max-records <n>` | Stop after this many records. |
| `--validate <mode>` | `throw` (default), `warn`, `off`. See below. |
| `--debug [mode]` | Log requests and timings to stderr. `verbose` adds parameter values. |
| `--timeout <ms>` | Per-request timeout. Default 30000. |
| `--retries <n>` | Retries for rate limits and 5xx. Default 2. |
| `--columns <n>` | Max table columns. Default 6. |
| `--params-json <json>` | Extra parameters, merged over the flags. |

All of these also read an `ELVANTO_*` environment variable.

## When Elvanto returns something unexpected

Elvanto publishes no machine-readable API spec, so this tool's response schemas
come from its documentation examples — and can be wrong. By default a mismatch is
a hard error, because silence would be worse:

```console
$ elvanto people get-all
error: Unexpected response shape from people.getAll:
  - people.items.0.id: Invalid input: expected string, received number

This usually means Elvanto's API differs from its documentation.
Re-run with --validate warn to use the data anyway, and please report it.
```

`--validate warn` returns the data and prints the mismatch to stderr;
`--validate off` skips checking altogether. Either way you get your data — and
please do report it, since that's how the schemas get fixed.

## Debugging

```console
$ elvanto people get-all --debug
[elvanto] request people/getAll — POST url=… bytes=16 params=page_size
[elvanto] response people/getAll — HTTP 200 durationMs=142 attempt=1 generatedIn=0.021
[elvanto] result people.getAll — page returned=25 total=668 page=1 hasMore=true
```

Logs go to stderr, so `--debug` is safe to combine with piping. Credentials and
returned records are never logged. `--debug verbose` adds parameter values, except
`search` terms, which stay redacted.

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Success |
| 1 | Elvanto or network error |
| 2 | Usage error — bad flag, missing required parameter |
| 3 | Authentication failed |
| 4 | Not found, or nothing matched |
| 5 | Response didn't match the expected schema |

```console
elvanto people get-info --id "$id" -o json || case $? in
  4) echo "no such person" ;;
  3) echo "check your API key" ;;
esac
```

## Escape hatch

For a parameter Elvanto supports that this version doesn't model:

```console
elvanto people get-all --params-json '{"some_new_filter":"x"}'
```

Unrecognised keys skip local validation and go straight to Elvanto.

## Scope

Read-only. No command can modify your Elvanto data.

## License

MIT
