import { defineConfig } from 'tsup'

/**
 * Two entries, built separately because only one of them may carry a shebang.
 *
 * `index.ts` is the `elvanto-mcp` executable; `lib.ts` is what an application
 * imports to mount the server in its own HTTP surface. tsup applies `banner` to
 * every entry in a config, so a shared config would put `#!/usr/bin/env node` at
 * the top of the library too — harmless when Node loads it, but a syntax error
 * for a bundler that treats it as ordinary source.
 *
 * Neither entry sets `clean`, and the build script empties `dist` first instead.
 * Whichever config tsup happens to run second would otherwise be free to delete
 * the other's output — a race that would depend on tsup's internal ordering
 * rather than on anything stated here.
 */
export default defineConfig([
  {
    entry: ['src/index.ts'],
    format: ['esm'],
    dts: false,
    clean: false,
    sourcemap: true,
    target: 'node20',
    banner: { js: '#!/usr/bin/env node' },
  },
  {
    entry: ['src/lib.ts'],
    format: ['esm'],
    // Types matter here and not for the executable: this entry is imported.
    dts: true,
    clean: false,
    sourcemap: true,
    target: 'node20',
  },
])
