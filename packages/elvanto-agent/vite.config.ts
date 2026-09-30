import { fileURLToPath } from 'node:url'
import { cloudflare } from '@cloudflare/vite-plugin'
import { flue, flueWorkerConfig } from '@flue/vite'
import { defineConfig } from 'vite'

/**
 * `FLUE_TARGET=node` drops the Cloudflare plugin and builds a Node server
 * (`dist/server.mjs`) instead of a Worker. See flue.config.ts for why both
 * targets are kept.
 *
 * `flue()` must come first either way — the Cloudflare plugin calls
 * `flueWorkerConfig()` while Vite resolves the config, which requires the agent
 * scan to have already run.
 */
const node = process.env['FLUE_TARGET'] === 'node'

export default defineConfig({
  plugins: node ? [flue()] : [flue(), cloudflare({ config: flueWorkerConfig() })],
  resolve: {
    alias: {
      // Where sessions and OAuth grants live, chosen by target rather than
      // probed at runtime. The Cloudflare implementation imports
      // `cloudflare:workers`, which does not resolve in a Node build, and the
      // Node one is a process-local singleton, which would be wrong on Workers
      // where the router and the agent are separate isolates. An alias keeps the
      // wrong one out of each build entirely instead of branching inside it.
      '#sessions': fileURLToPath(
        new URL(
          node ? './src/sessions.node.ts' : './src/sessions.cloudflare.ts',
          import.meta.url,
        ),
      ),
    },
  },
  build: {
    // Not `dist`, which tsup owns. `package.json` publishes `dist`, so sharing it
    // would mean an app build silently replaced the published toolkit with a
    // bundled server — and `npm pack` would ship it.
    outDir: 'dist-app',
    // Switching targets otherwise leaves the previous target's entry behind, and
    // a deploy pointing at a stale `server.mjs` is a confusing way to find out.
    emptyOutDir: true,
  },
})
