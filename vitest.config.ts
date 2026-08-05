import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const sdkSrc = fileURLToPath(new URL('./packages/elvanto/src/index.ts', import.meta.url))

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts'],
    environment: 'node',
  },
  resolve: {
    alias: {
      // Without this, the CLI and MCP tests resolve `@criticalcodes/elvanto`
      // through the workspace symlink to packages/elvanto/dist — so they would
      // silently test the last build instead of the current source, and stay
      // green against an SDK change until someone ran `pnpm build`.
      '@criticalcodes/elvanto': sdkSrc,
    },
  },
})
