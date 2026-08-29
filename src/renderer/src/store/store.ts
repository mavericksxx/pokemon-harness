import { create } from 'zustand';
import type { SessionRecord } from '@shared/types';
import { DEFAULT_GARDEN_SPLIT } from '@/gardenSplit';

/** Field-for-field `SessionRecord` (shared/types.ts) — kept as a local alias
 *  so call sites here read the same as before the crash-recovery work moved
 *  the shape to `shared/` (main needs it too, to mirror sessions for a
 *  post-crash `restoreSessions` — see main/index.ts and
 *  src/renderer/src/sessions.ts's `startRegistrySync`). */
export type Session = SessionRecord;

/** Walker tints, cycled per session. */
const ACCENTS = [0xffd166, 0x8ecae6, 0xff8fa3, 0xb5e48c, 0xc8a2ff, 0xffb27a];

/** Auto-dismiss delay for a toast, ms. */
const TOAST_DURATION_MS = 4500;

/** A live subagent battler, mirrored into the store just far enough for the
 *  roster strip to render a card for it (Phase 4 Part B follow-up —
 *  "subagent battlers in the bottom agent bar"). The battler itself lives
 *  entirely in BattleManager/Pixi; this is a one-way bridge (BattleManager's
 *  onBattlerSpawned/onBattlerRemoved deps, wired in GardenScene.tsx), not a
 *  second source of truth — nothing here ever drives the simulation back. */
export interface LiveBattler {
  /** BattleManager's own per-battler id (`${parentId}#${seq}`) — stable for
   *  this battler's whole lifetime, used as the React list key. */
  key: string;
  /** The session whose Task tool call spawned this battler. */
  parentId: string;
  /** Dex id, same shape as `Session.pokemon`. */
  species: string;
  /** The spawning `Task`'s own `description` (falling back to
   *  `subagent_type`) — parity sweep item 7: a real name/description DOES
   *  exist at spawn time (the CLI's own Task tool_input, surfaced via
   *  hookRouter.ts's PreToolUse handling — see battleBus.ts's `spawn`
   *  signal), so SubagentRosterCard.tsx uses it as the card's title line,
   *  mirroring AgentRosterCard's own title-then-species layout. Undefined
   *  for the regex-fallback path (ptyParser.ts, no tool_input to read) —
   *  that card falls back to species-as-title instead. */
  label?: string;
  /** Epoch ms this battler entered the world (stamped by `addBattler`, the
   *  same moment BattleManager's onBattlerSpawned fires). Per-subagent
   *  context/token telemetry doesn't exist — a subagent's completion never
   *  reaches costWatcher.ts's per-session cost:update stream — so
   *  SubagentRosterCard shows elapsed time since spawn instead, as the one
   *  real number available for a battler. */
  spawnedAt: number;
  /** Done/retired follow-up: true once this battler lost its completion
   *  battle (or aged out into one) and went off-duty — mirrored from
   *  BattleManager's own `retired` lifecycle via the `onBattlerDone` bridge
   *  (GardenScene.tsx). SubagentRosterCard shows a green done status and a
   *  despawn action while true. Flips back to false (`reviveRetired`,
   *  BattleManager.ts) if a resumed task-id revives this exact battler in
   *  place instead of a duplicate spawning. Always present (not optional) —
   *  every construction site (`addBattler`'s default, `respawnFromStore`'s
   *  pass-through) sets it explicitly. */
  done: boolean;
  /** Epoch ms this battler most recently became `done` — stamped by
   *  `setBattlerDone(key, true)`, cleared back to undefined on revival. The
   *  one number SubagentRosterCard needs to freeze its "done — ran Xm"
   *  readout instead of it continuing to climb after the subagent has
   *  actually finished. */
  doneAt?: number;
}

export interface Toast {
  id: string;
  text: string;
  /** Optional single action button (Phase 8.5 #3's "steer" offer on a
   *  looping session) — dismisses the toast when clicked, same as clicking
   *  the toast body itself does. */
  action?: { label: string; onClick: () => void };
}

