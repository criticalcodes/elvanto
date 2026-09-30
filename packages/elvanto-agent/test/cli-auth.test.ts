import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import type { ElvantoTokens } from '@criticalcodes/elvanto'
import { FileTokenStore } from '@criticalcodes/elvanto/node'
import { profileKey, storedGrant } from '../src/cli/auth.ts'
import {
  clientFromEnv,
  getProcessTokenSource,
  setProcessTokenSource,
  type Env,
} from '../src/client.ts'

let directory: string
let credentials: string

const tokens = (expiresAt = Date.now() + 3_600_000): ElvantoTokens => ({
  accessToken: 'at-stored',
  refreshToken: 'rt-stored',
  expiresAt,
  scopes: ['ManagePeople'],
})

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'elvanto-agent-cli-auth-'))
  credentials = join(directory, 'credentials.json')
})

afterEach(() => {
  rmSync(directory, { recursive: true, force: true })
  setProcessTokenSource(undefined)
})

/** An env bag with no ambient leakage — nothing here reads `process.env`. */
function env(overrides: Env = {}): Env {
  return { ELVANTO_CREDENTIALS: credentials, ...overrides }
}

describe('storedGrant', () => {
  test('is undefined when nothing is stored', () => {
    expect(storedGrant(env())).toBeUndefined()
  })

  test('is a token source when a grant is stored', async () => {
    await new FileTokenStore(credentials).write('default', tokens())

    const source = storedGrant(env())

    expect(source).toBeDefined()
    await expect(source!.getAccessToken()).resolves.toBe('at-stored')
  })

  test('yields to ELVANTO_API_KEY', async () => {
    await new FileTokenStore(credentials).write('default', tokens())

    // The reverse of the endpoint CLI's precedence, and deliberately: an agent
    // binary is launched from a shell or a .env that names its environment, so a
    // variable set there is a current instruction rather than a stale export.
    expect(storedGrant(env({ ELVANTO_API_KEY: 'a-key' }))).toBeUndefined()
    expect(storedGrant(env({ ELVANTO_ACCESS_TOKEN: 'a-token' }))).toBeUndefined()
  })

  test('ignores a blank environment variable rather than treating it as set', async () => {
    await new FileTokenStore(credentials).write('default', tokens())
    expect(storedGrant(env({ ELVANTO_API_KEY: '   ' }))).toBeDefined()
  })

  test('honours ELVANTO_PROFILE', async () => {
    await new FileTokenStore(credentials).write('other', tokens())

    expect(storedGrant(env())).toBeUndefined()
    expect(storedGrant(env({ ELVANTO_PROFILE: 'other' }))).toBeDefined()
    expect(profileKey(env({ ELVANTO_PROFILE: 'other' }))).toBe('other')
  })

  test('a corrupt credentials file does not stop the agent starting', () => {
    writeFileSync(credentials, '{ not json', 'utf8')

    // The first tool call reports a missing credential, which reaches the
    // operator. A throw here would kill the process before the model exists.
    expect(() => storedGrant(env())).not.toThrow()
    expect(storedGrant(env())).toBeUndefined()
  })
})

describe('the process credential', () => {
  test('clientFromEnv uses it when the environment has none', async () => {
    await new FileTokenStore(credentials).write('default', tokens())
    setProcessTokenSource(storedGrant(env()))

    const request = await intercept(() => clientFromEnv(env()))

    expect(request.headers.get('authorization')).toBe('Bearer at-stored')
  })

  test('an environment credential still wins', async () => {
    await new FileTokenStore(credentials).write('default', tokens())
    setProcessTokenSource(storedGrant(env()))

    const request = await intercept(() => clientFromEnv(env({ ELVANTO_API_KEY: 'a-key' })))

    expect(request.headers.get('authorization')).toMatch(/^Basic /)
  })

  test('clearing it restores the unauthenticated behaviour', () => {
    setProcessTokenSource(storedGrant(env()))
    setProcessTokenSource(undefined)

    expect(getProcessTokenSource()).toBeUndefined()
    // Throws at construction. useElvantoBase defers that to the first tool call
    // by holding a factory, so the agent still exists to report it.
    expect(() => clientFromEnv(env())).toThrow(/ELVANTO_API_KEY/)
  })
})

/**
 * Captures the request one call would make.
 *
 * Goes through `client.call` rather than reaching into the transport, so the
 * assertion is about the header Elvanto would actually receive. Takes a factory
 * because the client captures `fetch` when it is constructed, so it has to be
 * built after the stub is installed.
 */
async function intercept(
  build: () => { call: (id: never, params: never) => Promise<unknown> },
): Promise<Request> {
  let captured: Request | undefined
  const original = globalThis.fetch
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    captured = new Request(String(input), init)
    return Response.json({
      status: 'ok',
      people: { page: 1, per_page: 1, on_this_page: 0, total: 0, person: '' },
    })
  }) as typeof globalThis.fetch

  try {
    await build().call('people.getAll' as never, {} as never)
  } finally {
    globalThis.fetch = original
  }

  if (!captured) throw new Error('no request was made')
  return captured
}
