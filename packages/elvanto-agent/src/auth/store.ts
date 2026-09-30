/**
 * Where a signed-in user's session and OAuth grant live on the server.
 *
 * ## Why this is not agent state
 *
 * Flue offers two tempting places to put this and both are wrong. `initialData`
 * and `usePersistentState` are the instance's durable record log, and Flue's own
 * reference says plainly that it "is still not a secrets channel — keys and
 * tokens stay in the environment". A refresh token written there is a standing
 * grant on the church's member database, appended to a log that outlives the
 * session and is replayed on every recovery.
 *
 * So the record log holds only the person's id — a lookup key, not a
 * credential — and the tokens live here, behind a binding that only server code
 * can reach.
 *
 * ## Why the session and the grant are keyed differently
 *
 * Sessions are keyed by an opaque cookie value and grants by the Elvanto person
 * id. Signing in again issues a new session but must reach the same grant, and
 * the agent — which knows who it is talking to but has never seen a cookie — has
 * to be able to find that grant from the person alone. Keying tokens by session
 * would make a re-login invisible to a conversation already in progress.
 */

import type { ElvantoTokens, TokenStore } from '@criticalcodes/elvanto'

/** A signed-in browser. Not secret in itself; the id in the cookie is. */
export interface ElvantoSession {
  /** Opaque, unguessable, and the only thing the cookie carries. */
  id: string
  /** Elvanto's person id for whoever signed in. Also the grant's key. */
  personId: string
  /** Display name, so the UI can greet without another API call. */
  name: string
  createdAt: number
  /** Epoch ms. Independent of the access token's much shorter life. */
  expiresAt: number
}

/**
 * Sessions plus grants.
 *
 * Extends {@link TokenStore} rather than wrapping one, so it drops straight into
 * `createTokenSource({ store, key: personId })` with no adapter.
 */
export interface SessionStore extends TokenStore {
  readSession(id: string): Promise<ElvantoSession | undefined>
  writeSession(session: ElvantoSession): Promise<void>
  deleteSession(id: string): Promise<void>
}

/**
 * A store in ordinary memory.
 *
 * Correct only where one process serves both the sign-in routes and the agent,
 * which is the Node target and `vite dev`. On Cloudflare the router and the agent
 * are separate isolates that share no memory, so this would sign a user in and
 * then lose them — {@link durableObjectSessionStore} exists for that.
 */
export class MemorySessionStore implements SessionStore {
  private readonly sessions = new Map<string, ElvantoSession>()
  private readonly grants = new Map<string, ElvantoTokens>()

  readSession(id: string): Promise<ElvantoSession | undefined> {
    const session = this.sessions.get(id)
    if (session && session.expiresAt <= Date.now()) {
      this.sessions.delete(id)
      return Promise.resolve(undefined)
    }
    return Promise.resolve(session)
  }

  writeSession(session: ElvantoSession): Promise<void> {
    this.sessions.set(session.id, session)
    return Promise.resolve()
  }

  deleteSession(id: string): Promise<void> {
    this.sessions.delete(id)
    return Promise.resolve()
  }

  read(key: string): Promise<ElvantoTokens | undefined> {
    return Promise.resolve(this.grants.get(key))
  }

  write(key: string, tokens: ElvantoTokens): Promise<void> {
    this.grants.set(key, tokens)
    return Promise.resolve()
  }

  delete(key: string): Promise<void> {
    this.grants.delete(key)
    return Promise.resolve()
  }
}

/* ---------------------------------------------------------------------------
 * The Durable Object backing
 * ------------------------------------------------------------------------ */

/**
 * Structural views of the Cloudflare types this needs.
 *
 * Declared rather than imported: `@cloudflare/workers-types` is a dev dependency
 * of the deployable app, not of this published toolkit, and importing
 * `cloudflare:workers` here would make the whole package unimportable on Node.
 * These are the four shapes actually touched, and a real binding satisfies them.
 */
export interface DurableObjectStorageLike {
  get<T>(key: string): Promise<T | undefined>
  put<T>(key: string, value: T): Promise<void>
  delete(key: string): Promise<boolean>
  list<T>(options?: { prefix?: string }): Promise<Map<string, T>>
}

export interface DurableObjectStateLike {
  storage: DurableObjectStorageLike
}

export interface DurableObjectStubLike {
  fetch(input: string | URL, init?: RequestInit): Promise<Response>
}

export interface DurableObjectNamespaceLike {
  idFromName(name: string): unknown
  get(id: unknown): DurableObjectStubLike
}

/**
 * The single object every session goes through.
 *
 * One instance, named rather than random: a Durable Object is single-threaded, so
 * routing every session to the same one makes reads and writes strongly
 * consistent and makes a refresh race impossible across isolates — which is the
 * property a token store actually needs and the one an eventually-consistent KV
 * namespace cannot give.
 */
