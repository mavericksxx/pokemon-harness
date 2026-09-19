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

/**
 * The showreel renders the app's own chrome (topbar, party rail, terminal
 * drawer) with the app's real stylesheet, src/renderer/src/index.css. That
 * file styles `:root`/`body`/bare elements for a full-window app, so it's
 * scoped here under `.reel-app` (the showreel's window root) to keep it off
 * the landing page, and its viewport `max-width` breakpoints are dropped: the
 * reel always lays out at its fixed desktop design size and is CSS-scaled.
 * @returns {import('postcss').Plugin}
 */
function scopeAppCss() {
  return {
    postcssPlugin: 'pokeharness-scope-app-css',
    Once(root) {
      const file = root.source?.input.file ?? '';
      if (!file.startsWith(here('../src/renderer/src/'))) return;
      root.walkAtRules('media', (at) => {
        if (/max-width/.test(at.params)) at.remove();
      });
      root.walkRules((rule) => {
        const parent = rule.parent;
        if (parent && parent.type === 'atrule' && /keyframes$/.test(/** @type {any} */ (parent).name)) return;
        rule.selectors = rule.selectors.map((sel) => {
          const m = /^(:root|html|body)(?![\w-])/.exec(sel);
          if (m) return `.reel-app${sel.slice(m[0].length)}`;
          return `.reel-app ${sel}`;
        });
      });
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
    css: { postcss: { plugins: [scopeAppCss()] } },
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
