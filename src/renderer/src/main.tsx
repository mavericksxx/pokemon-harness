import { createRoot } from 'react-dom/client';
import { App } from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import { useStore } from './store/store';
import { startSession, stopSession, startRegistrySync, startCompletionToasts, startDelegateSpawnListener } from './sessions';
import { autoSummonArceus, startArceusRelayToasts } from './arceus';
import { createTerminal, applyTerminalTheme } from './pty/terminalRegistry';
import { startFocusQueueFlush } from './pty/focusQueue';
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
import { useUsageStore } from './store/usageStore';
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

// macOS fullscreen-aware topbar inset — registered synchronously here
// (before boot()'s async work) rather than in a React effect, so the
// listener is already attached by the time main's did-finish-load push
// arrives, same rationale as the quit-intercept listener above.
window.api.onFullscreenChange((isFullScreen) => useStore.getState().setIsFullScreen(isFullScreen));

// In-app provider usage-limits panel (BACKLOG "next up" item 1) — same
// independent-of-boot()'s-async-work wiring as the fullscreen listener
// above; main only ever actually PUSHES on this channel while the toggle is
// on (usageService.ts), so this listener is a no-op cost while it's off.
window.api.onUsageSnapshot((snapshot) => useUsageStore.getState().hydrate(snapshot));

