import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

export default defineConfig({
  main: {
    // `electron-updater` is excluded from externalization (unlike every
    // other main dep) so Rollup inlines its source into out/main/index.js —
    // `build.files` in package.json only copies node_modules/node-pty/**/*
    // into the packaged app, so a plain externalized `require('electron-updater')`
    // would crash at runtime with "Cannot find module" (see autoUpdate.ts).
    plugins: [externalizeDepsPlugin({ exclude: ['electron-updater'] })],
    build: {
      rollupOptions: {
        // `ptyKeeper` — the "leave them running" quit path's detached
        // helper process (see src/main/ptyKeeper.ts's own header). A second
        // entry, not an import of index's own code: it's spawned as its own
        // OS process (ELECTRON_RUN_AS_NODE) via the built `ptyKeeper.js`
        // sibling this produces, never required by index.js at runtime.
        // `costHistoryScan` is the same detached-helper-process pattern, for
        // the tray popover's cost-history scan (src/main/costHistoryScan.ts).
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
          ptyKeeper: resolve(__dirname, 'src/main/ptyKeeper.ts'),
          costHistoryScan: resolve(__dirname, 'src/main/costHistoryScan.ts')
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        // `trayPopoverPreload` — the tray popover's own (much narrower)
        // preload, a second BrowserWindow that isn't the main renderer (see
        // src/main/tray.ts's header).
        input: {
          index: resolve(__dirname, 'src/preload/index.ts'),
          trayPopoverPreload: resolve(__dirname, 'src/preload/trayPopoverPreload.ts')
        }
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