/** One of three layouts (was four — 'terminalFull' was dropped: it and
 *  'terminal' both hid the garden and gave the terminal the whole body, and
 *  users reported the two view-switcher buttons as duplicates. 'terminal'
 *  is the one that survived — its bottom roster strip is the same
 *  session-switching UI 'garden' mode already uses, instead of
 *  'terminalFull's topbar chips + drawer tab strip):
 *   'garden'     — garden fills the body, terminal drawer toggles as a side
 *                  panel (`drawerOpen`).
 *   'terminal'   — munder-difflin's layout: a bottom roster strip of agent
 *                  cards, terminal owning the rest. Garden stays mounted
 *                  (simulation keeps running) but hidden.
 *   'gardenFull' — garden fills the whole body, no terminal. */
export type ViewMode = 'garden' | 'terminal' | 'gardenFull';

const VIEW_MODE_STORAGE_KEY = 'poke:viewMode';
const VALID_VIEW_MODES: readonly ViewMode[] = ['garden', 'terminal', 'gardenFull'];

/** Best-effort read of the last view mode — localStorage can throw (private
 *  browsing/disabled storage); default to the pre-Phase-8 layout on failure. */
function loadViewMode(): ViewMode {
  try {
    const v = window.localStorage.getItem(VIEW_MODE_STORAGE_KEY);
    if (v && (VALID_VIEW_MODES as string[]).includes(v)) return v as ViewMode;
  } catch {
    /* ignore */
  }
  return 'garden';
}

/** Garden/terminal split (garden's fraction of `.body-row`'s width, 'garden'
 *  view mode's side-by-side layout only) — same persistence pattern as
 *  `viewMode` above. Kept as a plain number rather than derived px so it
 *  survives a window resize unchanged (gardenSplit.ts's `terminalWidthCss`
 *  re-applies both floors against whatever the row's width is now). */
const GARDEN_SPLIT_STORAGE_KEY = 'poke:gardenSplit';

function loadGardenSplit(): number {
  try {
    const v = window.localStorage.getItem(GARDEN_SPLIT_STORAGE_KEY);
    const n = v == null ? NaN : Number(v);
    if (Number.isFinite(n) && n > 0 && n < 1) return n;
  } catch {
    /* ignore */
  }
  return DEFAULT_GARDEN_SPLIT;
}

interface HarnessState {
  sessions: Session[];
  selectedId: string | null;
  drawerOpen: boolean;
  toasts: Toast[];
  /** Live subagent battlers, across every parent session (see `LiveBattler`).
   *  Not workspace-scoped itself — RosterStrip filters by matching
   *  `parentId` against its own already-scoped session list. */
  battlers: LiveBattler[];
  /** Set by SubagentRosterCard's click (garden/terminal split navigation) so
   *  GardenScene's ticker pans the camera onto this battler's own sprite
   *  instead of the parent walker it just selected — one-shot in effect
   *  (holds until the next real selection, which `select` below clears it
   *  on) rather than a persisted mode. Null = normal follow-the-selected-
   *  session camera behavior. */
  focusBattlerKey: string | null;
  /** Pending despawn requests (SubagentRosterCard's despawn button) — see
   *  `requestDespawnBattler`/`drainDespawnBattlerKeys` below. */
  despawnBattlerKeys: string[];
  viewMode: ViewMode;
  /** Garden's fraction of `.body-row`'s width, dragged via
   *  GardenSplitHandle.tsx — see the `GARDEN_SPLIT_STORAGE_KEY` comment
   *  above. */
  gardenSplit: number;
  /** Sessions-overview grid (Phase 8 §3) — a topbar button and (Phase 8 §7)
   *  the garden's signpost prop both open it. */
  sessionsOverviewOpen: boolean;
  /** Settings panel (Phase 8 §5) — a topbar gear button and (Phase 8 §7)
   *  the garden's well prop both open it. */
  settingsOpen: boolean;
  /** Quit-intercept dialog (parity sweep item 2) — opened when main prevents
   *  a close/quit because sessions are still live; `quitDialogCount` is
   *  main's own authoritative live-session count (see closingTime.ts's
   *  `startQuitInterceptListener`). */
  quitDialogOpen: boolean;
  quitDialogCount: number;
  /** macOS fullscreen state, pushed from main (main.tsx's
   *  `window.api.onFullscreenChange` listener; see main/index.ts's
   *  `enter-full-screen`/`leave-full-screen` handlers). Drives the topbar's
   *  traffic-light-safe inset in App.tsx. */
  isFullScreen: boolean;

