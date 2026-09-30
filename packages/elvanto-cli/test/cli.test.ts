import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { EXIT, describeError, main, render } from '../src/index.js'
import { httpResponse, startStubServer, type StubServer } from './stub-server.js'

let server: StubServer
let stdout: string[]
let stderr: string[]

/** Responses keyed by endpoint path, set per test. */
let responses: Record<string, unknown>

beforeEach(async () => {
  responses = {}
  server = await startStubServer((path) => {
    const response = responses[path]
    if (response === undefined) {
      return { status: 'fail', error: { code: 404, message: `no stub for ${path}` } }
    }
    return response
  })

  stdout = []
  stderr = []
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    stdout.push(String(chunk))
    return true
  })
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    stderr.push(String(chunk))
    return true
  })
})

afterEach(async () => {
  vi.restoreAllMocks()
  await server.close()
})

/** Runs the CLI with the stub server and a test key already wired in. */
async function run(...args: string[]): Promise<number> {
  return main([
    'node',
    'elvanto',
    '--base-url',
    server.url,
    '--api-key',
    'test-key',
    ...args,
  ])
}

const out = () => stdout.join('')
const err = () => stderr.join('')

const peoplePage = {
  status: 'ok',
  people: {
    page: 1,
    per_page: 2,
    on_this_page: 2,
    total: 2,
    person: [
      { id: 'p1', firstname: 'John', lastname: 'Smith', email: 'john@example.com', volunteer: 1 },
      { id: 'p2', firstname: 'Sandra', lastname: 'Cook', email: 'sandra@example.com', volunteer: 0 },
    ],
  },
}

describe('command surface', () => {
  test('lists endpoints without needing credentials', async () => {
    const code = await main(['node', 'elvanto', 'endpoints'])
    expect(code).toBe(EXIT.ok)
    expect(out()).toContain('people get-all')
    expect(out()).toContain('songs arrangements get-info')
  })

  test('exposes nested namespaces as subcommands', async () => {
    responses['songs/keys/getAll'] = {
      status: 'ok',
      keys: { key: [{ id: 'k1', key_starting: 'E' }] },
    }
    const code = await run('songs', 'keys', 'get-all', '--arrangement-id', 'a1', '-o', 'json')
    expect(code).toBe(EXIT.ok)
    expect(server.requests[0]!.path).toBe('songs/keys/getAll')
  })

  test('shows the documentation link in help', async () => {
    const code = await main(['node', 'elvanto', 'people', 'get-all', '--help'])
    expect(code).toBe(EXIT.ok)
    expect(out()).toContain('https://www.elvanto.com/api/people/getAll/')
  })

  test('does not warn about shapes that are confirmed by the docs', async () => {
    await main(['node', 'elvanto', 'songs', 'categories', 'get-all', '--help'])
    expect(out()).not.toContain('not been verified against real data')
    expect(out()).toContain('https://www.elvanto.com/api/songs/categories/getAll/')
  })
})

describe('authentication', () => {
  test('sends the API key as HTTP basic', async () => {
    responses['people/getAll'] = peoplePage
    await run('people', 'get-all', '-o', 'json')

    const auth = server.requests[0]!.authorization!
    expect(Buffer.from(auth.replace('Basic ', ''), 'base64').toString()).toBe('test-key:x')
  })

  test('sends a token as a bearer when no API key is given', async () => {
    responses['people/getAll'] = peoplePage
    await main([
      'node', 'elvanto', '--base-url', server.url, '--token', 'tok_1',
      'people', 'get-all', '-o', 'json',
    ])
    expect(server.requests[0]!.authorization).toBe('Bearer tok_1')
  })

  test('explains how to authenticate when nothing is configured', async () => {
    const code = await main([
      'node', 'elvanto', '--base-url', server.url, 'people', 'get-all',
    ])
    expect(code).toBe(EXIT.usage)
    expect(err()).toMatch(/ELVANTO_API_KEY/)
  })
})

