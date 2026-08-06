# Contributing

```console
pnpm install
pnpm test          # 273 tests, no network
pnpm typecheck     # also enforces the compile-time type assertions
pnpm build
```

Developing needs **Node 22.13+**, because pnpm 11 does. The published packages
support **Node 20+** — a separate claim, tested separately by CI.

## Four things that aren't obvious

**Adding an endpoint means editing one file.** Everything derives from
[`packages/elvanto/src/registry.ts`](packages/elvanto/src/registry.ts): the SDK
method, the CLI command, the MCP tool and its JSON Schema. Add a registry entry
plus one binding line in `client.ts`, and the other two surfaces pick it up. Don't
add an endpoint to the CLI or MCP server directly — if you find yourself wanting
to, the registry is missing something.

**`verified: 'live'` has to be earned.** Every endpoint declares whether its
response shape has only been checked against Elvanto's documented example
(`'docs'`) or has actually been seen returning real records (`'live'`). A registry
test pins the `docs`-only list, so promoting one requires a real sweep behind it.
Please don't edit that list hopefully — the distinction is the honest record of
what this library knows, and it has already caught two documentation errors.

**Tests and typecheck resolve the SDK to source, not `dist`.** Via an alias in
`vitest.config.ts` and `paths` in the two consuming tsconfigs. Without that, a
change to the SDK stays invisible to the CLI and MCP suites until someone runs
`pnpm build`, and they pass against the previous build. If you add a package,
wire it up the same way.

**Never commit account data.** `pnpm check:secrets` runs in CI and fails on
credential-shaped strings and on sweep output (`report*.json`). Test fixtures use
Elvanto's published documentation examples deliberately — please keep it that way
rather than pasting from a real account.

## Response schemas

Elvanto publishes no machine-readable spec, so schemas come from documentation
examples and are then confirmed against real accounts. Two rules follow:

- **Where the shape is genuinely unknown, say so** in a comment, and be tolerant
  in the schema. Where a real account has settled it, narrow the schema and record
  that. `school_grade` and `family` are both documented wrongly, and both were only
  caught by a live sweep.
- **Fail loudly rather than silently.** A wrong guess that throws gets reported and
  fixed; one that quietly returns an empty array reads as "this account has no
  departments" and can go unnoticed for a long time. Prefer the former.

`pnpm smoke` sweeps every read-only endpoint against a real account and reports
fields Elvanto returned that the schemas don't declare, and fields declared that
never appeared. It redacts values by default and skips financial data unless asked.
See the [README](README.md#verifying-against-a-real-account).

## Commits and pull requests

Explain **why** in the commit message; the diff already shows what. If you worked
something out the hard way — a documentation error, a shape only real data reveals —
that belongs in the message or a comment, because the next person will otherwise
rediscover it.

CI must be green: secrets check, typecheck, tests, build, and the runtime check on
Node 20, 22 and 24.