export const SESSION_OBJECT_NAME = 'elvanto-sessions'

const SESSION_PREFIX = 'session:'
const GRANT_PREFIX = 'grant:'

/**
 * Builds the Durable Object class for the deployment to export.
 *
 * A factory rather than an exported class because a Worker's Durable Object
 * classes are top-level exports of its entrypoint, and which name they carry is
 * the deployment's business — it is written into `wrangler.jsonc` migrations and
 * cannot change afterwards without a migration.
 *
 * ```ts
 * // src/cloudflare.ts
 * export class ElvantoSessionStore extends createSessionStoreClass() {}
 * ```
 *
 * It speaks HTTP rather than RPC so that it needs no `cloudflare:workers` import
 * and stays a plain class this package can construct and test on Node.
 */
export function createSessionStoreClass(): new (
  state: DurableObjectStateLike,
  env?: unknown,
) => { fetch(request: Request): Promise<Response> } {
  return class ElvantoSessionStoreObject {
    readonly #storage: DurableObjectStorageLike

    constructor(state: DurableObjectStateLike) {
      this.#storage = state.storage
    }

    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url)
      const key = url.searchParams.get('key') ?? ''
      if (!key) return json({ error: 'missing key' }, 400)

      switch (`${request.method} ${url.pathname}`) {
        case 'GET /session': {
          const session = await this.#storage.get<ElvantoSession>(SESSION_PREFIX + key)
          // Expiry is enforced on read rather than by an alarm. A session that
          // is never read again costs one storage row; one that is read after
          // expiring must not work, and this is the path that decides that.
          if (session && session.expiresAt <= Date.now()) {
            await this.#storage.delete(SESSION_PREFIX + key)
            return json(null)
          }
          return json(session ?? null)
        }
        case 'PUT /session': {
          const session = (await request.json()) as ElvantoSession
          await this.#storage.put(SESSION_PREFIX + key, session)
          return json({ ok: true })
        }
        case 'DELETE /session': {
          await this.#storage.delete(SESSION_PREFIX + key)
          return json({ ok: true })
        }
        case 'GET /grant': {
          const tokens = await this.#storage.get<ElvantoTokens>(GRANT_PREFIX + key)
          return json(tokens ?? null)
        }
        case 'PUT /grant': {
          const tokens = (await request.json()) as ElvantoTokens
          await this.#storage.put(GRANT_PREFIX + key, tokens)
          return json({ ok: true })
        }
        case 'DELETE /grant': {
          await this.#storage.delete(GRANT_PREFIX + key)
          // Signing out of the grant invalidates every session that reaches it,
          // so drop them too. Leaving them would leave a cookie that resolves to
          // a person with no credentials — a signed-in user whose every request
          // fails, which reads as a broken deployment rather than a sign-out.
          const sessions = await this.#storage.list<ElvantoSession>({
            prefix: SESSION_PREFIX,
          })
          for (const [id, session] of sessions) {
            if (session.personId === key) await this.#storage.delete(id)
          }
          return json({ ok: true })
        }
        default:
          return json({ error: 'not found' }, 404)
      }
    }
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/**
 * A {@link SessionStore} over a Durable Object namespace binding.
 *
 * The host in the URL is a placeholder and never resolved — a Durable Object stub
 * routes by the stub, not by DNS — but `fetch` still requires a valid absolute
 * URL, so one is supplied.
 */
export function durableObjectSessionStore(
  namespace: DurableObjectNamespaceLike,
  objectName: string = SESSION_OBJECT_NAME,
): SessionStore {
  const stub = (): DurableObjectStubLike =>
    namespace.get(namespace.idFromName(objectName))

  const call = async (
    method: string,
    path: string,
    key: string,
    body?: unknown,
  ): Promise<unknown> => {
    const url = `https://elvanto-sessions.invalid${path}?key=${encodeURIComponent(key)}`
    const response = await stub().fetch(url, {
      method,
      ...(body !== undefined
        ? { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }
        : {}),
    })
    if (!response.ok) {
      throw new Error(`Session store ${method} ${path} failed: HTTP ${response.status}`)
    }
    return response.json()
  }

  return {
    async readSession(id) {
      return ((await call('GET', '/session', id)) as ElvantoSession | null) ?? undefined
    },
    async writeSession(session) {
      await call('PUT', '/session', session.id, session)
    },
    async deleteSession(id) {
      await call('DELETE', '/session', id)
    },
    async read(key) {
      return ((await call('GET', '/grant', key)) as ElvantoTokens | null) ?? undefined
    },
    async write(key, tokens) {
      await call('PUT', '/grant', key, tokens)
    },
    async delete(key) {
      await call('DELETE', '/grant', key)
    },
  }
}
