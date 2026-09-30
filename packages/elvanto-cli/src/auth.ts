import { Command, Option } from 'commander'
import {
  ELVANTO_SCOPES,
  DEFAULT_SCOPES,
  ElvantoClient,
  ElvantoError,
  ElvantoOAuthError,
  authorizeUrl,
  createState,
  createTokenSource,
  exchangeCode,
  randomToken,
  readState,
  type ElvantoScope,
  type ElvantoTokens,
  type TokenSource,
  type TokenStore,
} from '@criticalcodes/elvanto'
import {
  DEFAULT_CALLBACK_PORT,
  FileTokenStore,
  REGISTER_APP_HELP,
  defaultCredentialsPath,
  loginWithBrowser,
} from '@criticalcodes/elvanto/node'
import { UsageError } from './options.js'

export { DEFAULT_CALLBACK_PORT, REGISTER_APP_HELP }

/**
 * The store key this CLI owns.
 *
 * One grant per machine, not one per account: the flow signs a person in, and a
 * person belongs to one Elvanto account. `ELVANTO_PROFILE` exists for the case
 * this does not cover — someone who works across two churches — and keeps their
 * grants in separate entries of the same file.
 */
export function profileKey(
  env: Record<string, string | undefined> = process.env,
): string {
  return env['ELVANTO_PROFILE']?.trim() || 'default'
}

interface LoginOptions {
  clientId?: string
  clientSecret?: string
  scope?: string[]
  port?: number
  browser?: boolean
  baseUrl?: string
}

/** Adds `login`, `logout` and `whoami` to the program. */
export function attachAuthCommands(program: Command): void {
  program
    .command('login')
    .description('Sign in to Elvanto with OAuth and store the grant.')
    .addOption(
      new Option('--client-id <id>', 'OAuth application client ID.').env(
        'ELVANTO_CLIENT_ID',
      ),
    )
    .addOption(
      new Option('--client-secret <secret>', 'OAuth application client secret.').env(
        'ELVANTO_CLIENT_SECRET',
      ),
    )
    .addOption(
      new Option(
        '--scope <scopes...>',
        `Permissions to request. Default: ${DEFAULT_SCOPES.join(',')}. ` +
          `Valid: ${ELVANTO_SCOPES.join(', ')}.`,
      ).argParser(collectScopes),
    )
    .addOption(
      new Option(
        '--port <number>',
        `Loopback port for the redirect. Default ${DEFAULT_CALLBACK_PORT}; must ` +
          `match the redirect URI registered on the application.`,
      ).argParser(Number),
    )
    .addOption(new Option('--no-browser', 'Print the URL instead of opening it.'))
    .addHelpText(
      'after',
      `\n${REGISTER_APP_HELP}\n\n` +
        `Register the redirect URI as http://127.0.0.1:${DEFAULT_CALLBACK_PORT}/callback\n\n` +
        `Every Elvanto scope is write-capable — there is no read-only one — so the\n` +
        `token this stores can do more than this CLI ever does with it. The default\n` +
        `set omits ManageFinancials and AdministerAccount.`,
    )
    .action(async (options: LoginOptions, self: Command) => {
      await login(options, self)
    })

  program
    .command('logout')
    .description('Forget the stored OAuth grant.')
    .action(() => {
      const store = new FileTokenStore()
      const key = profileKey()
      void store.delete(key)
      process.stdout.write(
        `Signed out of profile "${key}". The grant is still listed in Elvanto ` +
          `under Settings > Integrations until you revoke it there.\n`,
      )
    })

  program
    .command('whoami')
    .description('Show which credentials are in use, and who they belong to.')
    .action(async (_options: unknown, self: Command) => {
      await whoami(self)
    })
}

function collectScopes(value: string, previous: string[] | undefined): string[] {
  const parts = value
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
  for (const part of parts) {
    if (!(ELVANTO_SCOPES as readonly string[]).includes(part)) {
      throw new UsageError(
        `Unknown scope "${part}". Valid scopes: ${ELVANTO_SCOPES.join(', ')}.`,
      )
    }
  }
  return [...(previous ?? []), ...parts]
}

async function login(options: LoginOptions, command: Command): Promise<void> {
  const clientId = options.clientId?.trim()
  const clientSecret = options.clientSecret?.trim()
  if (!clientId || !clientSecret) {
    throw new UsageError(
      `An OAuth client ID and secret are required to sign in.\n\n${REGISTER_APP_HELP}`,
    )
  }

  const globals = command.optsWithGlobals() as { baseUrl?: string }

  const tokens = await loginWithBrowser({
    clientId,
    clientSecret,
    ...(options.scope ? { scopes: options.scope as ElvantoScope[] } : {}),
    ...(options.port !== undefined ? { port: options.port } : {}),
    openBrowser: options.browser !== false,
    output: { write: (text: string) => process.stderr.write(text) },
    ...(process.env['ELVANTO_OAUTH_BASE_URL']
      ? { baseUrl: process.env['ELVANTO_OAUTH_BASE_URL'] }
      : {}),
  })

  const store = new FileTokenStore()
  const key = profileKey()
  await store.write(key, tokens)

  process.stdout.write(`Signed in. Grant stored in ${store.path} (profile "${key}").\n`)

  // Name who was signed in, which is the only confirmation that means anything —
  // and the first real exercise of people.currentUser, which an API key cannot
  // call at all. A failure here does not undo the grant, so it is reported and
  // not thrown.
  try {
    const client = new ElvantoClient({
      auth: { accessToken: tokens.accessToken },
      validate: 'warn',
      ...(globals.baseUrl ? { baseUrl: globals.baseUrl } : {}),
    })
    const person = await client.people.currentUser()
    const name = [person?.firstname, person?.lastname].filter(Boolean).join(' ')
    if (name) process.stdout.write(`Signed in as ${name}.\n`)
  } catch (error) {
    process.stderr.write(
      `Note: could not read your user record (${
        error instanceof Error ? error.message : String(error)
      }). The grant is stored and should still work.\n`,
    )
  }
}

