import { createRoot } from 'react-dom/client';
import { App } from './App';
import { useStore } from './store/store';
import { startSession, stopSession, startRegistrySync, startCompletionToasts } from './sessions';
import { createTerminal } from './pty/terminalRegistry';
import {
  initAudio,
  debugSnapshot,
  Howler,
  notifyBattleStart,
  notifyBattleEnd,
  playAttackSound,
  playVictoryChime,
  notifyEvolutionStart,
  notifyEvolutionFlash,
  notifyEvolutionEnd,
  playSpawnCry,
  playEvolutionCry
} from './audio/audioEngine';
import { useAudioStore } from './audio/audioStore';
import { applyTokens } from './design/tokens';
import './index.css';

// Design tokens (Phase 8 §2) — stamped onto :root before anything paints, so
// index.css's existing var(--x) rules never render with unset custom
// properties even for a single frame.
applyTokens();

// Independent of the garden scene's own mount/unmount — the speaker popover
// works even before/without it (see audioEngine.ts's initAudio doc comment).
void initAudio();

// Dev-only introspection hook (stripped from production builds by Vite's
// import.meta.env.DEV dead-code elimination) — lets an external CDP/manual
// verification pass drive the exact same session pipeline the UI uses,
// without a UI round-trip. See Phase 4 Part A/B verification notes.
if (import.meta.env.DEV) {
  (window as unknown as { __pokeDebug: unknown }).__pokeDebug = {
    sessions: () => useStore.getState().sessions,
    store: useStore,
    startSession,
    stopSession,
    // Phase 7 — audio: no speakers in CI, so verification reads Howler state
    // and this snapshot over CDP instead.
    audio: {
      Howler,
      store: useAudioStore,
      snapshot: debugSnapshot,
      // Exercises the same entry points BattleManager/EvolutionCeremony call,
      // without needing a live PTY session wired end-to-end — same rationale
      // as exposing startSession/stopSession above.
      notifyBattleStart,
      notifyBattleEnd,
      playAttackSound,
      playVictoryChime,
      notifyEvolutionStart,
      notifyEvolutionFlash,
      notifyEvolutionEnd,
      playSpawnCry,
      playEvolutionCry
    }
  };
}

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('#root missing');

/**
 * Crash/reload recovery: main's `render-process-gone` handler (main/index.ts)
 * reloads this page's whole JS context after a renderer crash — this module
 * re-executes from scratch, same as any other reload (crash-triggered or a
 * plain dev Cmd+R). Main's own process, and the PTYs it owns, are untouched
 * either way, and main mirrors the session list on every change
 * (`startRegistrySync`) specifically so this boot has something to rebuild.
 *
 * Runs to completion BEFORE the first render (App is rendered at the end,
 * not in parallel) so GardenScene and TerminalDrawer never have to react to
 * sessions/terminals appearing after mount — they're just already there,
 * exactly like a fresh launch with sessions pre-loaded. The two IPC round-
 * trips this costs are local and fast; on an ordinary first launch both
 * resolve to "nothing to restore" almost immediately.
 *
 * Terminals are (re)created BEFORE the store is populated: `restoreSessions`
 * below is what makes TerminalDrawer's effect (keyed on `selectedId`) fire,
 * and that effect checks `hasTerminal(selectedId)` — it must already be true
 * by the time that happens.
 */
async function boot(): Promise<void> {
  // Recovery is best-effort: if either IPC call rejects, or restoring a
  // session throws, the user must still get a working (if empty) garden
  // rather than the render() below never happening at all — which would
  // recreate the exact permanently-blank-page failure this whole feature
  // exists to fix. render() is unconditional, in `finally`, below.
  try {
    startRegistrySync();
    startCompletionToasts();

    // xterm measures glyph width once at `term.open()` and never re-measures
    // on a later font swap, so JetBrains Mono must be ready before any
    // restored session's terminal can attach (TerminalDrawer's effect, which
    // fires right after this function's `render()` below). Bundled locally
    // (fonts.css) — resolves near-instantly, but "near-instant" is still not
    // "before". Fired in parallel with the IPC round-trips below, awaited
    // just after.
    const fontsReady = document.fonts.load(`14px "JetBrains Mono"`);

    const [crashInfo, { sessions: restored, selectedId }, diskRestoreInfo] = await Promise.all([
      window.api.getCrashInfo(),
      window.api.restoreSessions(),
      // Non-null exactly once, on the launch that respawned disk-persisted
      // sessions (Phase 8.5 #1) — mutually exclusive with `crashInfo` (that's
      // a same-process renderer reload; this is a fresh app launch).
      window.api.getDiskRestoreInfo()
    ]);
    await fontsReady;

    if (restored.length > 0) {
      for (const { session, replay } of restored) createTerminal(session.id, replay);
      useStore.getState().restoreSessions(restored.map((r) => r.session), selectedId);
    }

    if (diskRestoreInfo) {
      const n = diskRestoreInfo.count;
      useStore.getState().pushToast(`Restored ${n} session${n === 1 ? '' : 's'}.`);
      for (const note of diskRestoreInfo.notes) useStore.getState().pushToast(note);
    } else if (crashInfo) {
      const suffix =
        restored.length > 0
          ? ` — reconnected ${restored.length} session${restored.length === 1 ? '' : 's'}.`
          : '.';
      useStore.getState().pushToast(`Recovered from a renderer crash (${crashInfo.reason})${suffix}`);
    } else if (restored.length > 0) {
      useStore
        .getState()
        .pushToast(`Reconnected ${restored.length} session${restored.length === 1 ? '' : 's'} after reload.`);
    }
  } catch (err) {
    console.error('[boot] crash/reload recovery failed — starting with an empty garden', err);
  } finally {
    // Deliberately NOT wrapped in StrictMode: the Pixi application and the
    // PTY subscriptions are real, non-idempotent resources, and StrictMode's
    // dev-only double mount would build two gardens.
    // Non-null: TS doesn't carry the module-scope `if (!rootEl) throw`
    // guard's narrowing into this nested function; the guard above already ran.
    createRoot(rootEl!).render(<App />);
  }
}

void boot();
