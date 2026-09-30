/**
 * Signing in from an agent binary.
 *
 * The terminal case is the mirror image of the deployed one. There, many people
 * share a process and each needs their own grant, so tokens are keyed by person
 * and looked up per conversation. Here there is exactly one person — the one at
 * the keyboard — so there is one grant, in the same file `elvanto login` writes,
 * and an agent binary can use it without depending on the CLI package.
 *
 * Node-only, and only ever imported from `./index.ts`: it reads the filesystem,
 * and the toolkit's main entry has to stay importable on Workers.
 */

import { stderr, stdout } from 'node:process'
import {
  ELVANTO_SCOPES,
  createTokenSource,
  type ElvantoScope,
  type TokenSource,
} from '@criticalcodes/elvanto'
import {
  DEFAULT_CALLBACK_PORT,
  FileTokenStore,
  REGISTER_APP_HELP,
  loginWithBrowser,
} from '@criticalcodes/elvanto/node'
import type { Env } from '../client.ts'

/** Which stored grant this process uses. */
export function profileKey(env: Env): string {
  return env['ELVANTO_PROFILE']?.trim() || 'default'
}

function storeFor(env: Env): FileTokenStore {
  return new FileTokenStore(env['ELVANTO_CREDENTIALS']?.trim() || undefined)
}

/**
 * The stored grant, as a token source, or `undefined`.
 *
 * Consulted only when neither `ELVANTO_API_KEY` nor `ELVANTO_ACCESS_TOKEN` is set.
 * An agent binary is usually launched from a shell or a `.env`, so an explicit
 * variable is a current instruction and wins — the reverse of the endpoint CLI,
 * where `login` is the more recent explicit act.
 *
 * Returns `undefined` rather than throwing on an unreadable credentials file. The
 * agent should still start and let the first tool call explain itself; dying
 * before the model exists turns a fixable configuration problem into a stack
 * trace.
 */
export function storedGrant(env: Env): TokenSource | undefined {
  if (env['ELVANTO_API_KEY']?.trim() || env['ELVANTO_ACCESS_TOKEN']?.trim()) {
    return undefined
  }

  const store = storeFor(env)
  const key = profileKey(env)
  try {
    if (!store.keys().includes(key)) return undefined
  } catch {
    return undefined
  }

  return createTokenSource({
    store,
    key,
    clientId: env['ELVANTO_CLIENT_ID']?.trim(),
    clientSecret: env['ELVANTO_CLIENT_SECRET']?.trim(),
    ...(env['ELVANTO_OAUTH_BASE_URL'] ? { baseUrl: env['ELVANTO_OAUTH_BASE_URL'] } : {}),
  })
}

/** `<name> login`. Returns a non-zero exit code on failure. */
export async function runLogin(
  args: { flags: Record<string, string | boolean> },
  env: Env,
): Promise<number> {
  const clientId = flag(args, 'client-id') ?? env['ELVANTO_CLIENT_ID']?.trim()
  const clientSecret = flag(args, 'client-secret') ?? env['ELVANTO_CLIENT_SECRET']?.trim()

  if (!clientId || !clientSecret) {
    stderr.write(
      `An OAuth client ID and secret are required to sign in.\n\n${REGISTER_APP_HELP}\n\n` +
        `Set ELVANTO_CLIENT_ID and ELVANTO_CLIENT_SECRET (a .env file is read), or\n` +
        `pass --client-id and --client-secret. Register the redirect URI as\n` +
        `http://127.0.0.1:${DEFAULT_CALLBACK_PORT}/callback\n`,
    )
    return 1
  }

  const scopes = parseScopes(flag(args, 'scope'))
  const port = flag(args, 'port')

  const tokens = await loginWithBrowser({
    clientId,
    clientSecret,
    ...(scopes ? { scopes } : {}),
    ...(port !== undefined ? { port: Number(port) } : {}),
    openBrowser: args.flags['no-browser'] !== true,
    output: { write: (text: string) => stderr.write(text) },
    ...(env['ELVANTO_OAUTH_BASE_URL'] ? { baseUrl: env['ELVANTO_OAUTH_BASE_URL'] } : {}),
  })

  const store = storeFor(env)
  const key = profileKey(env)
  await store.write(key, tokens)
  stdout.write(`Signed in. Grant stored in ${store.path} (profile "${key}").\n`)
  return 0
}

/** `<name> logout`. */
export async function runLogout(env: Env): Promise<number> {
  const store = storeFor(env)
  const key = profileKey(env)
  await store.delete(key)
  stdout.write(
    `Signed out of profile "${key}". The grant is still listed in Elvanto under ` +
      `Settings > Integrations until you revoke it there.\n`,
  )
  return 0
}

/** `<name> whoami` — which credential this binary would use, and why. */
export function runWhoami(env: Env): number {
  if (env['ELVANTO_API_KEY']?.trim()) {
    stdout.write(
      'Using: ELVANTO_API_KEY (an API key identifies the account, not a person).\n',
    )
    return 0
  }
  if (env['ELVANTO_ACCESS_TOKEN']?.trim()) {
    stdout.write('Using: ELVANTO_ACCESS_TOKEN.\n')
    return 0
  }

  const store = storeFor(env)
  const key = profileKey(env)
  let signedIn: boolean
  try {
    signedIn = store.keys().includes(key)
  } catch (error) {
    stderr.write(`Could not read ${store.path}: ${describe(error)}\n`)
    return 1
  }
  if (!signedIn) {
    stderr.write(
      'No credentials. Run `login` to sign in with OAuth, or set ELVANTO_API_KEY.\n',
    )
    return 1
  }

  stdout.write(
    `Using: stored grant (profile "${key}")\nCredentials file: ${store.path}\n`,
  )
  return 0
}

function flag(
  args: { flags: Record<string, string | boolean> },
  name: string,
): string | undefined {
  const value = args.flags[name]
  return typeof value === 'string' ? value : undefined
}

function parseScopes(value: string | undefined): ElvantoScope[] | undefined {
  if (!value) return undefined
  const parts = value
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
  for (const part of parts) {
    if (!(ELVANTO_SCOPES as readonly string[]).includes(part)) {
      throw new Error(
        `Unknown scope "${part}". Valid scopes: ${ELVANTO_SCOPES.join(', ')}.`,
      )
    }
  }
  return parts as ElvantoScope[]
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
