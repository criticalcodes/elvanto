import { defineConfig } from 'tsup'

/**
 * Two entries, split by runtime. `index` must stay importable on Cloudflare
 * Workers, so it reaches no Node built-in; `node` is the filesystem-backed token
 * store, which by definition does.
 */
export default defineConfig({
  entry: ['src/index.ts', 'src/node.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  sourcemap: true,
  target: 'node20',
})
