// @ts-check
import { defineConfig } from 'astro/config';
import react from '@astrojs/react';
import { fileURLToPath } from 'node:url';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const appSrc = here('../src/');

/**
 * Astro turns a plain `import x from './a.png'` into image metadata (an
 * object) for its own image pipeline; the app's garden code (gardenArt.ts)
 * expects Vite's default — a URL string. Re-resolve image imports made FROM
 * the app's sources with `?url`, which is what they get under electron-vite.
 * @returns {import('vite').Plugin}
 */
function appImageUrls() {
  return {
    name: 'pokeharness-app-image-urls',
    enforce: 'pre',
    async resolveId(source, importer, options) {
      if (!importer || !importer.startsWith(appSrc)) return null;
      if (!/\.(png|gif|jpe?g|webp)$/.test(source)) return null;
      const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
      return resolved ? `${resolved.id}?url` : null;
    }
  };
}

// The hero showreel imports the desktop app's REAL garden modules (Pixi scene,
// BattleManager, ceremonies, ArceusWarp) straight out of ../src, using the
// same path aliases electron.vite.config.ts gives the renderer. Array form so
// the exact-path audio stub is matched before the general `@` prefix.
// https://astro.build/config
export default defineConfig({
  integrations: [react()],
  vite: {
    plugins: [appImageUrls()],
    resolve: {
      alias: [
        { find: /^@\/audio\/audioEngine$/, replacement: here('./src/showreel/audioStub.ts') },
        { find: /^@\//, replacement: here('../src/renderer/src/') },
        { find: /^@shared\//, replacement: here('../src/shared/') },
        { find: /^@assets\//, replacement: here('../assets/') }
      ],
      // Files under ../src resolve bare imports by walking up from THEIR
      // location, which would reach the app's own node_modules (absent in
      // CI) or a second copy of pixi/react. Dedupe pins them to this site's.
      dedupe: ['pixi.js', 'gifuct-js', 'react', 'react-dom']
    },
    server: {
      fs: { allow: ['..'] }
    }
  }
});
