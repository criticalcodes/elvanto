import type { Context, MiddlewareHandler } from 'hono'

/**
 * A shared-secret guard for an agent's HTTP surface.
 *
 * Flue mounts agents with no authentication at all, by design — "anyone who can
 * reach a conversation URL can talk to that conversation: send it messages, read
 * its full history, abort its work". For an agent that reads a church's member
 * database that is not a small gap, so {@link elvantoRoutes} fails closed rather
 * than serving without one.
 *
 * ## What this is, and what it is not
 *
 * One shared token, not a user system. Everyone who holds it is equally
 * authenticated, which is proportionate for an office tool where the audience is
 * "staff" and there is nothing per-person to authorize.
 *
 * It therefore does **not** give you the second check Flue's routing guide asks
 * for: conversation ids are caller-chosen path segments, so anyone with the token
 * can read any conversation by guessing its id — including a scheduled compliance
 * sweep. That is acceptable when every token-holder is allowed to see everything,
 * and unacceptable the moment they are not. If you need per-user access, put real
 * identity in front of this (see the README on Cloudflare Access) and pass
 * `auth: 'external'`.
 *
 * ## Why a cookie as well as a bearer
 *
 * A browser cannot send an `Authorization` header on a plain navigation, so a
 * token-only guard would make the chat page unreachable without embedding the
 * secret in the page — which puts it in history, bookmarks and referrers. The
 * login form trades the token once for a signed, HttpOnly cookie instead.
 */

/** How long a browser session lasts before the token is needed again. */
const SESSION_SECONDS = 12 * 60 * 60
const COOKIE = 'elvanto_agent_session'

export type AuthMode =
  /** Require the shared token, by bearer header or session cookie. */
  | { token: string }
  /**
   * Trust the edge. Only correct when something in front — Cloudflare Access, an
   * authenticating proxy, a private network — has already established who the
   * caller is. Deliberately verbose to type, because the failure mode of choosing
   * it wrongly is an open door.
   */
  | 'external'

/**
 * Constant-time string comparison.
 *
 * Hand-rolled because `crypto.timingSafeEqual` is Node-only and this runs on
 * Workers too. Length is compared first and leaks only the length.
 */
function equals(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let difference = 0
  for (let index = 0; index < a.length; index++) {
    difference |= a.charCodeAt(index) ^ b.charCodeAt(index)
  }
  return difference === 0
}

const encoder = new TextEncoder()

async function sign(value: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(value))
  return btoa(String.fromCharCode(...new Uint8Array(signature)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

/** `<expiry>.<hmac>` — no identity to carry, so the payload is just a deadline. */
async function mintSession(secret: string, now: number): Promise<string> {
  const expiry = String(now + SESSION_SECONDS * 1000)
  return `${expiry}.${await sign(expiry, secret)}`
}

async function sessionValid(cookie: string, secret: string, now: number): Promise<boolean> {
  const [expiry, signature] = cookie.split('.')
  if (!expiry || !signature) return false
  // Expiry is checked *after* the signature, so an attacker cannot learn anything
  // by varying it.
  if (!equals(signature, await sign(expiry, secret))) return false
  const deadline = Number(expiry)
  return Number.isFinite(deadline) && deadline > now
}

function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=')
    if (key === name) return rest.join('=')
  }
  return undefined
}

/** Whether the request is already authenticated. */
export async function isAuthorized(c: Context, token: string, now = Date.now()): Promise<boolean> {
  const header = c.req.header('authorization')
  const bearer = header ? /^Bearer[ ]+(.+)$/i.exec(header.trim())?.[1] : undefined
  if (bearer && equals(bearer, token)) return true

  const cookie = readCookie(c.req.header('cookie'), COOKIE)
  return cookie ? sessionValid(cookie, token, now) : false
}

/**
 * Middleware requiring the token.
 *
 * An API client is answered with 401 and a JSON body; a browser navigation is
 * redirected to the login form, because a bare 401 in a browser is a dead end.
 */
export function requireToken(token: string): MiddlewareHandler {
  return async (c, next) => {
    if (await isAuthorized(c, token)) return next()

    const wantsHtml = (c.req.header('accept') ?? '').includes('text/html')
    if (wantsHtml && c.req.method === 'GET') {
      return c.redirect(`/login?next=${encodeURIComponent(c.req.path)}`, 302)
    }
    return c.json({ error: 'unauthorized' }, 401, { 'www-authenticate': 'Bearer' })
  }
}

