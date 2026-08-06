# Security

## Reporting a vulnerability

Please report privately rather than opening a public issue: use
[GitHub's private vulnerability reporting](https://github.com/criticalcodes/elvanto/security/advisories/new),
or email the maintainer via the address on the commits.

A fix or an explanation within a couple of weeks is the aim. There is no bounty.

## What this software does and doesn't touch

These packages are a **read-only** client for the Elvanto API. Nothing here can
modify an Elvanto account, and no mutating endpoint is exposed.

There is no server component. The library makes outbound HTTPS requests and
processes the responses; it does not listen on a port or accept input from an
untrusted network. The MCP server speaks over stdio to a parent process, not over
a socket.

## What is worth reporting

Most valuable, roughly in order:

1. **Anywhere a credential could leak.** Diagnostic logging is designed never to
   include credentials in any encoding, or the contents of any returned record.
   A path that defeats that is a real bug.
2. **Anywhere member or giving data goes somewhere unexpected.** The known,
   deliberate exception is documented below.
3. Anything that turns a malicious or malformed API response into worse than a
   thrown error — prototype pollution, unbounded memory growth, code execution.
4. Dependency vulnerabilities that are actually reachable from this code.

## Known and deliberate

**Errors carry the raw response.** `ElvantoApiError.body` and
`ElvantoResponseValidationError.data` hold the unvalidated payload, because a
schema mismatch cannot be diagnosed without seeing what arrived. Those two fields
can therefore contain member records or giving data. `error.message` never
contains a field value — mismatches are reported by path — so log the message
rather than the whole object, or strip those fields first.

This is a documented trade rather than a defect. A report showing it leaking
somewhere a caller could not reasonably anticipate is still welcome.

## Operator responsibilities

An Elvanto API key grants read access to **every member record and every giving
record** in the account. Consequently:

- Nothing in this repository reads a `.env` file, deliberately. Credentials are
  passed per invocation so a long-lived key need not sit on disk.
- Prefer an API key scoped without financial access when giving data isn't needed.
- Agent runtimes that persist sessions persist tool results too — member data then
  lives in that store, with a lifetime and access model unrelated to Elvanto's.
  Narrowing what the agent can reach is more effective than scrubbing afterwards.

## Supported versions

Only the latest release is supported. Before `1.0.0`, fixes land in a new minor
version.
