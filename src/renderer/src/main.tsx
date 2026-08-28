import { createRoot } from 'react-dom/client';
import { App } from './App';
import { useStore } from './store/store';
import { startSession, stopSession, startRegistrySync, startCompletionToasts } from './sessions';
import { autoSummonArceus } from './arceus';
import { createTerminal, applyTerminalTheme } from './pty/terminalRegistry';
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
import { useTerminalSettingsStore } from './terminal/terminalSettingsStore';
import { useAppSettingsStore } from './store/appSettingsStore';
import { useWorkspaceStore } from './store/workspaceStore';
import { applyTheme } from './design/tokens';
import { resolveEffectiveTheme, watchSystemTheme } from './design/theme';
import { startQuitInterceptListener } from './closingTime';
import { startUpdateCheckListener } from './updateNotifier';
import { safeLogDiagnostic } from './diagnosticsClient';
import { startCounterReporting } from './diagnosticsCounters';
import './index.css';

// Design tokens (Phase 8 §2) — stamped onto :root before anything paints, so
// index.css's existing var(--x) rules never render with unset custom
// properties even for a single frame. Dark defaults here (matching the
// CSS's own `:root` fallback block); boot() below re-applies the real,
// persisted theme (parity sweep item 3) once it's resolved, before the
// first React render — see that call's own comment.
applyTheme('dark');

// Quit-intercept dialog (parity sweep item 2) — independent of boot()'s
// async recovery work, same as initAudio() below.
startQuitInterceptListener();

// Tier-1 update check (ship-cut item 4) — same independent-of-boot()
// wiring as the quit-intercept listener above.
startUpdateCheckListener();

// Local-only diagnostics (BACKLOG item 1) — error capture + invariant
// counters, both independent of boot()'s async recovery work, same as the
// listeners above. `data` is kept to plain scalars/strings at both call
// sites, matching diagnosticsClient.ts's own safety note.
window.addEventListener('error', (e) => {
  safeLogDiagnostic('renderer', 'error', e.message || 'window error', {
    filename: e.filename,
    lineno: e.lineno,
    colno: e.colno,
    stack: e.error instanceof Error ? e.error.stack : undefined
  });
});
window.addEventListener('unhandledrejection', (e) => {
  const reason: unknown = e.reason;
  safeLogDiagnostic('renderer', 'error', 'unhandled promise rejection', {
    message: reason instanceof Error ? reason.message : String(reason),
    stack: reason instanceof Error ? reason.stack : undefined
  });
});
startCounterReporting();

// Independent of the garden scene's own mount/unmount — the speaker popover
// works even before/without it (see audioEngine.ts's initAudio doc comment).
void initAudio();

// Phase 8.5 Wave B item 3 §2 — terminal font size / scrollback, same
// fire-and-forget boot pattern as audio settings above. `hydrate` also
// applies the loaded settings to any terminal already created (including
// ones this same boot() creates for a crash/reload restore, below) —
// ordering between the two doesn't matter.
void window.api.getTerminalSettings().then((s) => useTerminalSettingsStore.getState().hydrate(s));

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

    const [crashInfo, { sessions: restored, selectedId }, diskRestoreInfo, appSettings, harnessHomePath, workspaceSnapshot] =
      await Promise.all([
        window.api.getCrashInfo(),
        window.api.restoreSessions(),
        // Non-null exactly once, on the launch that respawned disk-persisted
        // sessions (Phase 8.5 #1) — mutually exclusive with `crashInfo` (that's
        // a same-process renderer reload; this is a fresh app launch).
        window.api.getDiskRestoreInfo(),
        // Parity sweep: theme / auto-permission-mode / keep-awake / recent
        // folders. Resolved and applied BEFORE the first render (below) so
        // nothing paints with the dark default for a light-theme user — same
        // rationale main's own window `backgroundColor` pre-paint fix follows
        // (main/index.ts's `resolveWindowBg`).
        window.api.getAppSettings(),
        // Harness home directory display path (Phase 8.7) — resolved
        // main-side (needs os.homedir()); see SettingsPanel's "Harness home"
        // section.
        window.api.getHarnessHomePath(),
        // Workspace registry (Phase 8.7) — awaits the SAME disk-restore
        // promise `restoreSessions` does main-side, so this never races
        // ahead of `restoreFromDisk` populating it.
        window.api.listWorkspaces()
      ]);
    await fontsReady;

    useAppSettingsStore.getState().hydrate(appSettings);
    useAppSettingsStore.getState().hydrateHarnessHomePath(harnessHomePath);
    useWorkspaceStore.getState().hydrate(workspaceSnapshot);
    const effectiveTheme = resolveEffectiveTheme(appSettings.theme);
    applyTheme(effectiveTheme);
    // Primes the terminal registry's own theme BEFORE the createTerminal
    // calls below, so a restored session's terminal is constructed with the
    // right theme from the start instead of the dark default it'd otherwise
    // pick up (terminalRegistry.ts's `currentTheme` module var).
    applyTerminalTheme(effectiveTheme);
    // Only matters while the setting is 'system' (the watcher itself checks
    // this on every OS appearance change) — started unconditionally so a
    // later in-session switch TO 'system' is covered without a restart.
    watchSystemTheme(() => useAppSettingsStore.getState().settings.theme);

    if (restored.length > 0) {
      for (const { session, replay } of restored) createTerminal(session.id, session.provider, replay);
      useStore.getState().restoreSessions(restored.map((r) => r.session), selectedId);
    }

    if (diskRestoreInfo) {
      const n = diskRestoreInfo.count;
      useStore.getState().pushToast(`restored ${n} session${n === 1 ? '' : 's'}.`);
      for (const note of diskRestoreInfo.notes) useStore.getState().pushToast(note);
    } else if (crashInfo) {
      const suffix =
        restored.length > 0
          ? ` — reconnected ${restored.length} session${restored.length === 1 ? '' : 's'}.`
          : '.';
      useStore.getState().pushToast(`recovered from a renderer crash (${crashInfo.reason})${suffix}`);
    } else if (restored.length > 0) {
      useStore
        .getState()
        .pushToast(`reconnected ${restored.length} session${restored.length === 1 ? '' : 's'} after reload.`);
    }

    // Summon-once (Phase 8.9) — "arceus already restores across relaunches
    // when his session survives" (a live `claude --resume` above, present
    // in `restored` with no `error`); this covers when it DIDN'T: resume
    // failed and sessionRespawn.ts fell back to a plain shell (marked by
    // `error` on the restored record — a shell wearing Arceus's face is not
    // Arceus), or he simply wasn't summoned yet this launch at all. An idle
    // interactive `claude` session consumes no tokens until prompted, so
    // auto-summoning him here on every launch is cost-safe — only the
    // ORIGINAL summon (SummonArceusDialog) ever writes the config this
    // reads back. Fire-and-forget: never blocks first paint (or the
    // `render()` below), and a failure becomes a quiet toast, never a
    // dialog — see arceus.ts's `autoSummonArceus`.
    const arceusRestoredLive = restored.some((r) => r.session.isArceus && !r.session.error);
    if (!arceusRestoredLive) {
      void autoSummonArceus().then((outcome) => {
        if (outcome === 'failed') {
          useStore.getState().pushToast("arceus couldn't return — click his chip to re-summon.");
        }
      });
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
