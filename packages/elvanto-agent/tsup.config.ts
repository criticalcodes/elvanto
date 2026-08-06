import { defineConfig } from 'tsup'

/**
 * Two entries, split by runtime rather than by taste.
 *
 * `index` is the toolkit — tools, hooks, shaping — and must stay importable on
 * Cloudflare Workers, so it may not reach anything Node-only. `cli` is the
 * terminal runner, which imports `@flue/runtime/node` and `node:readline`.
 * Bundling them together would drag Node-only modules into every Worker build
 * that imported a tool. `routes` sits with `index` — it is web-standard Hono.
 *
 * There is no server entry: `vite build` emits the deployable server from
 * `src/app.ts`, for Node and for Cloudflare alike.
 */
export default defineConfig({
  entry: ['src/index.ts', 'src/cli/index.ts', 'src/routes.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  sourcemap: true,
  target: 'node20',
  // The consumer's project owns the Flue runtime instance and its Hono — see the
  // peer dependencies — so neither may be bundled in here.
  external: ['@flue/runtime', '@flue/runtime/node', '@flue/runtime/routing', 'hono'],
})