/** The login form, and the handler that exchanges a token for a session cookie. */
export function loginRoutes(token: string): {
  page: (c: Context) => Response
  submit: (c: Context) => Promise<Response>
} {
  return {
    page: (c) => {
      const next = c.req.query('next') ?? '/'
      const failed = c.req.query('failed') === '1'
      return c.html(loginPage(next, failed))
    },

    submit: async (c) => {
      const form = await c.req.formData()
      const supplied = String(form.get('token') ?? '')
      const next = String(form.get('next') ?? '/')

      if (!equals(supplied, token)) {
        // No detail about why, and no distinction between empty and wrong.
        return c.redirect(`/login?failed=1&next=${encodeURIComponent(next)}`, 302)
      }

      const session = await mintSession(token, Date.now())

      // Built explicitly rather than by mutating a `c.redirect()` response:
      // `headers.append` returns void, so returning its result yields `undefined`
      // and the cookie is silently never set. A cast hid exactly that once.
      //
      // HttpOnly so page scripts cannot read it; SameSite=Lax so it survives a
      // normal navigation but not a cross-site POST. `Secure` only when the
      // request arrived over HTTPS, so local development on plain HTTP still works
      // while a real deployment gets the flag.
      const secure = new URL(c.req.url).protocol === 'https:' ? ' Secure;' : ''
      return new Response(null, {
        status: 302,
        headers: {
          location: sanitizeNext(next),
          'set-cookie':
            `${COOKIE}=${session}; HttpOnly;${secure} SameSite=Lax; Path=/; ` +
            `Max-Age=${SESSION_SECONDS}`,
        },
      })
    },
  }
}

/**
 * Keeps `?next=` from becoming an open redirect.
 *
 * Only a same-origin absolute path is honoured; anything else falls back to the
 * root. A login page that will bounce a visitor to an arbitrary URL is a phishing
 * primitive, and this one is reachable unauthenticated by definition.
 */
function sanitizeNext(next: string): string {
  return next.startsWith('/') && !next.startsWith('//') ? next : '/'
}

function loginPage(next: string, failed: boolean): string {
  const escaped = next.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  )
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sign in</title>
<style>
  :root { color-scheme: light dark; --bg:#fbfbfa; --fg:#1a1a18; --line:#e4e4e0; --card:#fff; --accent:#3d6b52; --muted:#6b6b66; }
  @media (prefers-color-scheme: dark) { :root { --bg:#17181a; --fg:#e8e8e4; --line:#2c2d30; --card:#1d1e21; --accent:#7fb096; --muted:#97978f; } }
  body { margin:0; min-height:100dvh; display:grid; place-items:center; background:var(--bg); color:var(--fg);
         font:15px/1.6 ui-sans-serif,-apple-system,"Segoe UI",system-ui,sans-serif; }
  form { background:var(--card); border:1px solid var(--line); border-radius:.7rem; padding:1.6rem; width:min(22rem,90vw); }
  h1 { font-size:1rem; margin:0 0 .3rem; }
  p { color:var(--muted); font-size:.85rem; margin:0 0 1.1rem; }
  label { display:block; font-size:.8rem; margin-bottom:.3rem; }
  input { width:100%; font:inherit; color:inherit; background:transparent; border:1px solid var(--line);
          border-radius:.45rem; padding:.5rem .6rem; margin-bottom:.9rem; }
  button { width:100%; font:inherit; font-weight:550; border:0; border-radius:.45rem; padding:.55rem;
           background:var(--accent); color:#fff; cursor:pointer; }
  .error { color:#b4553f; font-size:.85rem; margin:0 0 .9rem; }
</style>
</head>
<body>
<form method="post" action="/login">
  <h1>Sign in</h1>
  <p>This assistant can read member records. Access needs the shared access token.</p>
  ${failed ? '<p class="error">That token was not accepted.</p>' : ''}
  <label for="token">Access token</label>
  <input id="token" name="token" type="password" autocomplete="current-password" autofocus required>
  <input type="hidden" name="next" value="${escaped}">
  <button type="submit">Sign in</button>
</form>
</body>
</html>`
}

/** The page shown when no token is configured, in place of an open agent. */
export function unconfiguredPage(variable: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Not configured</title>
<style>body{font:15px/1.6 ui-sans-serif,system-ui,sans-serif;max-width:34rem;margin:4rem auto;padding:0 1rem;color-scheme:light dark}code{background:#8883;padding:.1rem .3rem;border-radius:.2rem}</style>
</head><body>
<h1>Not configured</h1>
<p>This agent is not serving, because no access token is set. It can read every
member record in the Elvanto account, so it does not run an open endpoint.</p>
<p>Set <code>${variable}</code> and restart. To rely on authentication in front of
this instead — Cloudflare Access, an authenticating proxy — pass
<code>auth: 'external'</code> when mounting the routes.</p>
</body></html>`
}
