import { describe, expect, test } from 'vitest'
import { Hono } from 'hono'
import type { ElvantoTokens } from '@criticalcodes/elvanto'
import {
  MemorySessionStore,
  conversationIdFor,
  createSessionStoreClass,
  durableObjectSessionStore,
  elvantoAuthRoutes,
  requireElvantoSession,
  type DurableObjectNamespaceLike,
  type ElvantoAuthOptions,
  type ElvantoSession,
  type SessionStore,
} from '../src/auth/index.ts'
import { authOptionsFromEnv } from '../src/auth/index.ts'

const STATE_SECRET = 'a-test-session-secret-long-enough'

const tokens: ElvantoTokens = {
  accessToken: 'at-1',
  refreshToken: 'rt-1',
  expiresAt: Date.now() + 3_600_000,
  scopes: ['ManagePeople'],
}

function session(overrides: Partial<ElvantoSession> = {}): ElvantoSession {
  return {
    id: 'session-abc',
    personId: 'person-1',
    name: 'Ada Lovelace',
    createdAt: Date.now(),
    expiresAt: Date.now() + 3_600_000,
    ...overrides,
  }
}

/**
 * A stub Elvanto: the OAuth token endpoint and `people/currentUser`, which is the
 * whole of what the callback touches.
 */
function stubElvanto(options: { personId?: string; failExchange?: boolean } = {}) {
  const calls: Array<{ url: string; body: string }> = []

  const fetch = async (
    input: Parameters<typeof globalThis.fetch>[0],
    init?: RequestInit,
  ): Promise<Response> => {
    const url = String(input)
    calls.push({ url, body: String(init?.body ?? '') })

    if (url.endsWith('/oauth/token')) {
      if (options.failExchange) {
        return Response.json({ error: 'invalid_grant' }, { status: 400 })
      }
      return Response.json({
        access_token: 'at-1',
        refresh_token: 'rt-1',
        expires_in: 3600,
      })
    }
    if (url.endsWith('/people/currentUser.json')) {
      return Response.json({
        status: 'ok',
        person: [
          { id: options.personId ?? 'person-1', firstname: 'Ada', lastname: 'Lovelace' },
        ],
      })
    }
    return Response.json({ status: 'fail', error: { code: 404, message: url } })
  }

  return { fetch, calls }
}

function authOptions(
  store: SessionStore,
  overrides: Partial<ElvantoAuthOptions> = {},
): ElvantoAuthOptions {
  return {
    clientId: 'client-1',
    clientSecret: 'secret-1',
    stateSecret: STATE_SECRET,
    store,
    ...overrides,
  }
}

