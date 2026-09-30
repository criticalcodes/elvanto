import { createServer } from 'node:http'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { ElvantoTokens } from '@criticalcodes/elvanto'
import { FileTokenStore } from '@criticalcodes/elvanto/node'
import { EXIT, main } from '../src/index.js'
import { resolveCredentials } from '../src/auth.js'
import { startStubServer, type StubServer } from './stub-server.js'

let server: StubServer
let stdout: string[]
let stderr: string[]
let directory: string
let credentialsPath: string
let responses: Record<string, unknown>
const savedEnv: Record<string, string | undefined> = {}

const ENV_KEYS = [
  'ELVANTO_CREDENTIALS',
  'ELVANTO_API_KEY',
  'ELVANTO_ACCESS_TOKEN',
  'ELVANTO_OAUTH_BASE_URL',
  'ELVANTO_CLIENT_ID',
  'ELVANTO_CLIENT_SECRET',
  'ELVANTO_PROFILE',
] as const

const currentUser = {
  status: 'ok',
  person: [{ id: 'person-1', firstname: 'Ada', lastname: 'Lovelace' }],
}

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'elvanto-cli-auth-'))
  credentialsPath = join(directory, 'credentials.json')

  // The ambient environment must not decide these tests: a developer with a real
  // ELVANTO_API_KEY exported would otherwise change which branch runs.
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key]
    delete process.env[key]
  }
  process.env['ELVANTO_CREDENTIALS'] = credentialsPath

  responses = {}
  server = await startStubServer((path, body) => {
    if (path === '/oauth/token') {
      return {
        access_token: 'at-fresh',
        refresh_token: 'rt-fresh',
        expires_in: 3600,
        ...(typeof body === 'object' ? {} : {}),
      }
    }
    const response = responses[path]
    if (response === undefined) {
      return { status: 'fail', error: { code: 404, message: `no stub for ${path}` } }
    }
    return response
  })

  process.env['ELVANTO_OAUTH_BASE_URL'] = server.url.replace(/\/v1$/, '')

  stdout = []
  stderr = []
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    stdout.push(String(chunk))
    return true
  })
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    stderr.push(String(chunk))
    return true
  })
})

afterEach(async () => {
  vi.restoreAllMocks()
  await server.close()
  rmSync(directory, { recursive: true, force: true })
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key]
    else process.env[key] = savedEnv[key]
  }
})

const out = () => stdout.join('')
const err = () => stderr.join('')

const validTokens = (): ElvantoTokens => ({
  accessToken: 'at-stored',
  refreshToken: 'rt-stored',
  expiresAt: Date.now() + 3_600_000,
  scopes: ['ManagePeople'],
})

/** A port nothing is listening on, so the loopback redirect can bind it. */
async function freePort(): Promise<number> {
  const probe = createServer()
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const { port } = probe.address() as { port: number }
  await new Promise<void>((resolve) => probe.close(() => resolve()))
  return port
}

/** Waits for `login` to print its authorization URL, then reads the state from it. */
async function waitForAuthorizeUrl(): Promise<URL> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const match = err().match(/(https?:\/\/\S*\/oauth\?\S+)/)
    if (match) return new URL(match[1]!)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`login never printed an authorization URL. stderr was:\n${err()}`)
}

