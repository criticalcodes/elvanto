/**
 * The parts of this library that need a filesystem.
 *
 * A separate entry point (`@criticalcodes/elvanto/node`) rather than part of the
 * main one, because the main one has to stay importable on Cloudflare Workers,
 * where `node:fs` does not exist. Nothing here is needed to *use* the API — only
 * to keep an OAuth grant between runs of a command.
 */

import { spawn } from 'node:child_process'
import { chmodSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { ElvantoError } from './errors.js'
import {
  DEFAULT_SCOPES,
  ElvantoOAuthError,
  authorizeUrl,
  createState,
  exchangeCode,
  randomToken,
  readState,
  type ElvantoScope,
  type ElvantoTokens,
  type TokenStore,
} from './oauth.js'

/** Owner read/write only. A refresh token is a standing grant on the account. */
const FILE_MODE = 0o600
const DIRECTORY_MODE = 0o700

/**
 * Where credentials live by default.
 *
 * `ELVANTO_CREDENTIALS` wins, then `XDG_CONFIG_HOME`, then `~/.config`. The XDG
 * variable is honoured on macOS too: it is not the platform convention there, but
 * someone who has set it has said where their configuration goes, and quietly
 * writing somewhere else is the wrong way to disagree.
 */
export function defaultCredentialsPath(
  env: Record<string, string | undefined> = process.env,
): string {
  const explicit = env['ELVANTO_CREDENTIALS']?.trim()
  if (explicit) return explicit

  const xdg = env['XDG_CONFIG_HOME']?.trim()
  const base = xdg && xdg.startsWith('/') ? xdg : join(homedir(), '.config')
  return join(base, 'elvanto', 'credentials.json')
}

interface CredentialsFile {
  version: 1
  entries: Record<string, ElvantoTokens>
}

/**
 * Token storage in a JSON file, mode 0600 in a 0700 directory.
 *
 * This is the one place in the repository that writes a credential to disk, and
 * it is worth saying why, because the smoke test's documentation goes out of its
 * way to say a *API key* should not live in a file. The two are not the same
 * trade. An API key is account-wide, permanent until someone rotates it by hand,
 * and needed once in a while — so asking for it per invocation costs little. A
 * refresh token belongs to one user, can be revoked from Elvanto's own settings,
 * and is needed on every single command; keeping it out of a file would mean
 * re-running a browser flow to list a roster.
 *
 * It is still a credential on disk. The permissions are enforced on every write,
 * not just at creation, so a file that has been loosened is tightened again
 * rather than trusted.
 */
export class FileTokenStore implements TokenStore {
  readonly path: string

  constructor(path: string = defaultCredentialsPath()) {
    this.path = path
  }

  // These are `async` rather than returning `Promise.resolve(...)` so that a
  // failure below arrives as a rejection. The file work is synchronous, and a
  // Promise-returning method that throws synchronously slips past every caller
  // that reaches for `.catch()`.
  async read(key: string): Promise<ElvantoTokens | undefined> {
    return this.load().entries[key]
  }

  async write(key: string, tokens: ElvantoTokens): Promise<void> {
    const file = this.load()
    file.entries[key] = tokens
    this.save(file)
  }

  async delete(key: string): Promise<void> {
    const file = this.load()
    if (!(key in file.entries)) return
    delete file.entries[key]
    this.save(file)
  }

  /** Every key held, for a `whoami` or a `logout --all`. */
  keys(): string[] {
    return Object.keys(this.load().entries)
  }

  private load(): CredentialsFile {
    let text: string
    try {
      text = readFileSync(this.path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { version: 1, entries: {} }
      }
      throw new ElvantoError(
        `Could not read ${this.path}: ${(error as Error).message}`,
        { cause: error },
      )
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      // Refuse rather than silently starting fresh. Overwriting would destroy a
      // working grant on the strength of one stray byte, and a surprise trip
      // through the browser flow is worse than an error that says what to fix.
      throw new ElvantoError(
        `${this.path} is not valid JSON. Fix or delete it, then authorize again.`,
      )
    }

    if (
      !parsed ||
      typeof parsed !== 'object' ||
      typeof (parsed as CredentialsFile).entries !== 'object' ||
      (parsed as CredentialsFile).entries === null
    ) {
      throw new ElvantoError(
        `${this.path} does not look like an Elvanto credentials file. Delete it, then authorize again.`,
      )
    }

    return { version: 1, entries: { ...(parsed as CredentialsFile).entries } }
  }

  private save(file: CredentialsFile): void {
    const directory = dirname(this.path)
    mkdirSync(directory, { recursive: true, mode: DIRECTORY_MODE })

    // Write beside the target and rename over it, so a crash mid-write leaves the
    // previous grant intact rather than a truncated file that reads as corrupt.
    // The temporary file is created with the final mode, never a default one, so
    // the token is never briefly world-readable.
    const temporary = `${this.path}.${process.pid}.tmp`
    try {
      writeFileSync(temporary, `${JSON.stringify(file, null, 2)}\n`, {
        encoding: 'utf8',
        mode: FILE_MODE,
      })
      // `writeFileSync`'s mode is masked by the process umask and ignored outright
      // if the file already existed, so set it explicitly rather than assume.
      chmodSync(temporary, FILE_MODE)
      renameSync(temporary, this.path)
    } catch (error) {
      try {
        unlinkSync(temporary)
      } catch {
        // The failure being reported is the write, not the cleanup.
      }
      throw new ElvantoError(
        `Could not write ${this.path}: ${(error as Error).message}`,
        { cause: error },
      )
    }
  }
}

/* ---------------------------------------------------------------------------
 * Signing in from a terminal
 * ------------------------------------------------------------------------ */

/**
 * The loopback port the browser is redirected back to.
 *
 * Fixed rather than ephemeral, and that is forced on us: Elvanto matches the
 * redirect URI against the one registered on the application, so a port chosen at
 * random would fail every time but the once. Register
 * `http://127.0.0.1:8975/callback` on the Elvanto side, or pass `port` to match
 * whatever you did register.
 */
export const DEFAULT_CALLBACK_PORT = 8975

export const REGISTER_APP_HELP =
  'Register an OAuth application in Elvanto under Settings > Integrations, then ' +
  'supply its client ID and secret. Elvanto has no PKCE, so exchanging a code ' +
  'needs the secret and there is no shared application to use on your behalf.'

export interface BrowserLoginOptions {
  clientId: string
  clientSecret: string
  /** Defaults to {@link DEFAULT_SCOPES}, which omits financials and administration. */
  scopes?: readonly ElvantoScope[]
  port?: number
  /** Open the browser automatically. Default true; the URL is printed either way. */
  openBrowser?: boolean
  /** Where the URL and progress are written. Default `process.stderr`. */
  output?: { write(text: string): unknown }
  /** Override the OAuth origin. For tests against a stub. */
  baseUrl?: string
}

/**
 * Runs the authorization code flow against a loopback listener, and returns the
 * grant.
 *
 * Lives here rather than in either CLI because both of them need it: the endpoint
 * CLI's `elvanto login`, and an agent binary that wants the same thing without
 * depending on that package. Storing the result is the caller's business — this
 * only obtains it.
 */
export async function loginWithBrowser(
  options: BrowserLoginOptions,
): Promise<ElvantoTokens> {
  const clientId = options.clientId?.trim()
  const clientSecret = options.clientSecret?.trim()
  if (!clientId || !clientSecret) {
    throw new ElvantoOAuthError({
      message: `An OAuth client ID and secret are required to sign in.\n\n${REGISTER_APP_HELP}`,
    })
  }

  const port = options.port ?? DEFAULT_CALLBACK_PORT
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new ElvantoOAuthError({
      message: `The callback port must be an integer between 1 and 65535, got "${port}".`,
    })
  }

  const output = options.output ?? process.stderr
  const redirectUri = `http://127.0.0.1:${port}/callback`
  const scopes = options.scopes ?? DEFAULT_SCOPES

  // The state secret lives only for this call. Nothing has to verify it in a later
  // process, so there is nothing to persist and nothing to leak.
  const secret = randomToken(32)
  const state = await createState({ secret })

  const url = authorizeUrl({
    clientId,
    redirectUri,
    scopes,
    state,
    ...(options.baseUrl !== undefined ? { baseUrl: options.baseUrl } : {}),
  })

  output.write(
    `Requesting: ${scopes.join(', ')}\n` +
      `Listening on ${redirectUri}\n\n` +
      `Open this URL to authorize:\n\n  ${url}\n\n`,
  )

  // Started before the browser, so a redirect that arrives immediately is not met
  // with a closed port.
  const waiting = waitForCode({ port, secret })
  if (options.openBrowser !== false) openBrowser(url)

  const { code } = await waiting

  return exchangeCode({
    clientId,
    clientSecret,
    code,
    redirectUri,
    ...(options.baseUrl !== undefined ? { baseUrl: options.baseUrl } : {}),
  })
}

