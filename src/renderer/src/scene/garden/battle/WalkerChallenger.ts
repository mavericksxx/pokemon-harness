import type { Container } from 'pixi.js';
import type { Walker } from '../Walker';
import type { DexEntry } from '../dexData';
import type { Challenger } from './BattleManager';

/**
 * DELEGATE BATTLE PARITY — a first-class delegate session's OWN `Walker`,
 * adapted to the narrow `Challenger` surface (see BattleManager.ts) so the
 * existing wave choreography can fight it exactly the way it fights a
 * `Battler`, with no branch anywhere in the alert/approach/faceoff/attack
 * machinery.
 *
 * WHY AN ADAPTER RATHER THAN A SECOND `Battler`: a `poke-delegate` session is
 * a real `Session` — its own pty, terminal tab, roster card and independent
 * `Walker` that has already been living in the garden for the delegate's whole
 * run. It doesn't need (and must not get) a second sprite: it needs its
 * EXISTING one to walk up to the parent for one completion battle. So this
 * wraps, and deliberately owns nothing.
 *
 * THE ONE INVARIANT EVERYTHING ELSE HERE FOLLOWS: **GardenScene owns this
 * `Walker`'s lifecycle, its per-frame tick, and its visibility.** Its ticker
 * already calls `walker.update(dt)` every frame (before `BattleManager.update`,
 * deliberately — see that call site's own comment on battle positioning
 * overwriting with a fresh absolute value), `removeWalker` already calls
 * `walker.destroy()`, and `recallDelegate` already owns the pokéball recall.
 * Every method below that a `Battler` would use to drive its own lifecycle is
 * therefore a documented no-op rather than a forward: forwarding would
 * double-drive the walk (halving nothing, doubling SPEED) or double-destroy a
 * live session's sprite. BattleManager additionally skips this sub in every
 * teardown/bookkeeping path that assumes a manager-OWNED battler with a store
 * entry (`destroyBattle`, `handleEndAll`, `retireSub`, `setVisible`,
 * `getClickCandidates`, the retired-sub wander) — see `isDelegateSub` there.
 */
export class WalkerChallenger implements Challenger {
  /** Battle-only, and therefore this adapter's own state rather than
   *  `Walker`'s: the tile BattleManager assigns for face-off/battle. Plain
   *  mutable field, exactly like `Battler.standTile` — `admitBattle` and
   *  `pickChallengerStandTileFor` write it directly. */
  standTile: { x: number; y: number } | null = null;

  private readonly bubbleLabel: string | undefined;

  constructor(
    private readonly walker: Walker,
    /** The delegate's OWN current species — passed in, never rolled: unlike a
     *  wild Claude-subagent battler (`handleSpawn`'s `pickSpecies()`), a
     *  delegate already has an established identity on its roster card. Fixed
     *  for this challenger's lifetime, same as `Battler.species`. */
    readonly species: DexEntry,
    label?: string
  ) {
    this.bubbleLabel = label?.trim() || undefined;
  }

  get container(): Container {
    return this.walker.container;
  }

  /** The walker's own bubble container — already parented into `charLayer` by
   *  GardenScene's `addWalker`, so (unlike a `Battler`'s) BattleManager must
   *  NOT add it again. */
  get bubbleContainer(): Container {
    return this.walker.bubbleContainer;
  }

  get tile(): { x: number; y: number } {
    return this.walker.tile;
  }

  /** `Walker.spriteHeight` is a one-for-one twin of `Battler.drawnHeight`
   *  (both are `this.sprite.drawnHeight`), so no getter had to be added to
   *  `Walker` for this. */
  get drawnHeight(): number {
    return this.walker.spriteHeight;
  }

  /** A delegate's walker has been alive and walking for the delegate's whole
   *  session — there is no poof-in to wait out, so `updateAlert`'s "don't pop
   *  the '!' over something still fading in" check passes immediately. */
  get isSpawning(): boolean {
    return false;
  }

  /** Nothing here ever poofs (`startPoofOut` is a no-op below), so `reapSubs`
   *  can never select this sub for destruction even if some future path did
   *  mark it `'leaving'`. */
  get isPoofedOut(): boolean {
    return false;
  }