// Local-only diagnostics (BACKLOG item 1) — error capture + invariant
// counters, both independent of boot()'s async recovery work, same as the
// listeners above. `data` is kept to plain scalars/strings at both call
// sites, matching diagnosticsClient.ts's own safety note.
//
// De-duped (parity sweep item 2) — a browser layout loop (observed:
// "ResizeObserver loop completed with undelivered notifications", a benign
// Chromium symptom, not a crash) can fire the same window error hundreds of
// times a second; unthrottled, that filled harness.log with 852 identical
// rows in one ~7s burst. Keyed on the message text alone (the one thing
// guaranteed identical across repeats of the SAME error) — logs the first
// occurrence immediately so a one-off error is never delayed, then at most
// one "seen N more times" summary per distinct message per minute. Generic
// by design: any repeated identical error is throttled this way, not just
// ResizeObserver's.
const DEDUPE_WINDOW_MS = 60_000;
// A crude bound on distinct messages tracked — real renderer errors are rare
// enough that this never matters in practice; it's just a floor against an
// error whose text itself varies per occurrence (e.g. embeds a changing id)
// growing this map forever instead of ever de-duping.
const MAX_TRACKED_MESSAGES = 200;
const errorLogState = new Map<string, { suppressed: number; windowStart: number }>();
function logDedupedError(message: string, data?: unknown): void {
  const now = Date.now();
  const state = errorLogState.get(message);
  if (!state) {
    if (errorLogState.size >= MAX_TRACKED_MESSAGES) errorLogState.clear();
    errorLogState.set(message, { suppressed: 0, windowStart: now });
    safeLogDiagnostic('renderer', 'error', message, data);
    return;
  }
  if (now - state.windowStart >= DEDUPE_WINDOW_MS) {
    if (state.suppressed > 0) {
      safeLogDiagnostic('renderer', 'error', `${message} (x${state.suppressed} more in the last minute)`, data);
    }
    state.suppressed = 0;
    state.windowStart = now;
  } else {
    state.suppressed++;
  }
}
window.addEventListener('error', (e) => {
  logDedupedError(e.message || 'window error', {
    filename: e.filename,
    lineno: e.lineno,
    colno: e.colno,
    stack: e.error instanceof Error ? e.error.stack : undefined
  });
});
window.addEventListener('unhandledrejection', (e) => {
  const reason: unknown = e.reason;
  logDedupedError('unhandled promise rejection', {
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

// Chromium can move every scrollable-box ancestor, including overflow-hidden
// layout containers, while revealing the IME composition caret in xterm's
// hidden helper textarea. Keep intentional panes and xterm's own scrollers
// free to scroll, but clamp every other element that Chromium shifts.
const documentScrollGuardTargets = [document.documentElement, document.body, rootEl];
const documentScrollGuardExemptSelector =
  '.session-chips, .garden-chips, .pokemon-picker, .drawer-tabs, .modal, ' +
  '.usage-popover-panel, .mini-player-list, .roster-strip, .focus-sidebar, ' +
  '.sessions-overview, .settings-rail, .settings-content-body, .xterm, ' +
  '.overflow-chip-menu, textarea, input, select';
const clampScrollPosition = (target: Element) => {
  if (target.scrollLeft !== 0) target.scrollLeft = 0;
  if (target.scrollTop !== 0) target.scrollTop = 0;
};

document.addEventListener(
  'scroll',
  (event) => {
    const target = event.target;
    if (target === document) {
      for (const target of documentScrollGuardTargets) clampScrollPosition(target);
      return;
    }
    if (!(target instanceof Element) || target.closest(documentScrollGuardExemptSelector)) return;
    clampScrollPosition(target);
  },
  { capture: true, passive: true }
);

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
    startArceusRelayToasts();
    // First-class delegate sessions (shared/delegateSpawn.ts) — adopts each
    // app-spawned `codex exec` pty main pushes over `delegate:sessionSpawned`
    // as an ordinary session (roster card + terminal). See sessions.ts's
    // `startDelegateSpawnListener` for the full sequencing rationale.
    startDelegateSpawnListener();
    // BACKLOG phase E — focus mode's queue composer; see focusQueue.ts's own
    // header for why this lives renderer-side rather than main.
    startFocusQueueFlush();

    // xterm measures glyph width once at `term.open()` and never re-measures
    // on a later font swap, so JetBrains Mono must be ready before any
    // restored session's terminal can attach (TerminalDrawer's effect, which
    // fires right after this function's `render()` below). Bundled locally
    // (fonts.css) — resolves near-instantly, but "near-instant" is still not
    // "before". Fired in parallel with the IPC round-trips below, awaited
    // just after.
    const fontsReady = document.fonts.load(`14px "JetBrains Mono"`);

    const [
      crashInfo,
      { sessions: restored, selectedId },
      diskRestoreInfo,
      codexHooksNotice,
      appSettings,
      harnessHomePath,
      workspaceSnapshot,
      usageSnapshot
    ] = await Promise.all([
      window.api.getCrashInfo(),
      window.api.restoreSessions(),
      // Non-null exactly once, on the launch that respawned disk-persisted
      // sessions (Phase 8.5 #1) — mutually exclusive with `crashInfo` (that's
      // a same-process renderer reload; this is a fresh app launch).
      window.api.getDiskRestoreInfo(),
      // External-codex-delegate feature — non-null exactly once, on the
      // launch that merged a fresh pokeharness entry into codex's hooks.json
      // (main/codexHooks.ts). Independent of the restore/crash toasts above.
      window.api.getCodexHooksNotice(),
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
      window.api.listWorkspaces(),
      // Usage limits (BACKLOG "next up" item 1) — a plain cache read (never
      // triggers a fetch); empty/disabled if the toggle was off at boot, or
      // just genuinely not polled yet. The `onUsageSnapshot` listener above
      // keeps this live from here on.
      window.api.getUsageSnapshot()
    ]);
    await fontsReady;

    useAppSettingsStore.getState().hydrate(appSettings);
    useAppSettingsStore.getState().hydrateHarnessHomePath(harnessHomePath);
    useWorkspaceStore.getState().hydrate(workspaceSnapshot);
    useUsageStore.getState().hydrate(usageSnapshot);
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

    // External-codex-delegate feature — independent of the restore/crash
    // toast above (both can fire on the same launch).
    if (codexHooksNotice) useStore.getState().pushToast(codexHooksNotice);

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
    safeLogDiagnostic('renderer', 'error', 'boot() crash/reload recovery failed — starting with an empty garden', {
      message: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined
    });
  } finally {
    // Deliberately NOT wrapped in StrictMode: the Pixi application and the
    // PTY subscriptions are real, non-idempotent resources, and StrictMode's
    // dev-only double mount would build two gardens.
    // Non-null: TS doesn't carry the module-scope `if (!rootEl) throw`
    // guard's narrowing into this nested function; the guard above already ran.
    // ErrorBoundary (BACKLOG friend-testing readiness) — a React render-phase
    // throw anywhere below this used to unmount the whole app with zero
    // trace in harness.log; see that component's own header.
    createRoot(rootEl!).render(
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    );
  }
}

void boot();