/** Which credentials a command would use, and why. */
export interface ResolvedCredentials {
  kind: 'api-key' | 'access-token' | 'oauth'
  source: string
  tokens?: TokenSource
}

/**
 * Decides what to authenticate with.
 *
 * The order is deliberate, and the one judgement call in it is that a stored
 * grant beats `ELVANTO_API_KEY` in the environment. Signing in is a recent,
 * explicit act; an exported environment variable is often neither, and having
 * `elvanto login` appear to do nothing because a variable was set in a shell
 * profile months ago is the worse failure. An explicit flag still wins over
 * both, and `whoami` says which is in play.
 */
export function resolveCredentials(options: {
  apiKey?: string | undefined
  apiKeyFromFlag: boolean
  token?: string | undefined
  tokenFromFlag: boolean
  store?: TokenStore
  storedTokens?: ElvantoTokens | undefined
  env?: Record<string, string | undefined>
}): ResolvedCredentials {
  const env = options.env ?? process.env

  if (options.apiKeyFromFlag && options.apiKey) {
    return { kind: 'api-key', source: '--api-key' }
  }
  if (options.tokenFromFlag && options.token) {
    return { kind: 'access-token', source: '--token' }
  }

  if (options.storedTokens) {
    const store = options.store ?? new FileTokenStore()
    const key = profileKey(env)
    return {
      kind: 'oauth',
      source: `stored grant (profile "${key}")`,
      tokens: createTokenSource({
        store,
        key,
        clientId: env['ELVANTO_CLIENT_ID']?.trim(),
        clientSecret: env['ELVANTO_CLIENT_SECRET']?.trim(),
        ...(env['ELVANTO_OAUTH_BASE_URL'] ? { baseUrl: env['ELVANTO_OAUTH_BASE_URL'] } : {}),
      }),
    }
  }

  if (options.apiKey) return { kind: 'api-key', source: 'ELVANTO_API_KEY' }
  if (options.token) return { kind: 'access-token', source: 'ELVANTO_ACCESS_TOKEN' }

  throw new ElvantoError(
    'No Elvanto credentials. Run `elvanto login` to sign in with OAuth, or set ' +
      'ELVANTO_API_KEY (Settings > Account Settings > Secret API Key).',
  )
}

async function whoami(command: Command): Promise<void> {
  const store = new FileTokenStore()
  const key = profileKey()
  const stored = await store.read(key)
  const globals = command.optsWithGlobals() as { apiKey?: string; token?: string; baseUrl?: string }
  const parent = command.parent!

  const credentials = resolveCredentials({
    apiKey: globals.apiKey,
    apiKeyFromFlag: parent.getOptionValueSource('apiKey') === 'cli',
    token: globals.token,
    tokenFromFlag: parent.getOptionValueSource('token') === 'cli',
    store,
    storedTokens: stored,
  })

  process.stdout.write(`Using: ${credentials.source}\n`)
  if (stored) {
    const expiry = new Date(stored.expiresAt)
    process.stdout.write(
      `Credentials file: ${store.path}\n` +
        `Scopes: ${stored.scopes.length > 0 ? stored.scopes.join(', ') : 'not reported by Elvanto'}\n` +
        `Access token expires: ${expiry.toISOString()}` +
        `${stored.expiresAt <= Date.now() ? ' (expired; will refresh on next call)' : ''}\n`,
    )
  }

  if (credentials.kind !== 'oauth') {
    process.stdout.write(
      '\npeople/currentUser needs OAuth — an API key identifies an account rather ' +
        'than a user, so there is no "who" to report. Run `elvanto login` to sign in.\n',
    )
    return
  }

  const client = new ElvantoClient({
    auth: { getAccessToken: credentials.tokens!.getAccessToken },
    validate: 'warn',
    ...(globals.baseUrl ? { baseUrl: globals.baseUrl } : {}),
  })
  const person = await client.people.currentUser()
  const name = [person?.firstname, person?.lastname].filter(Boolean).join(' ')
  process.stdout.write(`Signed in as: ${name || '(name unavailable)'}\n`)
}

export { FileTokenStore, defaultCredentialsPath }