describe('parameter mapping', () => {
  test('maps kebab-case flags back to Elvanto parameter names', async () => {
    responses['people/getAll'] = peoplePage
    await run('people', 'get-all', '--page-size', '50', '--page', '2', '-o', 'json')
    expect(server.requests[0]!.body).toEqual({ page: 2, page_size: 50 })
  })

  test('splits a comma-separated list into an array', async () => {
    responses['people/getAll'] = peoplePage
    await run('people', 'get-all', '--fields', 'birthday,gender', '-o', 'json')
    expect(server.requests[0]!.body).toEqual({ fields: ['birthday', 'gender'] })
  })

  test('accumulates a repeated list flag', async () => {
    responses['people/getAll'] = peoplePage
    await run('people', 'get-all', '--fields', 'birthday', '--fields', 'gender', '-o', 'json')
    expect(server.requests[0]!.body).toEqual({ fields: ['birthday', 'gender'] })
  })

  test('collects key=value pairs into an object for search', async () => {
    responses['people/search'] = peoplePage
    await run(
      'people', 'search',
      '--search', 'lastname=Smith',
      '--search', 'volunteer=yes',
      '-o', 'json',
    )
    expect(server.requests[0]!.body).toEqual({
      search: { lastname: 'Smith', volunteer: 'yes' },
    })
  })

  test('rejects a search pair that is not key=value', async () => {
    const code = await run('people', 'search', '--search', 'lastname')
    expect(code).toBe(EXIT.usage)
    expect(err()).toMatch(/key=value/)
  })

  test('sends a lone ID as a string, not a one-element array', async () => {
    responses['people/getAll'] = peoplePage
    await run('people', 'get-all', '--category-id', 'cat1', '-o', 'json')
    expect(server.requests[0]!.body).toEqual({ category_id: 'cat1' })
  })

  test('sends several IDs as an array', async () => {
    responses['people/getAll'] = peoplePage
    await run('people', 'get-all', '--category-id', 'cat1,cat2', '-o', 'json')
    expect(server.requests[0]!.body).toEqual({ category_id: ['cat1', 'cat2'] })
  })

  test('passes a boolean flag through as true', async () => {
    responses['songs/getAll'] = { status: 'ok', songs: { song: [{ id: 's1', title: 'Adonai' }] } }
    await run('songs', 'get-all', '--files', '-o', 'json')
    expect(server.requests[0]!.body).toEqual({ files: true })
  })

  test('requires a mandatory parameter', async () => {
    const code = await run('people', 'get-info')
    expect(code).toBe(EXIT.usage)
    expect(err()).toMatch(/--id/)
  })

  test('validates an enum choice before sending', async () => {
    const code = await run('services', 'get-all', '--status', 'archived')
    expect(code).toBe(EXIT.usage)
    expect(server.requests).toHaveLength(0)
  })

  test('validates a date format before sending', async () => {
    const code = await run('calendar', 'events', 'get-all', '--start', '01/01/2026', '--end', '2026-01-31')
    expect(code).toBe(EXIT.usage)
    expect(err()).toMatch(/YYYY-MM-DD/)
    expect(server.requests).toHaveLength(0)
  })

  test('merges --params-json over the generated flags', async () => {
    responses['people/getAll'] = peoplePage
    await run(
      'people', 'get-all',
      '--page-size', '10',
      '--params-json', '{"page_size":250,"undocumented_filter":"x"}',
      '-o', 'json',
    )
    expect(server.requests[0]!.body).toEqual({
      page_size: 250,
      undocumented_filter: 'x',
    })
  })

  test('rejects malformed --params-json', async () => {
    const code = await run('people', 'get-all', '--params-json', '{oops')
    expect(code).toBe(EXIT.usage)
    expect(err()).toMatch(/not valid JSON/)
  })
})