describe('elvanto login', () => {
  test('completes the flow and stores the grant', async () => {
    responses['people/currentUser'] = currentUser
    const port = await freePort()

    const running = main([
      'node',
      'elvanto',
      '--base-url',
      server.url,
      'login',
      '--client-id',
      'client-1',
      '--client-secret',
      'secret-1',
      '--no-browser',
      '--port',
      String(port),
    ])

    const authorize = await waitForAuthorizeUrl()
    expect(authorize.searchParams.get('client_id')).toBe('client-1')
    expect(authorize.searchParams.get('redirect_uri')).toBe(
      `http://127.0.0.1:${port}/callback`,
    )

    const state = authorize.searchParams.get('state')!
    const landed = await fetch(
      `http://127.0.0.1:${port}/callback?code=the-code&state=${encodeURIComponent(state)}`,
    )
    expect(landed.status).toBe(200)
    expect(await landed.text()).toContain('Signed in')

    await expect(running).resolves.toBe(EXIT.ok)

    const stored = JSON.parse(readFileSync(credentialsPath, 'utf8')) as {
      entries: Record<string, ElvantoTokens>
    }
    expect(stored.entries['default']).toMatchObject({
      accessToken: 'at-fresh',
      refreshToken: 'rt-fresh',
    })
    // The only confirmation that means anything: Elvanto naming who signed in.
    expect(out()).toContain('Signed in as Ada Lovelace')

    const exchange = server.requests.find((request) => request.path === '/oauth/token')!
    expect(exchange.body).toMatchObject({
      grant_type: 'authorization_code',
      code: 'the-code',
      client_secret: 'secret-1',
    })
  })

  test('refuses a callback whose state was not the one it issued', async () => {
    const port = await freePort()

    const running = main([
      'node',
      'elvanto',
      'login',
      '--client-id',
      'c',
      '--client-secret',
      's',
      '--no-browser',
      '--port',
      String(port),
    ])

    await waitForAuthorizeUrl()
    const landed = await fetch(
      `http://127.0.0.1:${port}/callback?code=stolen&state=forged.0000`,
    )
    expect(await landed.text()).toContain('Refused')

    await expect(running).resolves.not.toBe(EXIT.ok)
    // Nothing was exchanged, so nothing was stored.
    expect(() => readFileSync(credentialsPath, 'utf8')).toThrow()
  })

  test('reports a declined authorization', async () => {
    const port = await freePort()

    const running = main([
      'node',
      'elvanto',
      'login',
      '--client-id',
      'c',
      '--client-secret',
      's',
      '--no-browser',
      '--port',
      String(port),
    ])

    await waitForAuthorizeUrl()
    await fetch(`http://127.0.0.1:${port}/callback?error=access_denied`)

    // Not a usage error and not a generic failure: a script wants to tell "the
    // user said no" apart from "the request was malformed".
    await expect(running).resolves.toBe(EXIT.auth)
    expect(err()).toContain('access_denied')
  })

  test('says how to get a client id when none is configured', async () => {
    const code = await main(['node', 'elvanto', 'login', '--no-browser'])

    expect(code).toBe(EXIT.usage)
    expect(err()).toContain('Settings > Integrations')
  })

  test('rejects an unknown scope before opening a browser', async () => {
    const code = await main([
      'node',
      'elvanto',
      'login',
      '--client-id',
      'c',
      '--client-secret',
      's',
      '--scope',
      'ManageEverything',
      '--no-browser',
    ])

    expect(code).not.toBe(EXIT.ok)
    expect(err()).toContain('Unknown scope')
  })
})

describe('elvanto logout', () => {
  test('forgets the stored grant', async () => {
    await new FileTokenStore(credentialsPath).write('default', validTokens())

    const code = await main(['node', 'elvanto', 'logout'])

    expect(code).toBe(EXIT.ok)
    expect(new FileTokenStore(credentialsPath).keys()).toEqual([])
    // Says what logging out does not do, which is revoke the grant at Elvanto.
    expect(out()).toContain('Settings > Integrations')
  })
})

describe('elvanto whoami', () => {
  test('names the signed-in person when a grant is stored', async () => {
    responses['people/currentUser'] = currentUser
    await new FileTokenStore(credentialsPath).write('default', validTokens())

    const code = await main(['node', 'elvanto', '--base-url', server.url, 'whoami'])

    expect(code).toBe(EXIT.ok)
    expect(out()).toContain('Signed in as: Ada Lovelace')
    expect(out()).toContain('stored grant')
  })

  test('explains why an API key has no "who"', async () => {
    const code = await main([
      'node',
      'elvanto',
      '--base-url',
      server.url,
      '--api-key',
      'test-key',
      'whoami',
    ])

    expect(code).toBe(EXIT.ok)
    expect(out()).toContain('identifies an account rather than a user')
  })
})

