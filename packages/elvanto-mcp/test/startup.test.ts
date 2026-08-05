import { describe, expect, test } from 'vitest'
import { HELP, planStartup } from '../src/startup.js'
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