describe('output formats', () => {
  test('renders a table with a record count', async () => {
    responses['people/getAll'] = peoplePage
    await run('people', 'get-all', '-o', 'table')

    expect(out()).toContain('ID')
    expect(out()).toContain('FIRSTNAME')
    expect(out()).toContain('John')
    expect(out()).toContain('2 records.')
  })

  test('renders booleans as yes/no in a table', async () => {
    responses['people/getAll'] = peoplePage
    await run('people', 'get-all', '-o', 'table', '--columns', '10')
    expect(out()).toMatch(/yes/)
    expect(out()).toMatch(/no/)
  })

  test('says so plainly when nothing matched', async () => {
    responses['people/getAll'] = {
      status: 'ok',
      people: { page: 1, per_page: 10, on_this_page: 0, total: 0, person: [] },
    }
    await run('people', 'get-all', '-o', 'table')
    expect(out()).toContain('No records matched.')
  })

  test('emits one JSON object per line for ndjson', async () => {
    responses['people/getAll'] = peoplePage
    await run('people', 'get-all', '-o', 'ndjson')

    const lines = out().trim().split('\n')
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[0]!)).toMatchObject({ id: 'p1' })
  })

  test('emits the normalized envelope for json', async () => {
    responses['people/getAll'] = peoplePage
    await run('people', 'get-all', '-o', 'json')

    const parsed = JSON.parse(out()) as { items: unknown[]; total: number }
    expect(parsed.total).toBe(2)
    expect(parsed.items).toHaveLength(2)
  })

  test('renders a single record as aligned key/value lines', async () => {
    responses['people/getInfo'] = {
      status: 'ok',
      person: [{ id: 'p1', firstname: 'John', lastname: 'Smith' }],
    }
    await run('people', 'get-info', '--id', 'p1', '-o', 'table')
    expect(out()).toMatch(/firstname\s+John/)
  })

  test('flags that a table is hiding fields', async () => {
    responses['people/getAll'] = {
      status: 'ok',
      people: {
        page: 1, per_page: 1, on_this_page: 1, total: 1,
        person: [{
          id: 'p1', firstname: 'A', lastname: 'B', email: 'c@d.e',
          mobile: '1', phone: '2', status: 'Active', username: 'ab',
          country: 'UK', timezone: 'Europe/London',
        }],
      },
    }
    await run('people', 'get-all', '-o', 'table', '--columns', '3')
    expect(out()).toMatch(/more fields per record/)
  })
})

describe('pagination', () => {
  test('--all walks every page', async () => {
    let page = 0
    server = await startStubServer(() => {
      page++
      return {
        status: 'ok',
        people: {
          page,
          per_page: 2,
          on_this_page: page < 3 ? 2 : 1,
          total: 5,
          person: page < 3
            ? [{ id: `p${page}a` }, { id: `p${page}b` }]
            : [{ id: 'p3a' }],
        },
      }
    })

    await run('people', 'get-all', '--all', '-o', 'ndjson')
    expect(out().trim().split('\n')).toHaveLength(5)
    expect(server.requests).toHaveLength(3)
  })

  test('--max-records caps the walk', async () => {
    server = await startStubServer(() => ({
      status: 'ok',
      people: {
        page: 1, per_page: 2, on_this_page: 2, total: 100,
        person: [{ id: 'a' }, { id: 'b' }],
      },
    }))

    await run('people', 'get-all', '--all', '--max-records', '3', '-o', 'ndjson')
    expect(out().trim().split('\n')).toHaveLength(3)
  })

  test('notes that more pages exist when not using --all', async () => {
    responses['people/getAll'] = {
      status: 'ok',
      people: { page: 1, per_page: 2, on_this_page: 2, total: 10, person: [{ id: 'a' }, { id: 'b' }] },
    }
    await run('people', 'get-all', '-o', 'table')
    expect(out()).toContain('use --all')
  })
})

describe('validation opt-out', () => {
  const wrongShape = {
    status: 'ok',
    people: { page: 1, per_page: 1, on_this_page: 1, total: 1, person: [{ firstname: 'no id' }] },
  }

  test('fails loudly by default and says how to proceed', async () => {
    responses['people/getAll'] = wrongShape
    const code = await run('people', 'get-all', '-o', 'json')
    expect(code).toBe(EXIT.schemaMismatch)
    expect(err()).toContain('--validate warn')
  })

  test('--validate warn returns the data and warns on stderr', async () => {
    responses['people/getAll'] = wrongShape
    const code = await run('people', 'get-all', '--validate', 'warn', '-o', 'json')
    expect(code).toBe(EXIT.ok)
    expect(err()).toMatch(/^warning:/m)
    expect(JSON.parse(out()).items).toHaveLength(1)
  })

  test('--validate off skips checking entirely and stays quiet', async () => {
    responses['people/getAll'] = wrongShape
    const code = await run('people', 'get-all', '--validate', 'off', '-o', 'json')
    expect(code).toBe(EXIT.ok)
    expect(err()).toBe('')
  })

  test('reads the mode from ELVANTO_VALIDATE', async () => {
    responses['people/getAll'] = wrongShape
    vi.stubEnv('ELVANTO_VALIDATE', 'off')
    try {
      expect(await run('people', 'get-all', '-o', 'json')).toBe(EXIT.ok)
    } finally {
      vi.unstubAllEnvs()
    }
  })

  test('rejects an invalid mode as a usage error', async () => {
    const code = await run('people', 'get-all', '--validate', 'maybe')
    expect(code).toBe(EXIT.usage)
  })
})

