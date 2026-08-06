import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const sdkSrc = fileURLToPath(new URL('./packages/elvanto/src/index.ts', import.meta.url))
const mcpSrc = fileURLToPath(new URL('./packages/elvanto-mcp/src/lib.ts', import.meta.url))

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
      // Same reasoning for the MCP server, which the agent package imports to
      // mount in its own HTTP surface — and whose tool names the agent's MCP
      // allowlist is asserted against. Resolving to dist would test the last
      // build, so an endpoint added to the registry would look absent until
      // someone ran `pnpm build`.
      '@criticalcodes/elvanto-mcp': mcpSrc,
    },
  },
})
