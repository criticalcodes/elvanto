import { describe, expect, test } from 'vitest'
import { elvantoRoutes, DEFAULT_TOKEN_VARIABLE } from '../src/routes.ts'
import { clientFromEnv } from '../src/client.ts'

/**
 * A minimal agent stand-in.
 *
 * `createAgentRouter` only needs something with an identity to mount; none of these
 * tests reach the model, because every one of them is about whether a request gets
 * past the guard at all.
 */
function fakeAgent() {
  const agent = function Church() {
    return 'test'
  }
  return agent as unknown as Parameters<typeof elvantoRoutes>[0]['agent']
}

const TOKEN = 'a-shared-office-token'

function app(overrides: Partial<Parameters<typeof elvantoRoutes>[0]> = {}) {
  return elvantoRoutes({
    agent: fakeAgent(),
    env: { [DEFAULT_TOKEN_VARIABLE]: TOKEN },
    ...overrides,
  })
}

const get = (a: ReturnType<typeof app>, path: string, headers: Record<string, string> = {}) =>
  a.request(path, { headers })

describe('failing closed', () => {
  test('with no token configured, the agent is not mounted at all', async () => {
    // The default that matters: behind this agent is every member record in the
    // account, so an unconfigured deployment must not be an open one.
    const bare = elvantoRoutes({ agent: fakeAgent(), env: {} })

    for (const path of ['/', '/agents/church/web', '/agents/church/x/abort']) {
      const response = await bare.request(path)
      expect(response.status, path).toBe(503)
    }
  })

  test('the unconfigured page names the variable to set', async () => {
    const bare = elvantoRoutes({ agent: fakeAgent(), env: {} })
    const body = await (await bare.request('/')).text()
    expect(body).toContain(DEFAULT_TOKEN_VARIABLE)
    expect(body).toContain("auth: 'external'")
  })

  test('a blank token counts as no token', async () => {
    // Otherwise `ELVANTO_AGENT_TOKEN=` in a compose file reads as configured while
    // accepting `Bearer `.
    const blank = elvantoRoutes({ agent: fakeAgent(), env: { [DEFAULT_TOKEN_VARIABLE]: '   ' } })
    expect((await blank.request('/')).status).toBe(503)
  })
})

describe('the token guard', () => {
  test('rejects an unauthenticated API request', async () => {
    const response = await get(app(), '/agents/church/web')
    expect(response.status).toBe(401)
    expect(response.headers.get('www-authenticate')).toBe('Bearer')
  })

  test('accepts a correct bearer token', async () => {
    // 404 rather than 401: past the guard, into the agent router, which reports no
    // such conversation yet. Getting *through* is the assertion.
    const response = await get(app(), '/agents/church/web', {
      authorization: `Bearer ${TOKEN}`,
    })
    expect(response.status).not.toBe(401)
  })

  test('rejects a wrong token of the same length', async () => {
    // Equal lengths take the constant-time compare path rather than the early
    // length return, so this exercises the comparison itself.
    const wrong = 'a'.repeat(TOKEN.length)
    expect(wrong.length).toBe(TOKEN.length)
    const response = await get(app(), '/agents/church/web', { authorization: `Bearer ${wrong}` })
    expect(response.status).toBe(401)
  })

  test('rejects malformed authorization headers', async () => {
    for (const header of ['Bearer', 'Basic ' + TOKEN, TOKEN, 'Bearer  ', '']) {
      const response = await get(app(), '/agents/church/web', { authorization: header })
      expect(response.status, JSON.stringify(header)).toBe(401)
    }
  })

  test('guards every route the agent router serves, not just the root', async () => {
    // The mount pattern ends in /*, so prompts, reads, aborts and attachment
    // downloads are all covered.
    for (const path of [
      '/agents/church/web',
      '/agents/church/web/abort',
      '/agents/church/web/attachments/x',
    ]) {
      const response = await get(app(), path)
      expect(response.status, path).toBe(401)
    }
  })

  test('guards the chat page too', async () => {
    const response = await get(app(), '/')
    // A browser gets bounced to the form rather than a dead 401.
    expect([302, 401]).toContain(response.status)
  })

  test('a browser navigation is redirected to the login form', async () => {
    const response = await get(app(), '/', { accept: 'text/html' })
    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toContain('/login')
  })
})