describe('debug logging', () => {
  test('--debug logs to stderr and leaves stdout clean JSON', async () => {
    responses['people/getAll'] = peoplePage
    const code = await run('people', 'get-all', '--debug', '-o', 'json')

    expect(code).toBe(EXIT.ok)
    expect(err()).toContain('[elvanto] request')
    expect(err()).toContain('[elvanto] response')
    // stdout must remain parseable, or piping to jq breaks.
    expect(() => JSON.parse(out())).not.toThrow()
  })

  test('--debug never logs the key or the records it fetched', async () => {
    responses['people/getAll'] = peoplePage
    await run('people', 'get-all', '--debug', 'verbose', '-o', 'json')

    const logged = err()
    expect(logged).not.toContain('test-key')
    expect(logged).not.toContain(Buffer.from('test-key:x').toString('base64'))
    expect(logged).not.toContain('john@example.com')
    expect(logged).not.toContain('Smith')
  })

  test('rejects an invalid debug mode as a usage error', async () => {
    const code = await run('people', 'get-all', '--debug', 'sometimes')
    expect(code).toBe(EXIT.usage)
  })

  test('stays silent without the flag', async () => {
    responses['people/getAll'] = peoplePage
    await run('people', 'get-all', '-o', 'json')
    expect(err()).toBe('')
  })
})

describe('exit codes', () => {
  test('distinguishes auth failure', async () => {
    responses['people/getAll'] = {
      status: 'fail',
      error: { code: 401, message: 'Unauthorised' },
    }
    const code = await run('people', 'get-all')
    expect(code).toBe(EXIT.auth)
    expect(err()).toMatch(/Secret API Key/)
  })

  test('distinguishes not-found', async () => {
    responses['people/getInfo'] = {
      status: 'fail',
      error: { code: 404, message: 'Invalid Person ID' },
    }
    const code = await run('people', 'get-info', '--id', 'nope')
    expect(code).toBe(EXIT.notFound)
  })

  test('treats --help and --version as success', async () => {
    expect(await main(['node', 'elvanto', '--help'])).toBe(EXIT.ok)
    expect(await main(['node', 'elvanto', '--version'])).toBe(EXIT.ok)
  })

  test('maps a real HTTP 500 to the generic failure code', async () => {
    responses['people/getAll'] = httpResponse({
      status: 500,
      body: { status: 'fail', error: { message: 'Internal Server Error' } },
    })
    const code = await run('people', 'get-all', '--retries', '0')
    expect(code).toBe(EXIT.error)
    expect(err()).toContain('Internal Server Error')
  })

  test('tells the user how to retry when rate limited', async () => {
    responses['people/getAll'] = httpResponse({
      status: 429,
      body: { status: 'fail', error: { message: 'Too many requests' } },
    })
    const code = await run('people', 'get-all', '--retries', '0')
    expect(code).toBe(EXIT.error)
    expect(err()).toContain('--retries')
  })

  test('reports a dropped connection as a transport failure', async () => {
    responses['people/getAll'] = httpResponse({ destroy: true })
    const code = await run('people', 'get-all', '--retries', '0')
    expect(code).toBe(EXIT.error)
    expect(err()).toMatch(/request failed/)
  })

  test('reports a timeout naming the limit that was exceeded', async () => {
    responses['people/getAll'] = httpResponse({ hang: true })
    const code = await run('people', 'get-all', '--timeout', '50', '--retries', '0')
    expect(code).toBe(EXIT.error)
    expect(err()).toContain('timed out after 50ms')
  })

  test('reports a non-JSON body without dumping the whole page', async () => {
    responses['people/getAll'] = httpResponse({
      raw: '<html><body>Under maintenance</body></html>',
      headers: { 'content-type': 'text/html' },
    })
    const code = await run('people', 'get-all', '--retries', '0')
    expect(code).toBe(EXIT.error)
    expect(err()).toMatch(/expected JSON/)
  })

  test('retries when asked, then succeeds', async () => {
    let attempt = 0
    server = await startStubServer(() => {
      attempt++
      if (attempt === 1) {
        return httpResponse({
          status: 503,
          headers: { 'retry-after': '0' },
          body: { status: 'fail', error: { message: 'unavailable' } },
        })
      }
      return peoplePage
    })

    const code = await run('people', 'get-all', '--retries', '2', '-o', 'json')
    expect(code).toBe(EXIT.ok)
    expect(attempt).toBe(2)
  })

  test('maps an unknown error to the generic failure code', () => {
    expect(describeError(new Error('boom'))).toEqual({ message: 'boom', code: EXIT.error })
  })
})