describe('credential precedence', () => {
  test('a stored grant is used when no credential is passed', async () => {
    responses['people/getAll'] = {
      status: 'ok',
      people: { page: 1, per_page: 1, on_this_page: 0, total: 0, person: '' },
    }
    await new FileTokenStore(credentialsPath).write('default', validTokens())

    const code = await main(['node', 'elvanto', '--base-url', server.url, 'people', 'get-all'])

    expect(code).toBe(EXIT.ok)
    const request = server.requests.find((r) => r.path === 'people/getAll')!
    expect(request.authorization).toBe('Bearer at-stored')
  })

  test('an expired stored grant is refreshed before the call', async () => {
    responses['people/getAll'] = {
      status: 'ok',
      people: { page: 1, per_page: 1, on_this_page: 0, total: 0, person: '' },
    }
    await new FileTokenStore(credentialsPath).write('default', {
      ...validTokens(),
      expiresAt: Date.now() - 1,
    })

    const code = await main(['node', 'elvanto', '--base-url', server.url, 'people', 'get-all'])

    expect(code).toBe(EXIT.ok)
    expect(server.requests.some((r) => r.path === '/oauth/token')).toBe(true)
    expect(
      server.requests.find((r) => r.path === 'people/getAll')!.authorization,
    ).toBe('Bearer at-fresh')
    // The rotated pair is kept, or the next run would refresh with a spent token.
    await expect(
      new FileTokenStore(credentialsPath).read('default'),
    ).resolves.toMatchObject({ refreshToken: 'rt-fresh' })
  })

  test('an explicit --api-key beats a stored grant', async () => {
    responses['people/getAll'] = {
      status: 'ok',
      people: { page: 1, per_page: 1, on_this_page: 0, total: 0, person: '' },
    }
    await new FileTokenStore(credentialsPath).write('default', validTokens())

    await main([
      'node',
      'elvanto',
      '--base-url',
      server.url,
      '--api-key',
      'test-key',
      'people',
      'get-all',
    ])

    expect(server.requests.find((r) => r.path === 'people/getAll')!.authorization).toMatch(
      /^Basic /,
    )
  })

  test('a stored grant beats ELVANTO_API_KEY in the environment', () => {
    // The judgement call: signing in is a recent, explicit act, and an exported
    // variable in a shell profile often is neither.
    const resolved = resolveCredentials({
      apiKey: 'from-env',
      apiKeyFromFlag: false,
      tokenFromFlag: false,
      storedTokens: validTokens(),
      env: { ELVANTO_CREDENTIALS: credentialsPath },
    })

    expect(resolved.kind).toBe('oauth')
  })

  test('falls back to the environment when nothing is stored', () => {
    expect(
      resolveCredentials({
        apiKey: 'from-env',
        apiKeyFromFlag: false,
        tokenFromFlag: false,
        storedTokens: undefined,
        env: {},
      }),
    ).toMatchObject({ kind: 'api-key', source: 'ELVANTO_API_KEY' })
  })

  test('says how to get credentials when there are none at all', () => {
    expect(() =>
      resolveCredentials({
        apiKeyFromFlag: false,
        tokenFromFlag: false,
        storedTokens: undefined,
        env: {},
      }),
    ).toThrow(/elvanto login/)
  })

  test('a corrupt credentials file is an error, not a silent fallback', async () => {
    writeFileSync(credentialsPath, '{ not json', 'utf8')

    const code = await main(['node', 'elvanto', '--base-url', server.url, 'people', 'get-all'])

    expect(code).not.toBe(EXIT.ok)
    expect(err()).toContain('not valid JSON')
  })
})

describe('OAuth-only endpoints', () => {
  test('people current-user with an API key is refused locally', async () => {
    const code = await main([
      'node',
      'elvanto',
      '--base-url',
      server.url,
      '--api-key',
      'test-key',
      'people',
      'current-user',
    ])

    // Elvanto answers this with a bare 401, which reads as a bad key rather than
    // the wrong kind of credential.
    expect(code).toBe(EXIT.usage)
    expect(err()).toContain('requires OAuth')
  })

  test('people current-user works with a stored grant', async () => {
    responses['people/currentUser'] = currentUser
    await new FileTokenStore(credentialsPath).write('default', validTokens())

    const code = await main([
      'node',
      'elvanto',
      '--base-url',
      server.url,
      '-o',
      'json',
      'people',
      'current-user',
    ])

    expect(code).toBe(EXIT.ok)
    expect(out()).toContain('Lovelace')
  })
})
