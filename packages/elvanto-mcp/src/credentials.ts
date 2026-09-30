/**
 * Reading the OAuth grant `elvanto login` left on disk.
 *
 * Imported only by `index.ts`, the executable — never by `lib.ts`. This reaches
 * the filesystem through `@criticalcodes/elvanto/node`, and the importable entry
 * has to stay mountable on Workers, where there is no file to read and no user
 * sitting in front of a browser to make one.
 */

import { createTokenSource, type ElvantoAuth } from '@criticalcodes/elvanto'
import { FileTokenStore } from '@criticalcodes/elvanto/node'

export interface StoredGrant {
  auth: ElvantoAuth
  /** Path the grant was read from, for the startup line. */
  path: string
  profile: string
}

/**
 * Builds credentials from a stored grant, if there is one.
 *
 * Returns `undefined` rather than throwing when there is nothing stored: an MCP
 * server with no credentials still starts and lists its tools, which is the
 * behaviour {@link planStartup} documents and the reason a misconfigured server
 * shows up in a client as one whose calls explain themselves.
 *
 * An explicit `ELVANTO_API_KEY` or `ELVANTO_ACCESS_TOKEN` wins. That is the
 * opposite of the CLI's precedence, and deliberately: an MCP server is launched
 * by a client from a configuration file that names its environment explicitly, so
 * a variable set there is a current instruction rather than a stale shell export.
 */
export function storedGrant(
  env: Record<string, string | undefined> = process.env,
): StoredGrant | undefined {
  if (env['ELVANTO_API_KEY']?.trim() || env['ELVANTO_ACCESS_TOKEN']?.trim()) {
    return undefined
  }

  const profile = env['ELVANTO_PROFILE']?.trim() || 'default'
  const store = new FileTokenStore(env['ELVANTO_CREDENTIALS']?.trim() || undefined)

  let hasGrant = false
  try {
    hasGrant = store.keys().includes(profile)
  } catch {
    // A corrupt or unreadable credentials file must not stop the server from
    // starting. Falling through leaves it with no credentials, and the first
    // tool call says so — which reaches the operator, whereas a process that
    // died before the handshake does not.
    return undefined
  }
  if (!hasGrant) return undefined

  return {
    profile,
    path: store.path,
    auth: {
      getAccessToken: createTokenSource({
        store,
        key: profile,
        clientId: env['ELVANTO_CLIENT_ID']?.trim(),
        clientSecret: env['ELVANTO_CLIENT_SECRET']?.trim(),
        ...(env['ELVANTO_OAUTH_BASE_URL']
          ? { baseUrl: env['ELVANTO_OAUTH_BASE_URL'] }
          : {}),
      }).getAccessToken,
    },
  }
}