describe('render', () => {
  test('collapses HTML that Elvanto returns in descriptions', () => {
    const output = render(
      {
        items: [{ id: 'g1', description: '<p>A group to <b>connect</b> families</p>' }],
        page: 1, perPage: 1, onThisPage: 1, total: 1, hasMore: false,
      },
      { format: 'table', width: 120, maxColumns: 6 },
    )
    expect(output).toContain('A group to connect families')
    expect(output).not.toContain('<p>')
  })

  test('summarises a nested collection in the single-record view', () => {
    const output = render(
      { id: 'p1', locations: [{ id: 'l1' }, { id: 'l2' }], service_type: { id: 's' } },
      { format: 'table', width: 120, maxColumns: 6 },
    )
    expect(output).toMatch(/locations\s+\[2\]/)
    expect(output).toMatch(/service_type\s+\{…\}/)
  })

  test('keeps non-scalar fields out of table columns but counts them', () => {
    // A table of arrays and objects would be unreadable, so they are excluded
    // from columns; the footer tells the user to switch to JSON for them.
    const output = render(
      {
        items: [{ id: 'p1', locations: [{ id: 'l1' }, { id: 'l2' }] }],
        page: 1, perPage: 1, onThisPage: 1, total: 1, hasMore: false,
      },
      { format: 'table', width: 120, maxColumns: 6 },
    )
    expect(output).not.toContain('locations')
    expect(output).toMatch(/1 more field per record/)
  })

  test('fits the table to a narrow terminal', () => {
    const output = render(
      {
        items: [{ id: 'a-very-long-identifier-value-here', name: 'Another quite long value' }],
        page: 1, perPage: 1, onThisPage: 1, total: 1, hasMore: false,
      },
      { format: 'table', width: 40, maxColumns: 6 },
    )
    for (const line of output.split('\n')) {
      expect(line.length).toBeLessThanOrEqual(40)
    }
  })

  test('drops columns when a narrow terminal cannot fit them all', () => {
    // Shrinking alone cannot fit six columns into 40 characters; below a readable
    // minimum the table has to lose columns or it wraps into noise.
    const record = {
      id: 'p1', firstname: 'Johnathan', lastname: 'Smithers',
      email: 'johnathan@example.com', status: 'Active', username: 'jsmithers',
    }
    const output = render(
      { items: [record], page: 1, perPage: 1, onThisPage: 1, total: 1, hasMore: false },
      { format: 'table', width: 40, maxColumns: 6 },
    )
    // Table rows must not wrap — that misaligns the columns. The footer is prose
    // and wrapping it is fine.
    for (const line of output.split('\n')) {
      if (line.includes('record')) continue
      expect(line.length, line).toBeLessThanOrEqual(40)
    }
    // The most identifying columns survive.
    expect(output).toContain('ID')
  })

  test('stays within the terminal across a range of widths', () => {
    const record = {
      id: 'b0b0d8d2-48dc-426e-aaba-774936274c99', firstname: 'Johnathan',
      lastname: 'Smithers', email: 'johnathan@example.com', status: 'Active',
      username: 'jsmithers', mobile: '999-999-999', phone: '888-888-888',
    }
    for (const width of [20, 30, 40, 60, 80, 120]) {
      const output = render(
        { items: [record], page: 1, perPage: 1, onThisPage: 1, total: 1, hasMore: false },
        { format: 'table', width, maxColumns: 6 },
      )
      for (const line of output.split('\n')) {
        // The footer sentence is prose and may wrap; the table rows must not.
        if (line.includes('record')) continue
        expect(line.length, `width ${width}: "${line}"`).toBeLessThanOrEqual(width)
      }
    }
  })

  test('keeps values legible when a long key name squeezes the value column', () => {
    // Elvanto's custom-field keys are 43 characters, which on a narrow terminal
    // used to leave a negative width and erase every value.
    const output = render(
      {
        id: 'p1',
        firstname: 'John',
        'custom_77493627-aaba-426e-48dc-b0b0d8d24c99': 'Gardner',
      },
      { format: 'table', width: 40, maxColumns: 6 },
    )
    expect(output).toContain('p1')
    expect(output).toContain('John')
    expect(output).toContain('Gardner')
  })

  test('says so plainly when there is nothing tabulatable', () => {
    const output = render(
      {
        items: [{ locations: [{ id: 'l1' }] }],
        page: 1, perPage: 1, onThisPage: 1, total: 1, hasMore: false,
      },
      { format: 'table', width: 80, maxColumns: 6 },
    )
    // Previously rendered as blank lines plus a footer.
    expect(output).toContain('no simple fields to tabulate')
    expect(output).toContain('--output json')
  })

  test('renders an explicit null as empty rather than "null"', () => {
    const output = render(
      {
        items: [{ id: 'p1', created_by_first_name: null }],
        page: 1, perPage: 1, onThisPage: 1, total: 1, hasMore: false,
      },
      { format: 'table', width: 80, maxColumns: 6 },
    )
    expect(output).not.toContain('null')
  })
})