  /** Same reasoning as `isPoofedOut` above — this adapter's `startPoofOut`
   *  is a no-op, so there is never a scale tween in flight to report. The
   *  walker's own idle/movement animation is self-marking dirty already
   *  (GardenScene's ticker calls `walker.update(dt)` unconditionally, every
   *  frame, independent of this manager — see WalkerSprite.ts), so nothing
   *  is lost by this always reading false for `hasActiveBattles`'s poll. */
  get isPoofingOut(): boolean {
    return false;
  }

  /** Arrival by TILE COMPARISON rather than by peeking at `Walker`'s private
   *  path state — the same test `updateApproaching` already uses for the
   *  PARENT walker's own arrival (`parentArrived`), so both halves of a
   *  delegate battle are judged identically. Carries the same accepted risk
   *  the parent's already does: a `goTo` that failed (unreachable stand tile)
   *  never arrives, and the wave's distance-based stuck watchdog
   *  (`waveStuckCapMs`) force-concludes it rather than hanging the global
   *  queue. */
  get arrived(): boolean {
    if (!this.standTile) return true;
    const at = this.walker.tile;
    return at.x === this.standTile.x && at.y === this.standTile.y;
  }

  goTo(tile: { x: number; y: number }): boolean {
    return this.walker.goTo(tile);
  }

  /** The same fixed stance `Battler.setBattleStance` sets — the challenger is
   *  always placed in the parent's SW arc (see BattleManager's file header on
   *  facing being a fixed arrangement), so a native/unmirrored BACK sheet
   *  (gen5ani draws it already facing up-right) points straight at the
   *  parent for free when this species has one. A species with no back sheet
   *  falls back to a MIRRORED front sheet (gen5ani front art is drawn facing
   *  down-left, so mirroring it points down-right instead — at least
   *  horizontally toward the parent). Both branches are cheap idempotent
   *  no-ops when already correct, which is what makes `applyBattleStance`
   *  safe to re-run every tick. */
  setBattleStance(): void {
    if (this.walker.hasBackView) {
      this.walker.setForcedBackView(true);
      this.walker.faceDirection('left');
    } else {
      this.walker.setForcedBackView(false);
      this.walker.faceDirection('right');
    }
  }

  /** Undoes `setBattleStance` — releasing `setForcedBackView` also resets
   *  the walk-direction hysteresis state (`backViewBias`/`facingTarget`) it
   *  accumulated during battle, so this is the one call needed; normal
   *  wandering picks its own facing back up from there. Called at every
   *  point a delegate challenger leaves battle stance — retire
   *  (`retireSub`, for a delegate mid-wave when the parent goes idle with no
   *  clean signal — `handleEndAll`), recall (`dropChallenger`), and teardown
   *  (`destroyBattle`'s delegate branch), see
   *  BattleManager.ts's checklist in its file header. */
  clearBattleStance(): void {
    this.walker.setForcedBackView(false);
  }

  /** BUBBLES REUSE THE WALKER'S OWN, rather than this adapter owning a second
   *  `ToolBubble`. The two uses contend exactly ONCE, harmlessly: GardenScene's
   *  ordinary tool-bubble reconcile only writes when its `toolKey`
   *  (status|tool|target|looping|napping) actually CHANGES, and every component
   *  of that is frozen for as long as the delegate sits `'done'` — but the very
   *  pass that queues the battle is also the pass where `toolKey` changes
   *  (working -> done), and the reconcile runs LATER in that same
   *  `applyState` iteration than the queue call. So the `lingerBubble()` in its
   *  `else` branch starts fading the label `queueForBattle` just pinned.
   *  Cosmetic and self-correcting: `admitBattle` re-shows the label when the
   *  wave starts, and no reconcile after that one can touch the bubble again.
   *  Reusing also gets the right look for free: `Walker`'s bubble is the
   *  full-size `'main'` variant, and a delegate IS a live session, not the
   *  dashed-border `'subagent'` transient a `Battler` renders as. */
  showBubbleLabel(): void {
    if (this.bubbleLabel) this.walker.showText(this.bubbleLabel);
    else this.walker.hideBubble();
  }

  showAttack(tool: string, target = ''): void {
    if (tool) this.walker.showTool(tool, target);
  }

  /** `Walker.showFloatingText` — the very same mechanism the PARENT walker's
   *  half of `applyHit` already uses for its own "«Species» used «Tool»!"
   *  line, so both sides of a delegate battle read identically. */
  showMoveText(text: string): void {
    this.walker.showFloatingText(text);
  }

