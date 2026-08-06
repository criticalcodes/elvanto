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