describe('elvantoAuthRoutes', () => {
  test('login redirects to Elvanto with a signed state', async () => {
    const app = new Hono().route('/auth', elvantoAuthRoutes(authOptions(new MemorySessionStore())))

    const response = await app.request('http://app.test/auth/login')

    expect(response.status).toBe(302)
    const target = new URL(response.headers.get('location')!)
    expect(target.origin + target.pathname).toBe('https://api.elvanto.com/oauth')
    expect(target.searchParams.get('client_id')).toBe('client-1')
    expect(target.searchParams.get('redirect_uri')).toBe('http://app.test/auth/callback')
    // Signed, so a callback cannot be forged by someone who never started one.
    expect(target.searchParams.get('state')).toMatch(/^[\w-]+\.[0-9a-f]{64}$/)
  })

  test('refuses a callback whose state was not signed here', async () => {
    const store = new MemorySessionStore()
    const app = new Hono().route('/auth', elvantoAuthRoutes(authOptions(store)))

    const response = await app.request(
      'http://app.test/auth/callback?code=c&state=forged.0000',
    )

    // Session fixation: without this check an attacker can hand a victim a
    // callback URL carrying the attacker's own code and bind the victim's
    // browser to the attacker's Elvanto account.
    expect(response.status).toBe(400)
    expect(await response.text()).toContain('Sign-in refused')
  })

  test('refuses a callback with no state at all', async () => {
    const app = new Hono().route('/auth', elvantoAuthRoutes(authOptions(new MemorySessionStore())))
    const response = await app.request('http://app.test/auth/callback?code=c')
    expect(response.status).toBe(400)
  })

  test('exchanges the code, stores the grant and sets an httpOnly cookie', async () => {
    const store = new MemorySessionStore()
    const elvanto = stubElvanto()
    const options = authOptions(store, {
      oauthBaseUrl: 'https://oauth.test',
      apiBaseUrl: 'https://api.test/v1',
    })
    const app = new Hono().route('/auth', elvantoAuthRoutes(options))

    const state = new URL(
      (await app.request('http://app.test/auth/login')).headers.get('location')!,
    ).searchParams.get('state')!

    const previousFetch = globalThis.fetch
    globalThis.fetch = elvanto.fetch as typeof globalThis.fetch
    let response: Response
    try {
      response = await app.request(
        `http://app.test/auth/callback?code=the-code&state=${encodeURIComponent(state)}`,
      )
    } finally {
      globalThis.fetch = previousFetch
    }

    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe('/')

    const cookie = response.headers.get('set-cookie')!
    expect(cookie).toMatch(/elvanto_session=/)
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('SameSite=Lax')
    // Plain http here, so Secure must be absent or sign-in would fail on
    // localhost. It is derived from the request, not hard-coded.
    expect(cookie).not.toContain('Secure')

    // The grant is keyed by the person, not by the session, so signing in again
    // reaches the same one.
    await expect(store.read('person-1')).resolves.toMatchObject({ accessToken: 'at-1' })
  })

  test('marks the cookie Secure behind an https proxy', async () => {
    const store = new MemorySessionStore()
    const elvanto = stubElvanto()
    const app = new Hono().route('/auth', elvantoAuthRoutes(authOptions(store)))

    const state = new URL(
      (await app.request('http://app.test/auth/login')).headers.get('location')!,
    ).searchParams.get('state')!

    const previousFetch = globalThis.fetch
    globalThis.fetch = elvanto.fetch as typeof globalThis.fetch
    let response: Response
    try {
      response = await app.request(
        `http://app.test/auth/callback?code=c&state=${encodeURIComponent(state)}`,
        { headers: { 'x-forwarded-proto': 'https' } },
      )
    } finally {
      globalThis.fetch = previousFetch
    }

    expect(response.headers.get('set-cookie')).toContain('Secure')
  })

  test('reports a declined authorization rather than failing opaquely', async () => {
    const app = new Hono().route('/auth', elvantoAuthRoutes(authOptions(new MemorySessionStore())))
    const response = await app.request('http://app.test/auth/callback?error=access_denied')

    expect(response.status).toBe(400)
    expect(await response.text()).toContain('access_denied')
  })

  test('surfaces a failed exchange without storing anything', async () => {
    const store = new MemorySessionStore()
    const elvanto = stubElvanto({ failExchange: true })
    const app = new Hono().route('/auth', elvantoAuthRoutes(authOptions(store)))

    const state = new URL(
      (await app.request('http://app.test/auth/login')).headers.get('location')!,
    ).searchParams.get('state')!

    const previousFetch = globalThis.fetch
    globalThis.fetch = elvanto.fetch as typeof globalThis.fetch
    let response: Response
    try {
      response = await app.request(
        `http://app.test/auth/callback?code=c&state=${encodeURIComponent(state)}`,
      )
    } finally {
      globalThis.fetch = previousFetch
    }

    expect(response.status).toBe(502)
    await expect(store.read('person-1')).resolves.toBeUndefined()
  })

  test('keeps a return path on this origin', async () => {
    const app = new Hono().route('/auth', elvantoAuthRoutes(authOptions(new MemorySessionStore())))

    const login = await app.request('http://app.test/auth/login?to=//evil.test/steal')
    const state = new URL(login.headers.get('location')!).searchParams.get('state')!
    // The signed payload is base64url JSON; decoding it is how we see what the
    // callback would redirect to.
    const payload = JSON.parse(
      atob(state.split('.')[0]!.replace(/-/g, '+').replace(/_/g, '/')),
    ) as { to: string }

    // An open redirect on a sign-in route is worth more than most, because the
    // link that reaches the victim is genuinely from this site.
    expect(payload.to).toBe('/')
  })

  test('session reports who is signed in, and their conversation', async () => {
    const store = new MemorySessionStore()
    const live = session()
    await store.writeSession(live)
    const app = new Hono().route('/auth', elvantoAuthRoutes(authOptions(store)))

    const response = await app.request('http://app.test/auth/session', {
      headers: { cookie: `elvanto_session=${live.id}` },
    })

    await expect(response.json()).resolves.toMatchObject({
      signedIn: true,
      name: 'Ada Lovelace',
      conversationId: 'user-person-1',
    })
  })

  test('session reports signed out with nowhere to guess', async () => {
    const app = new Hono().route('/auth', elvantoAuthRoutes(authOptions(new MemorySessionStore())))
    const response = await app.request('http://app.test/auth/session')
    await expect(response.json()).resolves.toEqual({
      signedIn: false,
      loginUrl: '/auth/login',
    })
  })

  test('logout drops the session and clears the cookie, but keeps the grant', async () => {
    const store = new MemorySessionStore()
    const live = session()
    await store.writeSession(live)
    await store.write(live.personId, tokens)
    const app = new Hono().route('/auth', elvantoAuthRoutes(authOptions(store)))

    const response = await app.request('http://app.test/auth/logout', {
      method: 'POST',
      headers: { cookie: `elvanto_session=${live.id}` },
    })

    expect(response.status).toBe(302)
    expect(response.headers.get('set-cookie')).toMatch(/elvanto_session=;/)
    await expect(store.readSession(live.id)).resolves.toBeUndefined()
    // Signing out of one browser should not revoke a grant other sessions use.
    await expect(store.read(live.personId)).resolves.toBeDefined()
  })
})

