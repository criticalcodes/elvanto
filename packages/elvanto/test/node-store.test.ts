import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { FileTokenStore, defaultCredentialsPath } from '../src/node.js'
import type { ElvantoTokens } from '../src/oauth.js'

let directory: string
let path: string

const tokens: ElvantoTokens = {
  accessToken: 'at-1',
  refreshToken: 'rt-1',
  expiresAt: 1_800_000_000_000,
  scopes: ['ManagePeople'],
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'elvanto-store-'))
  path = join(directory, 'nested', 'credentials.json')
})

afterEach(() => {
  rmSync(directory, { recursive: true, force: true })
})

describe('FileTokenStore', () => {
  test('round-trips a grant', async () => {
    const store = new FileTokenStore(path)
    await store.write('default', tokens)

    await expect(new FileTokenStore(path).read('default')).resolves.toEqual(tokens)
  })

  test('reads as absent when the file does not exist', async () => {
    await expect(new FileTokenStore(path).read('default')).resolves.toBeUndefined()
    expect(new FileTokenStore(path).keys()).toEqual([])
  })

  test('creates the file 0600 inside a 0700 directory', async () => {
    await new FileTokenStore(path).write('default', tokens)

    // The whole point of the store: a refresh token is a standing grant on every
    // member record, and group- or world-readable is not an acceptable default.
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(statSync(join(directory, 'nested')).mode & 0o777).toBe(0o700)
  })

  test('tightens permissions that were loosened after creation', async () => {
    const store = new FileTokenStore(path)
    await store.write('default', tokens)
    chmodSync(path, 0o644)

    await store.write('default', { ...tokens, accessToken: 'at-2' })

    expect(statSync(path).mode & 0o777).toBe(0o600)
  })

  test('keeps several profiles side by side', async () => {
    const store = new FileTokenStore(path)
    await store.write('default', tokens)
    await store.write('other', { ...tokens, accessToken: 'at-other' })

    expect(store.keys().sort()).toEqual(['default', 'other'])
    await expect(store.read('other')).resolves.toMatchObject({ accessToken: 'at-other' })
  })

  test('delete removes one profile and leaves the rest', async () => {
    const store = new FileTokenStore(path)
    await store.write('default', tokens)
    await store.write('other', tokens)

    await store.delete('default')

    expect(store.keys()).toEqual(['other'])
  })

  test('deleting something absent is not an error', async () => {
    const store = new FileTokenStore(path)
    await expect(store.delete('never-existed')).resolves.toBeUndefined()
  })

  test('refuses a corrupt file rather than overwriting a working grant', async () => {
    const store = new FileTokenStore(path)
    await store.write('default', tokens)
    writeFileSync(path, '{ not json', 'utf8')

    await expect(store.read('default')).rejects.toThrow(/not valid JSON/)
    // And the bytes are still there to be recovered by hand.
    expect(readFileSync(path, 'utf8')).toBe('{ not json')
  })

  test('refuses a JSON file that is not a credentials file', async () => {
    writeFileSync(path.replace('/nested', ''), '[]', 'utf8')
    await expect(
      new FileTokenStore(path.replace('/nested', '')).read('default'),
    ).rejects.toThrow(/does not look like/)
  })
})

describe('defaultCredentialsPath', () => {
  test('prefers an explicit override', () => {
    expect(defaultCredentialsPath({ ELVANTO_CREDENTIALS: '/tmp/creds.json' })).toBe(
      '/tmp/creds.json',
    )
  })

  test('honours XDG_CONFIG_HOME', () => {
    expect(defaultCredentialsPath({ XDG_CONFIG_HOME: '/xdg' })).toBe(
      '/xdg/elvanto/credentials.json',
    )
  })

  test('falls back to ~/.config', () => {
    expect(defaultCredentialsPath({})).toMatch(/\/\.config\/elvanto\/credentials\.json$/)
  })

  test('ignores a relative XDG_CONFIG_HOME, which the spec says to', () => {
    expect(defaultCredentialsPath({ XDG_CONFIG_HOME: 'relative/path' })).toMatch(
      /\/\.config\/elvanto\/credentials\.json$/,
    )
  })
})
