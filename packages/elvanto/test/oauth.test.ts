import { describe, expect, test, vi } from 'vitest'
import {
  DEFAULT_SCOPES,
  ELVANTO_SCOPES,
  ElvantoOAuthError,
  MemoryTokenStore,
  authorizeUrl,
  createState,
  createTokenSource,
  exchangeCode,
  isExpired,
  randomToken,
  readState,
  refreshTokens,
  type ElvantoTokens,
} from '../src/oauth.js'
import { stubFetch } from './helpers.js'

const SECRET = 'a-test-secret-of-sufficient-length'

const grant = (body: Record<string, unknown>) => ({ status: 200, body })

describe('authorizeUrl', () => {
  test('builds the documented authorization URL', () => {
    const url = new URL(
      authorizeUrl({
        clientId: 'client-1',
        redirectUri: 'https://example.test/auth/callback',
        scopes: ['ManagePeople', 'ManageServices'],
        state: 'opaque',
      }),
    )

    expect(url.origin + url.pathname).toBe('https://api.elvanto.com/oauth')
    expect(url.searchParams.get('type')).toBe('web_server')
    expect(url.searchParams.get('client_id')).toBe('client-1')
    expect(url.searchParams.get('redirect_uri')).toBe('https://example.test/auth/callback')
    // Elvanto documents a comma-separated list, not the OAuth-usual spaces.
    expect(url.searchParams.get('scope')).toBe('ManagePeople,ManageServices')
    expect(url.searchParams.get('state')).toBe('opaque')
  })

  test('defaults to a scope set that excludes financials and administration', () => {
    const url = new URL(
      authorizeUrl({ clientId: 'c', redirectUri: 'https://example.test/cb' }),
    )
    const scopes = url.searchParams.get('scope')!.split(',')

    expect(scopes).toEqual([...DEFAULT_SCOPES])
    expect(scopes).not.toContain('ManageFinancials')
    expect(scopes).not.toContain('AdministerAccount')
    // Every default is a real scope, so a typo here fails the suite.
    for (const scope of scopes) expect(ELVANTO_SCOPES).toContain(scope)
  })

  test('refuses an empty scope list rather than letting Elvanto reject it', () => {
    expect(() =>
      authorizeUrl({ clientId: 'c', redirectUri: 'https://example.test/cb', scopes: [] }),
    ).toThrow(ElvantoOAuthError)
  })

  test('omits state when none is given', () => {
    const url = new URL(authorizeUrl({ clientId: 'c', redirectUri: 'https://e.test/cb' }))
    expect(url.searchParams.has('state')).toBe(false)
  })
})

describe('exchangeCode', () => {
  test('form-encodes the grant and turns expires_in into an absolute instant', async () => {
    const fetch = stubFetch([
      grant({ access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3600 }),
    ])

    const tokens = await exchangeCode({
      clientId: 'client-1',
      clientSecret: 'secret-1',
      code: 'the-code',
      redirectUri: 'https://example.test/cb',
      fetch,
      now: () => 1_000_000,
    })

    const call = fetch.calls[0]!
    expect(call.url).toBe('https://api.elvanto.com/oauth/token')
    expect(call.method).toBe('POST')
    expect(call.headers['content-type']).toBe('application/x-www-form-urlencoded')

    const sent = new URLSearchParams(call.body as string)
    expect(sent.get('grant_type')).toBe('authorization_code')
    expect(sent.get('client_id')).toBe('client-1')
    expect(sent.get('client_secret')).toBe('secret-1')
    expect(sent.get('code')).toBe('the-code')
    expect(sent.get('redirect_uri')).toBe('https://example.test/cb')

    expect(tokens).toEqual({
      accessToken: 'at-1',
      refreshToken: 'rt-1',
      expiresAt: 1_000_000 + 3_600_000,
      scopes: [],
    })
  })

  test('reads a scope string when Elvanto sends one', async () => {
    const fetch = stubFetch([
      grant({
        access_token: 'at',
        refresh_token: 'rt',
        expires_in: 60,
        scope: 'ManagePeople,ManageServices',
      }),
    ])
    const tokens = await exchangeCode({
      clientId: 'c',
      clientSecret: 's',
      code: 'x',
      redirectUri: 'https://e.test/cb',
      fetch,
    })
    expect(tokens.scopes).toEqual(['ManagePeople', 'ManageServices'])
  })

  test('treats an error field as a failure even on HTTP 200', async () => {
    const fetch = stubFetch([
      grant({ error: 'invalid_grant', error_description: 'that code is spent' }),
    ])

    await expect(
      exchangeCode({
        clientId: 'c',
        clientSecret: 's',
        code: 'used',
        redirectUri: 'https://e.test/cb',
        fetch,
      }),
    ).rejects.toMatchObject({
      name: 'ElvantoOAuthError',
      oauthError: 'invalid_grant',
    })
  })

  test('rejects a 200 that carries no access token', async () => {
    const fetch = stubFetch([grant({ something_else: true })])
    await expect(
      exchangeCode({
        clientId: 'c',
        clientSecret: 's',
        code: 'x',
        redirectUri: 'https://e.test/cb',
        fetch,
      }),
    ).rejects.toThrow(/no access_token/)
  })

  test('never puts the response body in the error message', async () => {
    const fetch = stubFetch([
      { status: 400, body: { error: 'invalid_grant', refresh_token: 'rt-leaked' } },
    ])

    const error = await exchangeCode({
      clientId: 'c',
      clientSecret: 's',
      code: 'x',
      redirectUri: 'https://e.test/cb',
      fetch,
    }).then<unknown, Error>(
      () => {
        throw new Error('expected the exchange to fail')
      },
      (thrown: Error) => thrown,
    )

    expect((error as Error).message).toContain('invalid_grant')
    // The whole reason the message is assembled from named fields rather than
    // from the body: this is the string that gets logged.
    expect((error as Error).message).not.toContain('rt-leaked')
  })
})

