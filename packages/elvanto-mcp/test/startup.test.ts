import { describe, expect, test } from 'vitest'
import {
  DEFAULT_HTTP_HOST,
  DEFAULT_HTTP_PORT,
  HELP,
  planStartup,
} from '../src/startup.js'
import { SERVER_VERSION } from '../src/server.js'

const withKey = { ELVANTO_API_KEY: 'k' }

describe('planStartup', () => {
  test('serves with valid configuration', () => {
    const plan = planStartup([], withKey)
    expect(plan.action).toBe('serve')
    if (plan.action !== 'serve') return
    expect(plan.warnings).toEqual([])
  })

  test('prints the version', () => {
    for (const flag of ['--version', '-v']) {
      const plan = planStartup([flag], withKey)
      expect(plan).toEqual({ action: 'print', text: `${SERVER_VERSION}\n`, exitCode: 0 })
    }
  })

  test('prints help listing every environment variable', () => {
    const plan = planStartup(['--help'], {})
    expect(plan.action).toBe('print')
    for (const variable of [
      'ELVANTO_API_KEY',
      'ELVANTO_ACCESS_TOKEN',
      'ELVANTO_VALIDATE',
      'ELVANTO_MCP_PAGE_SIZE',
      'ELVANTO_MCP_MAX_RESPONSE_CHARS',
      'ELVANTO_DEBUG',
      'ELVANTO_BASE_URL',
    ]) {
      expect(HELP, variable).toContain(variable)
    }
    // The example config must name the published package.
    expect(HELP).toContain('@criticalcodes/elvanto-mcp')
  })

  test('help wins over serving, even with no credentials', () => {
    expect(planStartup(['--help'], {}).action).toBe('print')
  })

  describe('missing credentials', () => {
    test('still serves, so the client sees a working server', () => {
      // Failing here would leave the MCP client with a dead server and no
      // explanation; a tool call reports the problem far more usefully.
      const plan = planStartup([], {})
      expect(plan.action).toBe('serve')
    })

    test('warns, naming both variables and where to find the key', () => {
      const plan = planStartup([], {})
      if (plan.action !== 'serve') throw new Error('expected serve')
      expect(plan.warnings).toHaveLength(1)
      expect(plan.warnings[0]).toContain('ELVANTO_API_KEY')
      expect(plan.warnings[0]).toContain('ELVANTO_ACCESS_TOKEN')
      expect(plan.warnings[0]).toContain('Secret API Key')
    })

    test('does not warn when an access token is supplied instead', () => {
      const plan = planStartup([], { ELVANTO_ACCESS_TOKEN: 'tok' })
      if (plan.action !== 'serve') throw new Error('expected serve')
      expect(plan.warnings).toEqual([])
    })
  })

  describe('malformed configuration', () => {
    test('fails fast with a readable message, not a stack trace', () => {
      // An operator typo should be surfaced, not silently replaced by a default
      // they did not choose.
      const plan = planStartup([], { ...withKey, ELVANTO_VALIDATE: 'maybe' })
      expect(plan.action).toBe('fail')
      if (plan.action !== 'fail') return
      expect(plan.exitCode).toBe(1)
      expect(plan.message).toContain('ELVANTO_VALIDATE')
      expect(plan.message).toContain('maybe')
      expect(plan.message).toContain('--help')
      expect(plan.message).not.toContain('at ') // no stack frames
    })

    test('fails on an invalid debug mode too', () => {
      const plan = planStartup([], { ...withKey, ELVANTO_DEBUG: 'sometimes' })
      expect(plan.action).toBe('fail')
    })

    test('tolerates a nonsense page size rather than refusing to start', () => {
      // Unlike a validation mode, this has a safe default and no security or
      // correctness consequence, so it degrades instead of failing.
      const plan = planStartup([], { ...withKey, ELVANTO_MCP_PAGE_SIZE: 'lots' })
      expect(plan.action).toBe('serve')
      if (plan.action !== 'serve') return
      expect(plan.config.defaultPageSize).toBeUndefined()
    })
  })

  describe('transport selection', () => {
    test('defaults to stdio', () => {
      const plan = planStartup([], withKey)
      if (plan.action !== 'serve') throw new Error('expected serve')
      expect(plan.transport).toEqual({ kind: 'stdio' })
    })

    test('--http binds loopback on the default port', () => {
      const plan = planStartup(['--http'], withKey)
      if (plan.action !== 'serve') throw new Error('expected serve')
      expect(plan.transport).toEqual({
        kind: 'http',
        host: DEFAULT_HTTP_HOST,
        port: DEFAULT_HTTP_PORT,
      })
    })

    test('reads the token from the environment', () => {
      const plan = planStartup(['--http'], { ...withKey, ELVANTO_MCP_TOKEN: 'sekret' })
      if (plan.action !== 'serve') throw new Error('expected serve')
      expect(plan.transport).toMatchObject({ kind: 'http', token: 'sekret' })
      expect(plan.warnings).toEqual([])
    })

    test('accepts --port and --host in both spellings', () => {
      for (const argv of [
        ['--http', '--port', '9000', '--host', '127.0.0.5'],
        ['--http', '--port=9000', '--host=127.0.0.5'],
      ]) {
        const plan = planStartup(argv, withKey)
        if (plan.action !== 'serve') throw new Error(`expected serve for ${argv.join(' ')}`)
        expect(plan.transport).toMatchObject({ port: 9000, host: '127.0.0.5' })
      }
    })

    test('warns when serving loopback with no token', () => {
      const plan = planStartup(['--http'], withKey)
      if (plan.action !== 'serve') throw new Error('expected serve')
      expect(plan.warnings).toHaveLength(1)
      expect(plan.warnings[0]).toContain('ELVANTO_MCP_TOKEN')
    })

    test('refuses a reachable interface with no token', () => {
      // The failure mode this guards against is publishing every member and
      // giving record to the local network by typing one flag.
      for (const host of ['0.0.0.0', '::', '192.168.1.10', 'example.local']) {
        const plan = planStartup(['--http', '--host', host], withKey)
        expect(plan.action, host).toBe('fail')
        if (plan.action !== 'fail') continue
        expect(plan.message).toContain('ELVANTO_MCP_TOKEN')
      }
    })

    test('allows a reachable interface once a token is set', () => {
      const plan = planStartup(['--http', '--host', '0.0.0.0'], {
        ...withKey,
        ELVANTO_MCP_TOKEN: 'sekret',
      })
      expect(plan.action).toBe('serve')
    })

    test('treats every loopback spelling as loopback', () => {
      for (const host of ['localhost', '127.0.0.1', '127.0.1.1', '::1', '[::1]']) {
        const plan = planStartup(['--http', '--host', host], withKey)
        expect(plan.action, host).toBe('serve')
      }
    })

    test('a blank token is no token', () => {
      // Otherwise `ELVANTO_MCP_TOKEN=` in a compose file would read as
      // authentication while accepting `Bearer `.
      const plan = planStartup(['--http', '--host', '0.0.0.0'], {
        ...withKey,
        ELVANTO_MCP_TOKEN: '   ',
      })
      expect(plan.action).toBe('fail')
    })

    test('rejects a nonsense port rather than falling back to the default', () => {
      for (const port of ['nope', '0', '-1', '70000', '80.5']) {
        const plan = planStartup(['--http', '--port', port], withKey)
        expect(plan.action, port).toBe('fail')
        if (plan.action !== 'fail') continue
        expect(plan.message).toContain('--port')
      }
    })

    test('rejects an option with no value', () => {
      const plan = planStartup(['--http', '--port'], withKey)
      expect(plan.action).toBe('fail')
    })

    test('rejects --port and --host without --http', () => {
      // Silently ignoring them would leave an operator watching a port that
      // nothing ever bound.
      for (const argv of [['--port', '9000'], ['--host', '0.0.0.0']]) {
        const plan = planStartup(argv, withKey)
        expect(plan.action, argv.join(' ')).toBe('fail')
        if (plan.action !== 'fail') continue
        expect(plan.message).toContain('--http')
      }
    })

    test('help still wins over a broken transport option', () => {
      expect(planStartup(['--help', '--port', 'nope'], {}).action).toBe('print')
    })
  })

  test('passes configuration through to the server', () => {
    const plan = planStartup([], {
      ...withKey,
      ELVANTO_VALIDATE: 'warn',
      ELVANTO_DEBUG: 'verbose',
      ELVANTO_MCP_PAGE_SIZE: '50',
      ELVANTO_MCP_MAX_RESPONSE_CHARS: '20000',
      ELVANTO_BASE_URL: 'https://stub.local/v1',
    })
    if (plan.action !== 'serve') throw new Error('expected serve')
    expect(plan.config.clientOptions?.validate).toBe('warn')
    expect(plan.config.clientOptions?.debug).toBe('verbose')
    expect(plan.config.clientOptions?.baseUrl).toBe('https://stub.local/v1')
    expect(plan.config.defaultPageSize).toBe(50)
    expect(plan.config.maxResponseChars).toBe(20_000)
  })
})
