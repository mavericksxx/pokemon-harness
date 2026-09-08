/**
 * Shared types for the battle subsystem — pure move, extracted verbatim from
 * BattleManager.ts (no behavior change). See that file's own header for the
 * full subagent-battle design writeup these types support.
 */
import { Container } from 'pixi.js';
import type { Walker } from '../Walker';
import type { TiledMapRenderer } from '../TiledMapRenderer';
import type { PokemonAnimation } from '../showdownArt';
import type { DexEntry } from '../dexData';

/**
 * Everything this manager's wave/attack/mega machinery actually touches on a
 * sub's fighter — the FULL surface, taken from an exhaustive grep of every
 * `sub.battler.*` / `s.battler.*` / `a.attacker.battler.*` in this file, not
 * from a guess. (`setAnimation` is deliberately absent: it's only ever called
 * on a local `const battler = new Battler(...)` inside the three spawn paths,
 * never through a `SubBattler`.)
 *
 * DELEGATE BATTLE PARITY (the reason this exists at all): a `poke-delegate`
 * session is a real `Session` with its own independent `Walker`, and when it
 * finishes it should get the same one completion battle against its parent
 * that a Claude Agent-tool subagent's `Battler` does — same choreography, same
 * GLOBAL one-at-a-time lock, same mega eligibility. Widening `SubBattler.
 * battler` from the concrete `Battler` to this interface is what lets
 * `WalkerChallenger` (a thin adapter over that already-live `Walker`) enter
 * the queue through the exact same path, with ZERO branches in the wave
 * machinery itself. `Battler` satisfies this structurally and is unchanged —
 * every existing Claude-subagent code path behaves identically.
 */
export interface Challenger {
  readonly container: Container;
  readonly bubbleContainer: Container;
  readonly species: DexEntry;
  /** Plain mutable field, not a getter — `admitBattle`/
   *  `pickChallengerStandTileFor` assign it directly. */
  standTile: { x: number; y: number } | null;
  readonly tile: { x: number; y: number };
  readonly drawnHeight: number;
  readonly isSpawning: boolean;
  readonly isPoofedOut: boolean;
  /** Issue #7 (dirty-flag predicate) — true only WHILE a poof-out scale
   *  tween is actively running, as opposed to `isPoofedOut` (true only once
   *  it's finished). See `Battler.isPoofingOut`'s own comment for why this
   *  needs to exist alongside `isPoofedOut` at all. */
  readonly isPoofingOut: boolean;
  readonly arrived: boolean;
  /** Pixi's own `Container.destroyed` for this challenger's underlying
   *  display object (`Battler`: its own `.container`; `WalkerChallenger`:
   *  the delegate's live `Walker.container`, which GardenScene may destroy
   *  independently of this manager — see `dropChallenger`). Added for the
   *  2026-09-07 crash-loop fix (harness.log: one throw logged 34,295 times
   *  in 7.5 minutes, same parentId, subCount 1 — `Cannot set properties of
   *  null (setting 'y')` inside `WalkerSprite.applyTransform`) — see
   *  `dropDestroyedSubs`'s own doc comment for the full root-cause writeup.
   *  That specific crash stack is a `Battler` (via `WalkerSprite`), not a
   *  `WalkerChallenger` — `WalkerChallenger.update` writes `.x` before `.y`
   *  and would throw on `'x'` first if its own walker were the one destroyed
   *  out from under it, never reaching `WalkerSprite.applyTransform`'s `.y`
   *  at all. This getter is on the shared interface (and implemented by
   *  both classes) purely for uniform defense in `dropDestroyedSubs`, not
   *  because a `WalkerChallenger` was implicated in the actual repro. */
  readonly destroyed: boolean;
  goTo(tile: { x: number; y: number }): boolean;
  update(dt: number): void;
  syncBubblePosition(): void;
  setBattleStance(): void;
  clearBattleStance(): void;
  showBubbleLabel(): void;
  showAttack(tool: string, target?: string): void;
  showMoveText(text: string): void;
  hideBubble(): void;
  startPoofOut(): void;
  startRecall(onDone: () => void): void;
  destroy(): void;
}