describe('refreshTokens', () => {
  test('sends only the grant type and the refresh token by default', async () => {
    const fetch = stubFetch([
      grant({ access_token: 'at-2', refresh_token: 'rt-2', expires_in: 3600 }),
    ])

    await refreshTokens({ refreshToken: 'rt-1', fetch })

    const sent = new URLSearchParams(fetch.calls[0]!.body as string)
    expect(sent.get('grant_type')).toBe('refresh_token')
    expect(sent.get('refresh_token')).toBe('rt-1')
    expect(sent.has('client_id')).toBe(false)
    expect(sent.has('client_secret')).toBe(false)
  })

  test('keeps the old refresh token when the response omits one', async () => {
    const fetch = stubFetch([grant({ access_token: 'at-2', expires_in: 3600 })])
    const tokens = await refreshTokens({ refreshToken: 'rt-1', fetch })

    // Losing it here would end the session silently at the *next* expiry, which
    // is a long way from the cause.
    expect(tokens.refreshToken).toBe('rt-1')
  })

  test('refuses to refresh with nothing', async () => {
    await expect(refreshTokens({ refreshToken: '' })).rejects.toThrow(/must authorize again/)
  })
})

describe('isExpired', () => {
  const tokens = (expiresAt: number): ElvantoTokens => ({
    accessToken: 'at',
    refreshToken: 'rt',
    expiresAt,
    scopes: [],
  })

  test('counts a token inside the skew window as expired', () => {
    const now = () => 1_000_000
    expect(isExpired(tokens(1_000_000 + 120_000), 60_000, now)).toBe(false)
    expect(isExpired(tokens(1_000_000 + 30_000), 60_000, now)).toBe(true)
    expect(isExpired(tokens(999_999), 60_000, now)).toBe(true)
  })
})