  addSession(
    s: Omit<Session, 'accent' | 'createdAt' | 'status' | 'station' | 'workedMs'>
  ): Session;
  /** Evolution lines already spoken for by a live session — the picker greys
   *  these out and startSession avoids them, so no two walkers are on the same
   *  line at once. */
  takenLines(): string[];
  updateSession(id: string, patch: Partial<Session>): void;
  removeSession(id: string): void;
  /** Boot-time crash recovery (main/index.ts's `sessions:restore`): replaces
   *  the session list outright with already-complete records (no defaults to
   *  fill in, unlike `addSession`), so the drawer and garden pick them
   *  straight back up. `selectedId` is whatever main last saw selected
   *  (null if that session didn't come back, or nothing was selected) —
   *  falls back to the first restored session so a non-empty restore never
   *  leaves the drawer showing nothing. */
  restoreSessions(sessions: Session[], selectedId: string | null): void;
  /** Clears `focusBattlerKey` too — see that field's own comment — so a
   *  battler-focus left over from a subagent-card click doesn't survive a
   *  genuinely new selection (a different roster card, a walker click, a
   *  deselect). SubagentRosterCard sets `focusBattlerKey` back via
   *  `setFocusBattlerKey` right after calling this. */
  select(id: string | null): void;
  setFocusBattlerKey(key: string | null): void;
  setDrawerOpen(open: boolean): void;
  /** Switches the Phase 8 §1 layout and persists it (survives relaunch and
   *  the crash-recovery reload). */
  setViewMode(mode: ViewMode): void;
  /** Updates the live split ratio; `persist` (default false) additionally
   *  banks it as the default for next launch. Drag ticks pass `false` (see
   *  GardenSplitHandle.tsx's rAF-throttled pointermove) so a fast drag
   *  doesn't hit localStorage every frame — pointerup/double-click-reset
   *  pass `true` once, at the end. */
  setGardenSplit(ratio: number, persist?: boolean): void;
  setSessionsOverviewOpen(open: boolean): void;
  setSettingsOpen(open: boolean): void;
  setQuitDialogOpen(open: boolean, count?: number): void;
  setIsFullScreen(isFullScreen: boolean): void;
  /** Non-blocking notification (e.g. a lazy sprite fetch failure). Dismisses
   *  itself after a few seconds. `action` adds a single button (Phase 8.5 #3). */
  pushToast(text: string, action?: Toast['action']): void;
  dismissToast(id: string): void;
  /** BattleManager's onBattlerSpawned bridge (GardenScene.tsx) — a wild
   *  battler just materialized. `spawnedAt` is stamped here (Date.now()),
   *  not passed in — this call IS the moment of spawn as far as the store's
   *  concerned. `done`/`doneAt` are optional here (defaults to `false`/
   *  undefined) so a fresh spawn's payload — which never carries either —
   *  doesn't need to fake them, while the garden-rebuild respawn path (which
   *  DOES already know a battler's `done` state, from the pre-teardown
   *  snapshot) can pass them straight through unchanged. */
  addBattler(battler: Omit<LiveBattler, 'spawnedAt' | 'done'> & { done?: boolean; doneAt?: number }): void;
  /** BattleManager's onBattlerRemoved bridge — a battler poofed out (or was
   *  hard-torn-down with its parent session). No-op if already gone. Also
   *  clears `focusBattlerKey` if it named this battler, so the garden
   *  camera doesn't keep re-checking a dead key every tick. */
  removeBattler(key: string): void;
  /** BattleManager's onBattlerDone bridge (GardenScene.tsx) — flips
   *  `LiveBattler.done` both directions: `true` when a battler loses its
   *  completion battle (or ages out into one) and retires off-duty, `false`
   *  when a resumed task-id revives that same battler in place. Stamps/
   *  clears `doneAt` to match. No-op if the key is already gone (a despawn
   *  raced ahead of this). */
  setBattlerDone(key: string, done: boolean): void;
  /** Despawn requests queued by SubagentRosterCard's despawn button, drained
   *  once per frame by GardenScene's ticker (`drainDespawnBattlerKeys`) and
   *  handed to BattleManager.despawnBattler — a queue, not a single slot, so
   *  two cards dismissed in the same frame can't clobber each other. */
  requestDespawnBattler(key: string): void;
  /** Atomically returns and clears the queue above — called once per frame
   *  from GardenScene's ticker, never from React. */
  drainDespawnBattlerKeys(): string[];
}

