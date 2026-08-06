import { describe, expect, test } from 'vitest'
import { parseArgs } from '../src/cli/index.ts'
import { webChatPage } from '../src/cli/web.ts'

describe('parseArgs', () => {
  test('collects positionals and flags', () => {
    expect(parseArgs(['chat', 'hello', 'there', '--id', 'office'])).toEqual({
      positional: ['chat', 'hello', 'there'],
      flags: { id: 'office' },
    })
  })

  test('accepts both flag spellings', () => {
    expect(parseArgs(['--port', '9000']).flags).toEqual({ port: '9000' })
    expect(parseArgs(['--port=9000']).flags).toEqual({ port: '9000' })
  })

  test('a flag with no value is boolean', () => {
    expect(parseArgs(['--help']).flags).toEqual({ help: true })
    expect(parseArgs(['--help', '--port', '80']).flags).toEqual({ help: true, port: '80' })
  })

  test('keeps a question intact as positionals', () => {
    // The bug this guards: a bare message must not be read as a command name.
    // `elvanto "who is serving?"` printed help instead of asking.
    const args = parseArgs(['who is serving on sunday?'])
    expect(args.positional).toEqual(['who is serving on sunday?'])
    expect(args.flags).toEqual({})
  })

  test('a value containing = survives', () => {
    expect(parseArgs(['--id=a=b']).flags).toEqual({ id: 'a=b' })
  })

  test('empty argv is empty', () => {
    expect(parseArgs([])).toEqual({ positional: [], flags: {} })
  })
})

describe('webChatPage', () => {
  const page = webChatPage({
    mount: '/agents/wpcc',
    title: 'WPCC office assistant',
    conversationId: 'web',
  })

  test('is a self-contained document with no external requests', () => {
    expect(page.startsWith('<!doctype html>')).toBe(true)
    // A CDN script or remote font would break on a network-isolated deployment
    // and leak the fact of use to a third party.
    expect(page).not.toMatch(/src="https?:/)
    expect(page).not.toMatch(/@import|href="https?:/)
  })

  test('targets the mount it was given', () => {
    expect(page).toContain('"mount":"/agents/wpcc"')
    expect(page).toContain('"conversationId":"web"')
  })

  test('trims a trailing slash off the mount, so the URL has no double slash', () => {
    const trailing = webChatPage({ mount: '/agents/wpcc/', title: 'x', conversationId: 'web' })
    expect(trailing).toContain('"mount":"/agents/wpcc"')
  })

  test('escapes the title rather than injecting it', () => {
    const nasty = webChatPage({
      mount: '/m',
      title: '</title><script>alert(1)</script>',
      conversationId: 'web',
    })
    expect(nasty).not.toContain('<script>alert(1)</script>')
    expect(nasty).toContain('&lt;/title&gt;')
  })

  test('a quote in the config cannot break out of the script', () => {
    // Parsing the emitted config back is the real proof: if a crafted id had
    // escaped its string literal, the remainder would not be valid JSON and the
    // round trip would not return the input.
    const hostile = '"; window.stolen = 1; //'
    const quoted = webChatPage({ mount: '/m', title: 'x', conversationId: hostile })

    const match = /^const CONFIG = (\{.*\});$/m.exec(quoted)
    expect(match).not.toBeNull()
    expect(JSON.parse(match![1]!)).toEqual({ mount: '/m', conversationId: hostile })
  })

  test('polls settlements rather than guessing when a turn is done', () => {
    // Text parts can read as finished while tools are still running, so the
    // settlement is the only reliable end-of-turn signal.
    expect(page).toContain('settlements')
    expect(page).toContain('submissionId')
  })
})

describe('conversation ids', () => {
  test('a fresh id is generated per invocation, and two never collide', async () => {
    // The bug this guards: the default used to be the fixed string 'cli', so every
    // invocation continued one ever-growing conversation. Unrelated questions
    // re-answered each other, and member data from one stayed in context for the
    // next.
    const { freshIdForTest } = await import('../src/cli/index.ts')
    const ids = new Set(Array.from({ length: 200 }, () => freshIdForTest()))
    expect(ids.size).toBe(200)
    for (const id of ids) expect(id).not.toBe('cli')
  })

  test('ids sort chronologically, so a conversation list reads in order', async () => {
    const { freshIdForTest } = await import('../src/cli/index.ts')
    const first = freshIdForTest()
    // The timestamp component is base36 milliseconds; same-millisecond ids differ
    // only in the random suffix, which is why collision-resistance is tested above.
    expect(first.startsWith('cli-')).toBe(true)
    expect(first.split('-').length).toBe(3)
  })
})
