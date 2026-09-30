/**
 * The minimum of `cloudflare:workers` this repository actually uses.
 *
 * A real deployment gets the full types from `wrangler types`, which writes a
 * `worker-configuration.d.ts` naming every binding in `wrangler.jsonc`. That file
 * is generated and not tracked here, and adding the generator to the typecheck
 * would make `pnpm typecheck` depend on Wrangler being able to run. This declares
 * only the ambient `env` binding bag, which is the one thing the Cloudflare
 * session store reaches for, and leaves it untyped so nothing here can quietly
 * come to depend on a binding that `wrangler.jsonc` does not declare.
 */
declare module 'cloudflare:workers' {
  export const env: Record<string, unknown>
}