/** One spawned subagent's own battler + where it is in its lifecycle. */
export interface SubBattler {
  key: string;
  battler: Challenger;
  /** The animation currently protected from lazySprites.ts's cache eviction
   *  (see pinAnimation/unpinAnimation) — only ever set for a plain `Battler`
   *  fighter this manager owns. A delegate's `WalkerChallenger` wraps a live
   *  session's own `Walker`, which already pins its own current animation for
   *  its whole lifetime (see Walker.ts) — this stays null for that sub, and
   *  `releaseSubPin` is a no-op on it. Null until this sub's first animation
   *  is pinned at spawn, cleared once its battler is destroyed. */
  pinnedAnimation: PokemonAnimation | null;
  /** 'retired': lost its completion battle (or aged out into one) and is now
   *  off-duty — resumes ordinary wandering (`updateRoaming`), never re-
   *  queues, stays until despawned. 'despawning': a player-initiated pokéball
   *  recall is in flight (`despawnBattler`) — its own completion callback
   *  does the final removal, NOT `reapSubs` (see that method's own comment).
   *  'leaving' is now reached only via `handleEndAll`'s coarse cleanup. */
  lifecycle: 'roaming' | 'queued' | 'battling' | 'leaving' | 'retired' | 'despawning';
  /** The spawning dispatch's own `description`/`subagent_type` (see
   *  battleBus.ts's `spawn` signal) — kept on the sub (not just forwarded to
   *  the store) so a RESUME can re-materialize a battler with the same label
   *  (`handleCorrelate`'s `retiredTaskInfo`). */
  label?: string;
  /** This battler's spawning dispatch's `tool_use_id` (battler ↔ task-id
   *  correlation fix) — the one identity available at spawn time, before any
   *  CLI-internal task-id exists. Null for the regex-fallback path
   *  (ptyParser.ts, no hook payload to read one from) and for a garden
   *  context-loss recovery (`respawnFromStore`, no correlation survives a
   *  renderer rebuild). Cleared to irrelevance once `taskId` is stamped —
   *  kept around only so `handleCorrelate` can find this sub by it. */
  toolUseId: string | null;
  /** The CLI-internal task-id (`toolUseResult.agentId`) this battler's
   *  dispatch was correlated to, once `handleCorrelate` links its
   *  `toolUseId` to a completion's task-id — see the file header's battler ↔
   *  task-id correlation fix. Null until stamped; a battler that's never
   *  stamped (correlation raced ahead, or predates this fix) still falls
   *  back to `handleEnd`'s oldest-roaming heuristic exactly as before. */
  taskId: string | null;
  /** Best-effort Claude CLI-internal subagent id observed on a subagent-scoped
   *  PreToolUse. Usually absent; when the single-roamer fallback attributes
   *  one event, retaining it lets later events keep following that battler if
   *  another sibling starts roaming. */
  subagentId: string | null;
  /** DELEGATE BATTLE PARITY — the SESSION id of the `poke-delegate` session
   *  whose own `Walker` this sub wraps (`queueDelegateChallenge`), or null for
   *  every ordinary Claude-subagent sub. This is the one discriminator: a
   *  non-null value means the fighter is a `WalkerChallenger` over a live
   *  session's walker that this manager does NOT own — see `isDelegateSub` for
   *  the (small, all skip-shaped) set of places that has to matter. */
  delegateSessionId: string | null;
  /** Where this battler roams — chosen once at spawn (`pickRoamHome`) and
   *  never recomputed; a battler never re-enters roaming after its one
   *  completion battle. */
  wanderHome: { x: number; y: number };
  wanderTimer: number;
  wanderDelay: number;
  /** Epoch ms this battler started roaming — the basis for `MIN_ROAM_MS`
   *  (`handleParentDone`) and `handleEnd`'s oldest-first tie-break. */
  roamingSince: number;
  /** Set by `handleParentDone` when a `parentDone` signal arrives before
   *  this sub has cleared `MIN_ROAM_MS` — the epoch ms it BECOMES eligible
   *  to queue (checked every tick in `updateOneBattle`), rather than the
   *  signal just being dropped. Without this, a subagent whose parent's
   *  `Stop` arrives within the floor (plausible for a short subagent in a
   *  fast wave — the exact pattern the orchestrator's live repro showed)
   *  would only ever queue on a LATER `Stop` for that same parent, which may
   *  never come if the session doesn't prompt again — "late is fine"
   *  stretched into "never". Null while not applicable. */
  queueEligibleAt: number | null;
  /** Epoch ms this battler was queued for its completion battle — the
   *  GLOBAL FIFO tie-break across every parent's subs (`pickNextQueued`). 0
   *  until queued. */
  queuedSince: number;
  /** One-shot: logged the first tick this battler's poof-in actually
   *  finishes, so "materialized but never became visible" (the invisible-
   *  subagent bug — see file header) is findable in the diagnostics log
   *  instead of only inferable from frozen counter snapshots after the
   *  fact. */
  visibleLogged: boolean;
  /** State for the intermittent roaming label. */
  roamLabelElapsedMs: number;
  roamLabelCycleMs: number;
  roamBubbleMode: 'hidden' | 'label' | 'tool';
}

export interface Attack {
  attacker: SubBattler | 'parent';
  defender: SubBattler | 'parent';
  tool: string;
  combo: number;
  elapsedMs: number;
  hitApplied: boolean;
  /** How many times `handleAttack` has restarted THIS beat's timeline —
   *  capped at MAX_COMBO_RESTARTS (see that constant's own comment). */
  restarts: number;
}

