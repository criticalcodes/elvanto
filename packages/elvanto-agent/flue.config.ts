import { defineConfig } from '@flue/runtime/config'

/**
 * Cloudflare by default, Node when `FLUE_TARGET=node`.
 *
 * Switchable because the two targets between them cover every deployment path
 * Flue documents: Workers directly, and the Node build behind Docker, Fly,
 * Railway, Render, SST or a plain server. `flue run` needs neither and works
 * regardless.
 */
export default defineConfig({
  target: process.env['FLUE_TARGET'] === 'node' ? 'node' : 'cloudflare',
})