  hideBubble(): void {
    this.walker.hideBubble();
  }

  /** Deliberately does NOT forward to `walker.update(dt)` — GardenScene's
   *  ticker already calls that once per frame, before `BattleManager.update`,
   *  and stepping the walk twice per frame would double this walker's speed.
   *
   *  What it DOES do is the one thing `applyPositions` structurally depends on
   *  a fighter doing every tick: re-establish `container.x/y` from the
   *  authoritative world position. That function applies the lunge and shake
   *  with `+=` on top of a container it assumes was just reset — `Battler`
   *  gets that for free from its own `update` -> `syncPosition`, and the
   *  parent walker gets it explicitly at the top of `applyPositions`. A
   *  STATIONARY `Walker` resyncs neither: `Walker.syncPosition` only runs from
   *  inside `updateWalk`, so without this line a delegate challenger would
   *  accumulate `LUNGE_FRACTION * gap` of drift toward the parent every single
   *  frame of an attack, and random-walk under the hit shake. This is the
   *  exact mirror of `applyPositions`'s own parent-container reset; `zIndex` is
   *  left alone because it only changes when the walker actually moves, which
   *  `Walker.syncPosition` still owns.
   *
   *  Deliberately UNCONDITIONAL, with no `isEvolving` guard of the kind most
   *  walker-touching code in this subsystem carries. An evolution ceremony
   *  reparents the walker's container into the shared `evolutionCeremonyLayer`
   *  but never writes its `x`/`y`, and that layer is a sibling of `charLayer`
   *  in the same map coordinate space (GardenScene's layer setup says so
   *  explicitly) — so this writes the identical on-screen position either way
   *  and fights nothing. Skipping it while evolving would be strictly worse:
   *  `applyPositions` keeps applying its `+=` regardless (its own early-out is
   *  on the PARENT's ceremony, not the challenger's), so a guard here would
   *  restore the unbounded per-frame drift instead of preventing it.
   *  Challenger-and-evolving is in any case unreachable by construction —
   *  GardenScene won't start a ceremony on a live challenger (`isChallenger`
   *  in its 1Hz evolution gate), and won't enter a walker with one in flight
   *  OR merely pending as one (`isEvolving`/`evolvePending` on the same edge
   *  that queues the battle); `triggerEvolve` is that gate's only caller.
   *
   *  `dt` is ignored, which is what lets teardown paths call `update(0)`
   *  purely as a position resync (`dropChallenger`, `destroyBattle`) when a
   *  wave is cut short mid-lunge.
   *
   *  LATENT, unreachable today: were a delegate session ever to hold a
   *  `ParentBattle` of its OWN, this reset would wipe that wave's lunge
   *  whenever `update`'s per-parent loop happened to reach the delegate's own
   *  entry after the one it challenges in. Delegates are `provider: 'codex'`
   *  and receive none of the Claude hook signals that create a `ParentBattle`,
   *  so no such entry can exist — worth knowing if that ever changes. */
  update(_dt: number): void {
    this.walker.container.x = Math.round(this.walker.worldX);
    this.walker.container.y = Math.round(this.walker.worldY);
  }

  /** No-op for the same reason: `Walker.update` already re-positions and
   *  Y-sorts its own bubble every frame. */
  syncBubblePosition(): void {
    /* intentionally empty — see doc comment */
  }

  /** No-op: a delegate's walker must never poof. BattleManager also skips
   *  delegate subs in `handleEndAll` (its only caller), so this is belt-and-
   *  braces — that signal fires on a merely BLOCKED parent as often as a done
   *  one, and must never make a live session's pokemon vanish. */
  startPoofOut(): void {
    /* intentionally empty — see doc comment */
  }

  /** No-op: the delegate's pokéball recall is GardenScene's `recallDelegate`
   *  (which calls `Walker.startRecall` itself and then `stopSession`), not
   *  BattleManager's `despawnBattler` — which can't reach this sub anyway,
   *  being keyed by a store `LiveBattler` key this sub never has. */
  startRecall(_onDone: () => void): void {
    /* intentionally empty — see doc comment */
  }

  /** No-op: destroying here would tear down a LIVE session's walker out from
   *  under GardenScene, which owns it (`removeWalker` -> `walker.destroy()`). */
  destroy(): void {
    /* intentionally empty — see doc comment */
  }
}
