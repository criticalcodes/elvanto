import { defineConfig } from 'tsup'

/**
 * Two entries, split by runtime rather than by taste.
 *
 * `index` is the toolkit — tools, hooks, shaping — and must stay importable on
 * Cloudflare Workers, so it may not reach anything Node-only. `cli` is the
 * single-binary runner, which imports `@flue/runtime/node`, `@hono/node-server`
 * and `node:readline`. Bundling them together would drag `node:http` into every
 * Worker build that imported a tool.
 *
 * `vite build` produces the deployable server separately, into `dist-app` — see
 * vite.config.ts.
 */
export default defineConfig({
  entry: ['src/index.ts', 'src/cli/index.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  sourcemap: true,
  target: 'node20',
  // The consumer's project owns the Flue runtime instance and its Hono — see the
  // peer dependencies — so neither may be bundled in here.
  external: ['@flue/runtime', '@flue/runtime/node', '@flue/runtime/routing', 'hono'],
})