export interface ParentBattle {
  parentId: string;
  parentWalker: Walker;
  /** Every live subagent for this parent, any lifecycle — the only
   *  authoritative list; nothing is removed from it until fully destroyed. */
  subs: SubBattler[];
  /** The one sub currently choreographing THIS wave (empty while
   *  `wave === 'idle'`). Still an array (not a single field) so the
   *  existing arc/multi-slot machinery (pickChallengerStandTileFor,
   *  gapTilesForBatch) needs no signature change for MAX_RING=1. */
  waveRing: SubBattler[];
  wave: 'idle' | 'alert' | 'approaching' | 'faceoff' | 'looping' | 'ending';
  waveElapsedMs: number;
  waveAttacks: number;
  alertShown: boolean;
  currentAttack: Attack | null;
  lastAttackerWasParent: boolean;
  roundRobinIdx: number;
  /** Where the parent walks TO for the CURRENT wave — recomputed fresh at
   *  the start of every wave, since the parent resumes its own life between
   *  battles and may have moved. */
  parentStandTile: { x: number; y: number } | null;
  /** A tool event that arrived before the wave reached its loop (still
   *  approaching or facing off) — coalesced here instead of dropped, opened
   *  as the first scripted attack's flavor the instant face-off completes. */
  pendingTool: string | null;
  pendingCombo: number;
  nextSeq: number;
  /** Epoch ms the current wave was admitted — the basis for the stuck-
   *  watchdog checks below. */
  waveStartedAt: number;
  /** Per-wave stuck cap for the `alert`/`approaching` phases, computed fresh
   *  in `admitBattle` from the actual walk distance (see WAVE_STUCK_MIN_MS's
   *  own comment on why this can't be a flat constant anymore). */
  waveStuckCapMs: number;
  /** True from the moment `startMega` successfully KICKS OFF a mega (async —
   *  see that method) until `revertMega` releases it. Note "kicks off", not
   *  "applies": the sprite itself only changes at the ceremony's flash peak
   *  a few seconds later (Walker.startMegaCeremony), and this flag has to
   *  cover the buildup too, or a second `startMega` for the same wave would
   *  see no mega in flight. `revertMega` during the buildup is the abort
   *  path and applies nothing — see Walker's `tempFormBase` invariant. */
  megaActive: boolean;
  /** True while a mega ceremony is playing and this wave is therefore HELD in
   *  place — nothing advances (no face-off countdown, no attack, no ending
   *  beat) until the ceremony finishes, the same shape as `updateAlert`
   *  holding the wave until the "!" bubble finishes its pop cycle. Always
   *  false under reduced motion, where the mega swap is instant and there is
   *  nothing to wait for. */
  megaHold: boolean;
}

export interface BattleDeps {
  map: TiledMapRenderer;
  charLayer: Container;
  /** Bundled species resolve instantly; anything else starts as a pokeball
   *  and is upgraded via loadLazyAnimation, matching GardenScene's own
   *  walkers. */
  resolveAnimation: (species: string, shiny?: boolean) => PokemonAnimation;
  loadLazyAnimation: (species: string, shiny?: boolean) => Promise<PokemonAnimation | null>;
  getRuntime: (parentId: string) => { walker: Walker } | undefined;
  /** The parent session's current species display name, for move text
   *  ("Pikachu used Grep!"). */
  getParentLabel: (parentId: string) => string;
  /** The parent session's current species dex id, for sizing the face-off gap
   *  (a Snorlax-class parent needs more room than a Pichu-class one). */
  getParentSpeciesId: (parentId: string) => string | undefined;
  /** Whether the parent session's Pokemon is shiny — mega evolution reuses
   *  the shiny variant of the mega sprite when true (falling back to
   *  non-shiny mega, then to no mega, on a 404 — see megaForms.ts). */
  getParentShiny: (parentId: string) => boolean;
  /** Evolution lines already spoken for by a live SESSION (not battlers —
   *  BattleManager tracks its own separately). */
  activeSessionLines: () => string[];
  /** Called every time a wave concludes and no new one starts right away —
   *  i.e. whenever the parent is free to resume its own normal life. */
  onBattleEnd: (parentId: string) => void;
  /** Fires the instant a wild battler actually enters the world (already
   *  added to charLayer, same moment `subagentsMaterialized` bumps) — the
   *  bridge GardenScene uses to mirror battler presence into the zustand
   *  store for the roster strip's subagent cards. `label` (parity sweep item
   *  7) — the spawning `Task`'s own description/subagent_type, straight
   *  through from the `spawn` signal (see battleBus.ts); undefined for the
   *  regex-fallback path. */
  onBattlerSpawned: (battler: { key: string; parentId: string; species: string; label?: string }) => void;
  /** Fires the instant a battler is fully torn down — the normal poof-then-
   *  cleanup path (reapSubs) and the hard force-end/dispose path
   *  (destroyBattle) both call this, so it's the complete mirror of
   *  onBattlerSpawned above regardless of how a battler's life ends. */
  onBattlerRemoved: (key: string) => void;
  /** Forwards a player click on a battler to GardenScene, which owns the
   *  selection, view-mode, and camera-focus store state. */
  onBattlerClick: (parentId: string, key: string) => void;
  /** Fires whenever a battler's `done` state changes — `true` the moment it
   *  loses its completion battle (or ages out into one) and becomes
   *  `retired`, `false` if a resumed task-id later revives that same battler
   *  in place (`reviveRetired`) instead of spawning a duplicate. One
   *  bidirectional callback rather than two, since both directions are the
   *  same store patch (`LiveBattler.done`) with the boolean flipped. */
  onBattlerDone: (key: string, done: boolean) => void;
}