describe('requireElvantoSession', () => {
  async function guarded(store: SessionStore) {
    const app = new Hono()
    app.use(
      '/agents/elvanto/*',
      requireElvantoSession({ ...authOptions(store), mount: '/agents/elvanto' }),
    )
    app.all('/agents/elvanto/*', (c) => c.json({ reached: true }))
    return app
  }

  test('turns away a request with no session', async () => {
    const app = await guarded(new MemorySessionStore())
    const response = await app.request('http://app.test/agents/elvanto/user-person-1')

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toMatchObject({ loginUrl: '/auth/login' })
  })

  test('sends a browser to sign in instead of showing it JSON', async () => {
    const app = await guarded(new MemorySessionStore())
    const response = await app.request('http://app.test/agents/elvanto/user-person-1', {
      headers: { accept: 'text/html' },
    })

    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe('/auth/login')
  })

  test('lets a signed-in person reach their own conversation', async () => {
    const store = new MemorySessionStore()
    const live = session()
    await store.writeSession(live)
    const app = await guarded(store)

    const response = await app.request(
      `http://app.test/agents/elvanto/${conversationIdFor(live)}`,
      { headers: { cookie: `elvanto_session=${live.id}` } },
    )

    expect(response.status).toBe(200)
  })

  test('refuses another person’s conversation id', async () => {
    const store = new MemorySessionStore()
    const live = session()
    await store.writeSession(live)
    const app = await guarded(store)

    const response = await app.request('http://app.test/agents/elvanto/user-person-2', {
      headers: { cookie: `elvanto_session=${live.id}` },
    })

    // Conversation ids are caller-chosen path segments. Without this check any
    // signed-in user reads any other's history by editing the URL.
    expect(response.status).toBe(403)
  })

  test('covers the sub-routes too, not just the conversation root', async () => {
    const store = new MemorySessionStore()
    const live = session()
    await store.writeSession(live)
    const app = await guarded(store)

    const response = await app.request(
      'http://app.test/agents/elvanto/user-person-2/attachments/a1',
      { headers: { cookie: `elvanto_session=${live.id}` } },
    )

    expect(response.status).toBe(403)
  })

  test('refuses initialData that names someone else', async () => {
    const store = new MemorySessionStore()
    const live = session()
    await store.writeSession(live)
    const app = await guarded(store)

    const response = await app.request(
      `http://app.test/agents/elvanto/${conversationIdFor(live)}`,
      {
        method: 'POST',
        headers: { cookie: `elvanto_session=${live.id}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          kind: 'user',
          body: 'hello',
          initialData: { personId: 'person-2' },
        }),
      },
    )

    // Otherwise a signed-in user could have the agent act with someone else's
    // Elvanto permissions inside a conversation they legitimately own.
    expect(response.status).toBe(403)
  })

  test('accepts initialData that matches, and leaves the body readable', async () => {
    const store = new MemorySessionStore()
    const live = session()
    await store.writeSession(live)

    const app = new Hono()
    app.use(
      '/agents/elvanto/*',
      requireElvantoSession({ ...authOptions(store), mount: '/agents/elvanto' }),
    )
    app.post('/agents/elvanto/*', async (c) => c.json(await c.req.json()))

    const response = await app.request(
      `http://app.test/agents/elvanto/${conversationIdFor(live)}`,
      {
        method: 'POST',
        headers: { cookie: `elvanto_session=${live.id}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          kind: 'user',
          body: 'hello',
          initialData: { personId: 'person-1' },
        }),
      },
    )

    expect(response.status).toBe(200)
    // The guard clones to inspect; the agent router behind it must still be able
    // to read the body.
    await expect(response.json()).resolves.toMatchObject({ body: 'hello' })
  })

  test('turns away a session that has expired', async () => {
    const store = new MemorySessionStore()
    const stale = session({ expiresAt: Date.now() - 1 })
    await store.writeSession(stale)
    const app = await guarded(store)

    const response = await app.request(
      `http://app.test/agents/elvanto/${conversationIdFor(stale)}`,
      { headers: { cookie: `elvanto_session=${stale.id}` } },
    )

    expect(response.status).toBe(401)
  })
})

describe('the Durable Object session store', () => {
  /** Runs the real object class against an in-memory storage shim. */
  function namespace(): DurableObjectNamespaceLike {
    const map = new Map<string, unknown>()
    const storage = {
      get: async <T,>(key: string) => map.get(key) as T | undefined,
      put: async <T,>(key: string, value: T) => void map.set(key, value),
      delete: async (key: string) => map.delete(key),
      list: async <T,>(options?: { prefix?: string }) => {
        const out = new Map<string, T>()
        for (const [key, value] of map) {
          if (!options?.prefix || key.startsWith(options.prefix)) out.set(key, value as T)
        }
        return out
      },
    }
    const SessionObject = createSessionStoreClass()
    const instance = new SessionObject({ storage })
    return {
      idFromName: (name: string) => name,
      get: () => ({
        fetch: (input: string | URL, init?: RequestInit) =>
          instance.fetch(new Request(String(input), init)),
      }),
    }
  }

  test('round-trips sessions and grants through the object', async () => {
    const store = durableObjectSessionStore(namespace())
    const live = session()

    await store.writeSession(live)
    await store.write(live.personId, tokens)

    await expect(store.readSession(live.id)).resolves.toEqual(live)
    await expect(store.read(live.personId)).resolves.toEqual(tokens)
  })

  test('reads absent entries as undefined, not null', async () => {
    const store = durableObjectSessionStore(namespace())
    await expect(store.readSession('nope')).resolves.toBeUndefined()
    await expect(store.read('nobody')).resolves.toBeUndefined()
  })

  test('expires a session on read rather than serving it', async () => {
    const store = durableObjectSessionStore(namespace())
    const stale = session({ expiresAt: Date.now() - 1 })
    await store.writeSession(stale)

    await expect(store.readSession(stale.id)).resolves.toBeUndefined()
  })

  test('deleting a grant also drops the sessions that reach it', async () => {
    const store = durableObjectSessionStore(namespace())
    const one = session({ id: 's1' })
    const two = session({ id: 's2' })
    const other = session({ id: 's3', personId: 'person-9' })
    for (const s of [one, two, other]) await store.writeSession(s)
    await store.write('person-1', tokens)

    await store.delete('person-1')

    // A cookie that resolves to a person with no credentials is a signed-in user
    // whose every request fails — which reads as a broken deployment, not a
    // sign-out.
    await expect(store.readSession('s1')).resolves.toBeUndefined()
    await expect(store.readSession('s2')).resolves.toBeUndefined()
    await expect(store.readSession('s3')).resolves.toBeDefined()
  })

  test('separate sessions and grants never collide on a shared key', async () => {
    const store = durableObjectSessionStore(namespace())
    // A person id and a session id could be the same string; the object keys them
    // in separate namespaces so one cannot be read as the other.
    await store.writeSession(session({ id: 'shared', personId: 'shared' }))
    await store.write('shared', tokens)

    await expect(store.readSession('shared')).resolves.toMatchObject({ id: 'shared' })
    await expect(store.read('shared')).resolves.toEqual(tokens)
  })
})

describe('authOptionsFromEnv', () => {
  const store = new MemorySessionStore()

  test('returns undefined when nothing is configured', () => {
    expect(authOptionsFromEnv({ store, env: {} })).toBeUndefined()
  })

  test('builds options when all three secrets are present', () => {
    const options = authOptionsFromEnv({
      store,
      env: {
        ELVANTO_CLIENT_ID: 'id',
        ELVANTO_CLIENT_SECRET: 'secret',
        ELVANTO_SESSION_SECRET: STATE_SECRET,
      },
    })

    expect(options).toMatchObject({ clientId: 'id', clientSecret: 'secret' })
  })

  test('fails loudly when only some are set', () => {
    // Silently running unauthenticated because one variable was misspelled is the
    // failure worth being noisy about.
    expect(() =>
      authOptionsFromEnv({ store, env: { ELVANTO_CLIENT_ID: 'id' } }),
    ).toThrow(/ELVANTO_CLIENT_SECRET and ELVANTO_SESSION_SECRET are missing/)
  })
})
