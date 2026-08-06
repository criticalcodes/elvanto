# AGENTS.md

A [Flue](https://flueframework.com) project inside the `elvanto` monorepo. Read the
root `CONTRIBUTING.md` first — the conventions there apply here too.

## What this package is

A **toolkit**, not an agent. Flue scans a project's own source root for
`'use agent'` modules and never `node_modules`, so an agent function imported from
a package is never registered. What ships is everything an agent is composed of —
tools, the MCP connection, and the `useElvantoBase()` hook — plus `src/` in the
tarball so `src/agents/elvanto.ts` can be copied into a consuming project.

Keep it that way. Anything account-specific (credential profiles, local policy,
notice wording) belongs in the repository that owns it, not here — this repo is
public.

## Layout

- `src/tools/` — one file per tool, each a factory taking `ToolDeps`.
- `src/shape.ts` — reshaping Elvanto records into small, deliberate forms.
- `src/base.ts` — the `useElvantoBase()` composition hook and base instruction.
- `src/mcp.ts` — the MCP connection and its allowlist.
- `src/agents/elvanto.ts` — the example agent (`'use agent'`).
- `src/app.ts` — the route map; also mounts the MCP server in-process.
- `src/cloudflare.ts` — Worker-level exports and non-HTTP handlers.
- `wrangler.jsonc` — Worker config. Every agent needs a Durable Object migration
  entry, named `Flue<AgentName>Agent`.

## Commands

Run from the repository root unless noted.

- `pnpm test` / `pnpm typecheck` — the whole workspace, including this package.
- `pnpm --filter @criticalcodes/elvanto-agent build` — the publishable toolkit.
- `pnpm --filter @criticalcodes/elvanto-agent agent -- --message "Hi"` — run the
  agent locally with no server. Needs a model provider key.
- `pnpm --filter @criticalcodes/elvanto-agent dev` — dev server on :5173.
- `FLUE_TARGET=node pnpm --filter @criticalcodes/elvanto-agent build:app` — the
  Node build instead of the Worker.

For the Flue docs offline, use the local binary — `npx flue` resolves to an
unrelated package on npm:

```console
$ ./node_modules/.bin/flue docs search mcp
$ ./node_modules/.bin/flue docs read guide/tools
```

## Conventions particular to this package

- **Tools take `ToolDeps`, and the client may be a factory.** Never build a client
  during an agent render: a missing `ELVANTO_API_KEY` would throw before the agent
  exists, killing the session with an internal error instead of a message the model
  can relay. Use `clientOf(deps)`.
- **Every tool caps its result and says when it trims.** A silently shortened list
  reads as a complete answer, and a model will present it as one.
- **Reshape rather than forward.** `src/shape.ts` names the fields that leave, so
  addresses, giving numbers and custom fields cannot reach a durable transcript
  just because they were on the record.
- **Log counts, never content.** Tool logs may be persisted by the runtime.
- **This package's tsconfig deliberately does not extend the root base** — Flue
  needs bundler resolution and `.ts`-extension imports. The strictness flags are
  repeated instead, so nothing is quietly relaxed.
