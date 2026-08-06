import { createServer as createHttpServer, type Server as NodeHttpServer } from 'node:http'
import { createHttpHandler, type HttpHandlerOptions } from './http.js'
import type { ServerConfig } from './server.js'

/** A listening HTTP server, and how to stop it. */
export interface RunningHttpServer {
  /** The bound port — resolved, so `port: 0` reports what the OS chose. */
  port: number
  host: string
  close: () => Promise<void>
}

/**
 * Serves {@link createHttpHandler} over `node:http`.
 *
 * Node-only, and kept apart from `http.ts` for that reason: the handler itself
 * imports nothing from Node, so a Workers or Deno build can take the handler
 * without dragging this module — and its `node:http` import — along with it.
 *
 * A hand-rolled adapter rather than a framework, because the surface it has to
 * cover is one JSON POST with a buffered reply. Adding an HTTP framework to a
 * package whose whole job is to be `npx`-able would cost more than it saves.
 */
export async function serveHttp(
  config: ServerConfig,
  options: HttpHandlerOptions & { host: string; port: number },
): Promise<RunningHttpServer> {
  const handle = createHttpHandler(config, options)

  const server = createHttpServer((incoming, outgoing) => {
    void (async () => {
      try {
        const url = new URL(
          incoming.url ?? '/',
          // Only the origin matters — the handler routes on method, not path, so
          // whoever mounts this chooses the path.
          `http://${incoming.headers.host ?? `${options.host}:${options.port}`}`,
        )

        const body = await readBody(incoming)
        const request = new Request(url, {
          method: incoming.method ?? 'GET',
          headers: toHeaders(incoming.headers),
          ...(body === undefined ? {} : { body }),
        })

        const response = await handle(request)
        outgoing.writeHead(
          response.status,
          Object.fromEntries(response.headers.entries()),
        )
        outgoing.end(Buffer.from(await response.arrayBuffer()))
      } catch (error) {
        // The handler already turns Elvanto and protocol failures into JSON-RPC
        // errors, so reaching here means the adapter itself broke. Say so
        // without echoing the error, which could carry request content.
        process.stderr.write(
          `[elvanto-mcp] HTTP request failed: ${error instanceof Error ? error.message : String(error)}\n`,
        )
        if (!outgoing.headersSent) outgoing.writeHead(500, { 'content-type': 'application/json' })
        outgoing.end(
          JSON.stringify({
            jsonrpc: '2.0',
            error: { code: -32603, message: 'Internal error.' },
            id: null,
          }),
        )
      }
    })()
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port, options.host, () => {
      server.removeListener('error', reject)
      resolve()
    })
  })

  const address = server.address()
  return {
    port: typeof address === 'object' && address ? address.port : options.port,
    host: options.host,
    close: () => closeServer(server),
  }
}

/** Buffers the request body, or `undefined` for the methods that carry none. */
async function readBody(
  incoming: import('node:http').IncomingMessage,
): Promise<Buffer | undefined> {
  if (incoming.method === 'GET' || incoming.method === 'HEAD') return undefined

  const chunks: Buffer[] = []
  for await (const chunk of incoming) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer))
  }
  return chunks.length > 0 ? Buffer.concat(chunks) : undefined
}

/** Flattens Node's `string | string[]` header bag into web `Headers`. */
function toHeaders(raw: import('node:http').IncomingHttpHeaders): Headers {
  const headers = new Headers()
  for (const [name, value] of Object.entries(raw)) {
    if (value === undefined) continue
    for (const single of Array.isArray(value) ? value : [value]) {
      headers.append(name, single)
    }
  }
  return headers
}

function closeServer(server: NodeHttpServer): Promise<void> {
  return new Promise((resolve, reject) => {
    // Without this, a client holding a keep-alive connection keeps the process
    // alive after close() — the server stops accepting but never emits.
    server.closeIdleConnections()
    server.close((error) => (error ? reject(error) : resolve()))
  })
}