describe('login', () => {
  test('the form is reachable without being signed in', async () => {
    // Otherwise signing in would require being signed in.
    const response = await get(app(), '/login')
    expect(response.status).toBe(200)
    expect(await response.text()).toContain('Access token')
  })

  test('a correct token sets an HttpOnly session cookie', async () => {
    const body = new URLSearchParams({ token: TOKEN, next: '/' })
    const response = await app().request('/login', { method: 'POST', body })

    const cookie = response.headers.get('set-cookie') ?? ''
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('SameSite=Lax')
    // The secret itself must never be the cookie value.
    expect(cookie).not.toContain(TOKEN)
  })

  test('the session cookie then authenticates a request', async () => {
    const login = await app().request('/login', {
      method: 'POST',
      body: new URLSearchParams({ token: TOKEN, next: '/' }),
    })
    const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0]!

    const response = await get(app(), '/agents/church/web', { cookie })
    expect(response.status).not.toBe(401)
  })

  test('a forged cookie is rejected', async () => {
    // Signed, so a plausible-looking expiry is not enough.
    const forged = `elvanto_agent_session=${Date.now() + 999999}.notavalidsignature`
    const response = await get(app(), '/agents/church/web', { cookie: forged })
    expect(response.status).toBe(401)
  })

  test('a wrong token does not sign in, and says nothing about why', async () => {
    const response = await app().request('/login', {
      method: 'POST',
      body: new URLSearchParams({ token: 'nope', next: '/' }),
    })
    expect(response.headers.get('set-cookie')).toBeNull()
    expect(response.headers.get('location')).toContain('failed=1')
  })

  test('the next parameter cannot become an open redirect', async () => {
    // The login page is reachable unauthenticated by definition, so a redirect it
    // will follow anywhere is a phishing primitive.
    for (const next of ['https://evil.example', '//evil.example', 'javascript:alert(1)']) {
      const response = await app().request('/login', {
        method: 'POST',
        body: new URLSearchParams({ token: TOKEN, next }),
      })
      expect(response.headers.get('location'), next).toBe('/')
    }
  })

  test('a same-origin path is honoured', async () => {
    const response = await app().request('/login', {
      method: 'POST',
      body: new URLSearchParams({ token: TOKEN, next: '/?id=office' }),
    })
    expect(response.headers.get('location')).toBe('/?id=office')
  })
})

describe("auth: 'external'", () => {
  test('mounts no guard, for when something in front authenticates', async () => {
    const external = elvantoRoutes({ agent: fakeAgent(), auth: 'external', env: {} })
    const response = await external.request('/')
    // Serves the chat page directly — the caller has taken responsibility.
    expect(response.status).toBe(200)
    expect(await response.text()).toContain('<!doctype html>')
  })

  test('has to be asked for explicitly — an absent token does not imply it', async () => {
    // The whole point: forgetting to configure auth must not look like choosing
    // to delegate it.
    const unset = elvantoRoutes({ agent: fakeAgent(), env: {} })
    expect((await unset.request('/')).status).toBe(503)
  })
})

describe('chatUi: false', () => {
  test('serves the API but no page', async () => {
    const api = app({ chatUi: false })
    expect((await get(api, '/', { accept: 'text/html' })).status).not.toBe(200)
    // The agent routes are still mounted and still guarded.
    expect((await get(api, '/agents/church/web')).status).toBe(401)
  })
})

describe('the client is not built at mount time', () => {
  test('mounting routes needs no credentials', () => {
    // Same reasoning as the agent render: a missing ELVANTO_API_KEY must not stop
    // the server coming up, or the operator gets a dead port instead of an error
    // they can read.
    expect(() => app()).not.toThrow()
    expect(() => clientFromEnv({})).toThrow()
  })
})