describe('writes', () => {
  /** Runs with stdin reported as not a terminal, as in a script or CI. */
  async function runUnattended(...args: string[]): Promise<number> {
    const descriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY')
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true })
    try {
      return await run(...args)
    } finally {
      if (descriptor) Object.defineProperty(process.stdin, 'isTTY', descriptor)
      else delete (process.stdin as { isTTY?: boolean }).isTTY
    }
  }

  test('a write runs without confirmation and prints the acknowledgement', async () => {
    responses['people/create'] = { status: 'ok', person: { id: 'p-new', family_id: 3 } }

    const code = await runUnattended(
      'people', 'create', '--firstname', 'Ada', '--lastname', 'Lovelace', '-o', 'json',
    )

    expect(code).toBe(EXIT.ok)
    expect(server.requests[0]!.body).toEqual({ firstname: 'Ada', lastname: 'Lovelace' })
    expect(JSON.parse(out())).toEqual({ id: 'p-new', family_id: 3 })
  })

  test('a destructive command refuses to run unattended without --yes', async () => {
    responses['people/remove'] = { status: 'ok', person: { id: 'p' } }

    const code = await runUnattended('people', 'remove', '--id', 'p')

    expect(code).toBe(EXIT.usage)
    expect(err()).toContain('--yes')
    expect(server.requests).toHaveLength(0)
  })

  test('--yes confirms a destructive command', async () => {
    responses['people/remove'] = { status: 'ok', person: { id: 'p' } }

    const code = await runUnattended('people', 'remove', '--id', 'p', '--yes', '-o', 'json')

    expect(code).toBe(EXIT.ok)
    expect(server.requests[0]!.path).toBe('people/remove')
  })

  test('a failed write is not retried, and exits with its own code', async () => {
    responses['groups/addPerson'] = httpResponse({
      status: 502,
      body: { status: 'fail', error: { message: 'Bad Gateway' } },
    })

    const code = await runUnattended(
      'groups', 'add-person', '--id', 'g', '--person-id', 'p', '--retries', '3',
    )

    expect(code).toBe(EXIT.outcomeUnknown)
    expect(err()).toMatch(/may or may not have been applied/)
    expect(server.requests).toHaveLength(1)
  })

  test('the endpoint listing marks writes', async () => {
    await main(['node', 'elvanto', 'endpoints'])
    expect(out()).toMatch(/people remove\s+Delete a person\. \[destructive\]/)
    expect(out()).toMatch(/people create\s+Create a person\. \[write\]/)
  })
})