describe('createTokenSource', () => {
  const stored = (expiresAt: number): ElvantoTokens => ({
    accessToken: 'at-old',
    refreshToken: 'rt-old',
    expiresAt,
    scopes: ['ManagePeople'],
  })

  test('returns the stored token untouched while it is still valid', async () => {
    const store = new MemoryTokenStore()
    await store.write('k', stored(Date.now() + 3_600_000))
    const fetch = stubFetch([])

    const source = createTokenSource({ store, key: 'k', fetch })

    expect(await source.getAccessToken()).toBe('at-old')
    expect(fetch.calls).toHaveLength(0)
  })

  test('refreshes an expired token and persists the new pair', async () => {
    const store = new MemoryTokenStore()
    await store.write('k', stored(Date.now() - 1))
    const fetch = stubFetch([
      grant({ access_token: 'at-new', refresh_token: 'rt-new', expires_in: 3600 }),
    ])
    const onRefresh = vi.fn()

    const source = createTokenSource({ store, key: 'k', fetch, onRefresh })

    expect(await source.getAccessToken()).toBe('at-new')
    expect(onRefresh).toHaveBeenCalledTimes(1)
    await expect(store.read('k')).resolves.toMatchObject({
      accessToken: 'at-new',
      refreshToken: 'rt-new',
      // Elvanto did not restate the scope, so the original is kept rather than
      // the record losing its provenance.
      scopes: ['ManagePeople'],
    })
  })

  test('single-flights concurrent refreshes so one grant is spent, not five', async () => {
    const store = new MemoryTokenStore()
    await store.write('k', stored(Date.now() - 1))
    const fetch = stubFetch([
      grant({ access_token: 'at-new', refresh_token: 'rt-new', expires_in: 3600 }),
    ])

    const source = createTokenSource({ store, key: 'k', fetch })
    const results = await Promise.all(
      Array.from({ length: 5 }, () => source.getAccessToken()),
    )

    // The failure this guards against: five refreshes, four of them writing a
    // refresh token that the fifth has already invalidated.
    expect(fetch.calls).toHaveLength(1)
    expect(results).toEqual(Array(5).fill('at-new'))
  })

  test('a later caller reuses a refresh that already happened', async () => {
    const store = new MemoryTokenStore()
    await store.write('k', stored(Date.now() - 1))
    const fetch = stubFetch([
      grant({ access_token: 'at-new', refresh_token: 'rt-new', expires_in: 3600 }),
    ])

    const source = createTokenSource({ store, key: 'k', fetch })
    await source.getAccessToken()
    await source.getAccessToken()

    expect(fetch.calls).toHaveLength(1)
  })

  test('says what to do when nothing is stored', async () => {
    const source = createTokenSource({ store: new MemoryTokenStore(), key: 'absent' })
    await expect(source.getAccessToken()).rejects.toThrow(/elvanto login/)
  })

  test('revoke forgets the grant', async () => {
    const store = new MemoryTokenStore()
    await store.write('k', stored(Date.now() + 3_600_000))
    const source = createTokenSource({ store, key: 'k' })

    await source.revoke()

    await expect(source.peek()).resolves.toBeUndefined()
  })
})

describe('state', () => {
  test('round-trips a payload', async () => {
    const state = await createState({ secret: SECRET, payload: { to: '/reports' } })
    await expect(readState({ secret: SECRET, state })).resolves.toMatchObject({
      to: '/reports',
    })
  })

  test('rejects a state signed with a different secret', async () => {
    const state = await createState({ secret: SECRET })
    await expect(
      readState({ secret: 'another-secret-long-enough', state }),
    ).rejects.toThrow(/did not verify/)
  })

  test('rejects a tampered payload', async () => {
    const state = await createState({ secret: SECRET, payload: { to: '/mine' } })
    const [, signature] = state.split('.')
    const forged = `${btoa(JSON.stringify({ iat: Date.now(), to: '/yours' }))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '')}.${signature}`

    await expect(readState({ secret: SECRET, state: forged })).rejects.toThrow(
      /did not verify/,
    )
  })

  test('rejects an absent or malformed state', async () => {
    await expect(readState({ secret: SECRET, state: undefined })).rejects.toThrow(
      /no state parameter/,
    )
    await expect(readState({ secret: SECRET, state: 'nonsense' })).rejects.toThrow(
      /Malformed/,
    )
  })

  test('expires an old state', async () => {
    const state = await createState({ secret: SECRET, now: () => 0 })
    await expect(
      readState({ secret: SECRET, state, maxAgeMs: 1000, now: () => 10_000 }),
    ).rejects.toThrow(/expired/)
  })

  test('refuses a state issued in the future', async () => {
    const state = await createState({ secret: SECRET, now: () => 10_000_000 })
    await expect(readState({ secret: SECRET, state, now: () => 0 })).rejects.toThrow(
      /expired/,
    )
  })

  test('insists on a secret long enough to be one', async () => {
    await expect(createState({ secret: 'short' })).rejects.toThrow(/16 characters/)
  })
})

describe('randomToken', () => {
  test('is hex, the requested length, and not repeated', () => {
    const a = randomToken(16)
    const b = randomToken(16)
    expect(a).toMatch(/^[0-9a-f]{32}$/)
    expect(a).not.toBe(b)
  })
})