export const useStore = create<HarnessState>((set, get) => ({
  sessions: [],
  selectedId: null,
  drawerOpen: true,
  toasts: [],
  battlers: [],
  focusBattlerKey: null,
  despawnBattlerKeys: [],
  viewMode: loadViewMode(),
  gardenSplit: loadGardenSplit(),
  sessionsOverviewOpen: false,
  settingsOpen: false,
  quitDialogOpen: false,
  quitDialogCount: 0,
  isFullScreen: false,

  addSession: (s) => {
    const session: Session = {
      ...s,
      status: 'starting',
      station: 'wander',
      workedMs: 0,
      accent: ACCENTS[get().sessions.length % ACCENTS.length],
      createdAt: Date.now()
    };
    set((st) => ({ sessions: [...st.sessions, session], selectedId: session.id }));
    return session;
  },

  takenLines: () => get().sessions.map((s) => s.line),

  updateSession: (id, patch) =>
    set((st) => {
      const i = st.sessions.findIndex((s) => s.id === id);
      if (i === -1) return st;
      const next = st.sessions.slice();
      next[i] = { ...next[i], ...patch };
      return { sessions: next };
    }),

  removeSession: (id) =>
    set((st) => {
      const sessions = st.sessions.filter((s) => s.id !== id);
      // Cascade directly rather than relying solely on GardenScene's
      // reconcile -> removeWalker -> forceEnd indirection to drop this
      // session's battlers — that path only runs on the next scene
      // reconcile tick, so a snapshot of `battlers` taken between this call
      // and that tick would still list cards for a session that's already
      // gone. BattleManager.forceEnd (called from that same indirection)
      // still runs and is idempotent against this — removeBattler filters
      // by key, so a battler already dropped here is simply a no-op there.
      const battlers = st.battlers.filter((b) => b.parentId !== id);
      return {
        sessions,
        battlers,
        selectedId: st.selectedId === id ? (sessions[0]?.id ?? null) : st.selectedId
      };
    }),

  restoreSessions: (sessions, selectedId) =>
    set({ sessions, selectedId: selectedId ?? sessions[0]?.id ?? null }),

  select: (id) => set({ selectedId: id, focusBattlerKey: null }),
  setFocusBattlerKey: (key) => set({ focusBattlerKey: key }),
  setDrawerOpen: (open) => set({ drawerOpen: open }),
  setViewMode: (mode) => {
    try {
      window.localStorage.setItem(VIEW_MODE_STORAGE_KEY, mode);
    } catch {
      /* ignore — mode still applies for this session */
    }
    set({ viewMode: mode });
  },
  setGardenSplit: (ratio, persist = false) => {
    if (persist) {
      try {
        window.localStorage.setItem(GARDEN_SPLIT_STORAGE_KEY, String(ratio));
      } catch {
        /* ignore — ratio still applies for this session */
      }
    }
    set({ gardenSplit: ratio });
  },
  setSessionsOverviewOpen: (open) => set({ sessionsOverviewOpen: open }),
  setSettingsOpen: (open) => set({ settingsOpen: open }),
  setQuitDialogOpen: (open, count) => set((st) => ({ quitDialogOpen: open, quitDialogCount: count ?? st.quitDialogCount })),
  setIsFullScreen: (isFullScreen) => set({ isFullScreen }),

  pushToast: (text, action) => {
    const id = `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    set((st) => ({ toasts: [...st.toasts, { id, text, action }] }));
    window.setTimeout(() => get().dismissToast(id), TOAST_DURATION_MS);
  },
  dismissToast: (id) => set((st) => ({ toasts: st.toasts.filter((t) => t.id !== id) })),

  addBattler: (battler) =>
    set((st) => ({
      battlers: [...st.battlers, { ...battler, done: battler.done ?? false, spawnedAt: Date.now() }]
    })),
  removeBattler: (key) =>
    set((st) => ({
      battlers: st.battlers.filter((b) => b.key !== key),
      focusBattlerKey: st.focusBattlerKey === key ? null : st.focusBattlerKey
    })),
  setBattlerDone: (key, done) =>
    set((st) => ({
      battlers: st.battlers.map((b) => (b.key === key ? { ...b, done, doneAt: done ? Date.now() : undefined } : b))
    })),
  requestDespawnBattler: (key) => set((st) => ({ despawnBattlerKeys: [...st.despawnBattlerKeys, key] })),
  drainDespawnBattlerKeys: () => {
    const keys = get().despawnBattlerKeys;
    if (keys.length > 0) set({ despawnBattlerKeys: [] });
    return keys;
  }
}));
