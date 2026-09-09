import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        // `ptyKeeper` — the "leave them running" quit path's detached
        // helper process (see src/main/ptyKeeper.ts's own header). A second
        // entry, not an import of index's own code: it's spawned as its own
        // OS process (ELECTRON_RUN_AS_NODE) via the built `ptyKeeper.js`
        // sibling this produces, never required by index.js at runtime.
        input: { index: resolve(__dirname, 'src/main/index.ts'), ptyKeeper: resolve(__dirname, 'src/main/ptyKeeper.ts') }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/preload/index.ts') }
      }
    }
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/renderer/index.html') },
        output: {
          // Object-form manualChunks only matches exact module ids, so glob-like
          // package prefixes (`@pixi/*`, `@xterm/*`) need the function form instead.
          manualChunks(id: string): string | undefined {
            if (!id.includes('node_modules')) return undefined;
            const seg = id.split('node_modules/').pop() ?? '';
            const pkg = seg.startsWith('@') ? seg.split('/').slice(0, 2).join('/') : seg.split('/')[0];
            if (pkg === 'pixi.js' || pkg.startsWith('@pixi/') || pkg === 'earcut' || pkg === 'eventemitter3') {
              return 'pixi';
            }
            if (pkg === 'react' || pkg === 'react-dom' || pkg === 'scheduler') return 'react';
            if (pkg.startsWith('@xterm/')) return 'xterm';
            if (pkg === 'howler') return 'howler';
            return undefined;
          }
        }
      }
    },
    plugins: [react()],
    resolve: {
      alias: {
        '@': resolve(__dirname, 'src/renderer/src'),
        '@shared': resolve(__dirname, 'src/shared'),
        // Real art lives at the repo root, outside the renderer's vite root, so
        // it stays next to its licence paperwork (assets/ASSETS.md).
        '@assets': resolve(__dirname, 'assets')
      }
    }
  }
});
