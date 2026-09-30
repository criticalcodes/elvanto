import { createServer, type Server } from 'node:http'

export interface StubRequest {
  path: string
  authorization: string | undefined
  body: unknown
}

export interface StubServer {
  url: string
  requests: StubRequest[]
  close: () => Promise<void>
}

/**
 * What a stub should answer with. Returning a bare value means HTTP 200 JSON;
 * the object form allows the non-2xx statuses, headers and raw bodies that
 * Elvanto really sends, so the CLI's error paths can be exercised.
 */
export interface StubResponse {
  /**
   * Marker. Required because Elvanto's own envelope contains a `status` key, so
   * there is no field that reliably distinguishes a transport directive from an
   * ordinary payload — inferring it silently turned `{status:'ok', …}` into an
   * invalid HTTP status.
   */
  readonly [HTTP_RESPONSE]: true
  status?: number
  headers?: Record<string, string>
  /** Serialised as JSON unless `raw` is given. */
  body?: unknown
  raw?: string
  /** Hang without responding, for timeout tests. */
  hang?: boolean
  /** Destroy the socket, for network-failure tests. */
  destroy?: boolean
}

const HTTP_RESPONSE = Symbol('elvanto.stub.httpResponse')

/** Describes a raw HTTP response, for exercising the CLI's error paths. */
export function httpResponse(
  response: Omit<StubResponse, typeof HTTP_RESPONSE>,
): StubResponse {
  return { ...response, [HTTP_RESPONSE]: true }
}

function isStubResponse(value: unknown): value is StubResponse {
  return typeof value === 'object' && value !== null && HTTP_RESPONSE in value
}

/** JSON when it parses, form fields when it doesn't. */
function parseBody(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw) as Record<string, unknown>
  } catch {
    return Object.fromEntries(new URLSearchParams(raw))
  }
}

/**
 * A local HTTP server standing in for api.elvanto.com, so the CLI can be
 * exercised over a real socket rather than with its internals stubbed.
 *
 * `respond` receives the endpoint path (`people/getAll`) and the parsed body.
 */
export async function startStubServer(
  respond: (path: string, body: Record<string, unknown>) => unknown,
): Promise<StubServer> {
  const requests: StubRequest[] = []

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString()
      // JSON for every data-API call; the OAuth token endpoint is form-encoded,
      // and parsing that as JSON would throw inside the server rather than
      // failing the test that meant to exercise it.
      const body = raw ? parseBody(raw) : {}
      // Strip the /v1/ prefix and the .json extension to recover the API path.
      const path = (req.url ?? '')
        .replace(/^\/v1\//, '')
        .replace(/\.json$/, '')

      requests.push({
        path,
        authorization: req.headers.authorization,
        body,
      })

      const payload = respond(path, body)

      if (isStubResponse(payload)) {
        if (payload.hang) return // never responds; the client must time out
        if (payload.destroy) {
          req.socket.destroy()
          return
        }
        res.writeHead(payload.status ?? 200, {
          'content-type': 'application/json',
          ...payload.headers,
        })
        res.end(payload.raw ?? JSON.stringify(payload.body ?? {}))
        return
      }

      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(payload))
    })
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') {
    throw new Error('stub server did not bind to a port')
  }

  return {
    url: `http://127.0.0.1:${address.port}/v1`,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        // A `hang` stub leaves a connection open, and `close()` alone waits for
        // it forever — so drop live sockets first.
        server.closeAllConnections()
        server.close((error) => (error ? reject(error) : resolve()))
      }),
  }
}