interface CallbackResult {
  code: string
}

/**
 * Serves the redirect URI until the browser comes back.
 *
 * Bound to 127.0.0.1 explicitly rather than to every interface: for the couple of
 * minutes this is up, it is a URL that will trade a code for a token, and it has
 * no business being reachable from the network.
 */
function waitForCode(options: {
  port: number
  secret: string
}): Promise<CallbackResult> {
  return new Promise<CallbackResult>((resolve, reject) => {
    let settled = false
    const finish = (error: Error | undefined, result?: CallbackResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      server.close(() => {
        if (error) reject(error)
        else resolve(result!)
      })
      // Nothing else is meant to be connected, but a browser keep-alive would
      // otherwise hold the process open after the flow is done.
      server.closeAllConnections?.()
    }

    const server = createServer((request: IncomingMessage, response: ServerResponse) => {
      const requestUrl = new URL(request.url ?? '/', `http://127.0.0.1:${options.port}`)
      if (requestUrl.pathname !== '/callback') {
        response.writeHead(404, { 'content-type': 'text/plain' })
        response.end('Not found')
        return
      }

      const deny = requestUrl.searchParams.get('error')
      if (deny) {
        respond(response, 'Authorization declined', `Elvanto reported: ${deny}`)
        finish(
          new ElvantoOAuthError({
            message: `Authorization was declined (${deny}).`,
            oauthError: deny,
          }),
        )
        return
      }

      const code = requestUrl.searchParams.get('code')
      void readState({ secret: options.secret, state: requestUrl.searchParams.get('state') })
        .then(() => {
          if (!code) {
            respond(response, 'Something went wrong', 'Elvanto sent no authorization code.')
            finish(new ElvantoError('Elvanto returned no authorization code.'))
            return
          }
          respond(
            response,
            'Signed in',
            'You can close this tab and return to the terminal.',
          )
          finish(undefined, { code })
        })
        .catch((error: unknown) => {
          respond(response, 'Refused', 'This callback did not match the sign-in in progress.')
          finish(error instanceof Error ? error : new Error(String(error)))
        })
    })

    server.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EADDRINUSE') {
        finish(
          new ElvantoError(
            `Port ${options.port} is already in use, so the redirect has nowhere to ` +
              `land. Close whatever is using it, or pass --port with a port you have ` +
              `registered as a redirect URI in Elvanto.`,
          ),
        )
        return
      }
      finish(error)
    })

    // Five minutes is long enough to find a password manager and short enough
    // that an abandoned login does not leave a listener up indefinitely.
    const timer = setTimeout(
      () => finish(new ElvantoError('Timed out waiting for the browser to come back.')),
      300_000,
    )
    timer.unref?.()

    server.listen(options.port, '127.0.0.1', () => {
      const address = server.address() as AddressInfo | null
      if (address && address.port !== options.port) {
        finish(new ElvantoError(`Expected to listen on ${options.port}, got ${address.port}.`))
      }
    })
  })
}

function respond(response: ServerResponse, title: string, detail: string): void {
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  response.end(
    `<!doctype html><meta charset="utf-8"><title>${title}</title>` +
      `<body style="font:16px/1.6 system-ui,sans-serif;max-width:32rem;margin:20vh auto;padding:0 1rem">` +
      `<h1 style="font-size:1.1rem">${title}</h1><p>${detail}</p></body>`,
  )
}

/** Best effort. A failure here is not worth reporting — the URL was printed. */
function openBrowser(url: string): void {
  const command =
    process.platform === 'darwin'
      ? 'open'
      : process.platform === 'win32'
        ? 'start'
        : 'xdg-open'
  try {
    const child = spawn(command, [url], {
      stdio: 'ignore',
      detached: true,
      shell: process.platform === 'win32',
    })
    child.on('error', () => {})
    child.unref()
  } catch {
    // The URL is on stderr; the user can open it themselves.
  }
}
