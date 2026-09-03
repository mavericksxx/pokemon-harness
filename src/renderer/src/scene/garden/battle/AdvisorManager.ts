/**
 * Advisor-consult companions (advisor-pokemon feature) — a hovering
 * Lake-Guardian pokemon beside the session it's advising, for the duration
 * of one `advisor` subagent `Task` dispatch (this app's own global
 * before-architecture/before-done consult — see BACKLOG.md).
 *
 * Deliberately NOT a `BattleManager` extension, and this class does not wrap
 * `Battler` (see AdvisorManager's own file in the task spec for the
 * reasoning): `Battler` couples its world position to tile-based
 * pathfinding (`goTo`/`findPath`), which fits a wild challenger walking to a
 * face-off tile but not a companion that just needs to track its parent's
 * own (continuous, non-tile-locked) `worldX`/`worldY` every tick — forcing
 * that through `Battler.goTo` would mean re-pathing every frame the parent
 * moves, for no benefit. Instead this reuses `WalkerSprite` directly — the
 * same primitive `Battler` itself wraps for rendering (species art,
 * mirroring, and locomotion-based lift/bob, "free" for `levitate` per the
 * Lake Guardians' own dex entries) — inside a thin outer `Container`
 * positioned by hand each tick, the same shape `Battler.syncPosition` uses
 * for its own outer container, just without the path-walking in between.
 *
 * Lifecycle is intentionally much smaller than `BattleManager`'s: spawn
 * beside the parent -> hover, re-syncing position every tick -> despawn.
 * Never roams independently, never queues, never enters any battle phase.
 */
import { Container } from 'pixi.js';
import { WalkerSprite } from '../WalkerSprite';
import type { PokemonAnimation } from '../showdownArt';
import type { TiledMapRenderer } from '../TiledMapRenderer';
import { ADVISOR_DEX_IDS } from '../dexData';
import { loadLazyAnimation, placeholderAnimation } from '../lazySprites';
import { TOOL_BUBBLE_Z_BASE } from '../ToolBubble';
import { spawnAdvisorAura, spawnPokeballRecall, purgeBattleFxFor } from './battleFx';
import { accent, accentLight, hexToNumber } from '@/design/tokens';
import { resolveEffectiveTheme } from '@/design/theme';
import { useAppSettingsStore } from '@/store/appSettingsStore';
import { onAdvisorSignal, type AdvisorSignal } from './advisorBus';
import { safeLogDiagnostic } from '@/diagnosticsClient';

/** Offset from the parent walker's own feet, in tiles — "beside", not
 *  overlapping the parent's own sprite. Multiple concurrent companions for
 *  the SAME parent (rare — see this file's header) fan out further via
 *  `fanIndex` below rather than stacking on the same spot. */
const OFFSET_X_TILES = 0.9;
const OFFSET_Y_TILES = -0.35;
const FAN_STEP_TILES = 0.55;

/** The aura's diameter is ~2.9x the companion's own drawn sprite size — the
 *  advisor-pokemon aura spec's exact multiplier (derived from the reference
 *  artifact: 420px at 3x display scale = 140 world px at 1x, against a
 *  48x51 reference sprite footprint). Applied here to `drawnHeight` (the
 *  same "drawn size" every other sizing decision in this codebase — hit
 *  areas, bubble placement, pokéball recall — already uses) rather than a
 *  fixed pixel constant, so it scales correctly for whichever of the three
 *  Lake Guardians (or a future addition) is currently assigned, and for
 *  this map's own tile size. */
const AURA_DIAMETER_MULTIPLIER = 2.9;

/** Absolute cap on how long a companion may hover before it self-despawns
 *  unconditionally, ignoring the `'end'` signal entirely — the backstop for
 *  a completion notification that never arrives at all, the same posture
 *  BattleManager.ts's own `MAX_ROAM_MS` takes for a roaming battler (see
 *  that constant's doc comment for the full reasoning this mirrors). The
 *  advisor consult this companion represents is a single bounded `Task`
 *  dispatch (`subagent_type: 'advisor'`), not an open-ended agent session —
 *  it's typically well under a few minutes — so this can be, and is, much
 *  tighter than `MAX_ROAM_MS`'s 30 minutes; 15 is generous margin for a
 *  slow/complex consult while still bounding a stuck companion to a single
 *  digit number of minutes of visual noise instead of "until the app is
 *  restarted." This is a backstop, not a fix: the actual gap is upstream,
 *  in `taskNotificationWatcher.ts`'s own transcript-scraping mechanism for
 *  a live, continuously-busy session (see that file's CAVEAT) — this only
 *  guarantees a stuck companion can never be PERMANENT. */
const MAX_COMPANION_LIFETIME_MS = 15 * 60_000;

interface Companion {
  key: string;
  parentId: string;
  toolUseId: string | null;
  taskId: string | null;
  speciesId: string;
  container: Container;
  sprite: WalkerSprite;
  aura: { destroy: () => void; resize: (diameterPx: number, centerY: number) => void };
  despawning: boolean;
  /** `Date.now()` at spawn — the reference point for the
   *  `MAX_COMPANION_LIFETIME_MS` safety net in `update()`. */
  spawnedAt: number;
}

export interface AdvisorDeps {
  map: TiledMapRenderer;
  charLayer: Container;
  getRuntime: (parentId: string) => { walker: { worldX: number; worldY: number } } | undefined;
  /** Clicking a companion focuses the PARENT session's terminal — it has no
   *  session of its own (a Claude Code subagent runs inside its parent's
   *  process; see `SubBattler`'s own doc comment in BattleManager.ts for the
   *  same point made about an ordinary battler). Mirrors whatever click
   *  handler GardenScene.tsx already wires for an ordinary walker click. */
  onCompanionClick: (parentId: string) => void;
  /** Current day<->night crossfade weight (0 = day, 1 = night) — a thin
   *  pass-through to `DayNightOverlay.nightWeight` (GardenScene.tsx owns
   *  that instance; AdvisorManager has no reference of its own). Read once
   *  per aura tick by `spawnAdvisorAura` (battleFx.ts) so the companion's
   *  own additive glow dims as the overlay's screen-blend night elements
   *  (moonPool/silverRim) brighten the scene on top of it — see
   *  battleFx.ts's `AURA_NIGHT_DIM` for why. */
  getNightWeight: () => number;
}

function currentAuraTint(): number {
  const mode = useAppSettingsStore.getState().settings.theme;
  const effective = resolveEffectiveTheme(mode);
  return hexToNumber(effective === 'light' ? accentLight.lilac : accent.lilac);
}

export class AdvisorManager {
  private companions: Companion[] = [];
  private unsubscribe: () => void;
  private nextSeq = 0;
  /** Round-robin cursor into `ADVISOR_DEX_IDS`, consulted only once every
   *  species is already in use (see `pickSpecies`) — otherwise a free one is
   *  preferred, so two concurrent consults never LOOK the same while a
   *  distinct guardian is available. */
  private rrIndex = 0;

  constructor(private deps: AdvisorDeps) {
    this.unsubscribe = onAdvisorSignal((sig) => this.onSignal(sig));
  }

  /** Mirrors `BattleManager.getClickCandidates()` — the same candidate set
   *  GardenScene.tsx's charLayer click resolver needs so a companion the
   *  resolver picks as the click winner never turns out to be a no-op. */
  getClickCandidates(): { parentId: string; key: string; container: Container }[] {
    return this.companions
      .filter((c) => !c.despawning)
      .map((c) => ({ parentId: c.parentId, key: c.key, container: c.container }));
  }

  private onSignal(sig: AdvisorSignal): void {
    switch (sig.type) {
      case 'spawn':
        this.handleSpawn(sig.parentId, sig.toolUseId);
        break;
      case 'correlate':
        this.handleCorrelate(sig.parentId, sig.toolUseId, sig.taskId);
        break;
      case 'end':
        this.handleEnd(sig.parentId, sig.taskId);
        break;
    }
  }

  /** Prefers a Lake Guardian not currently assigned to any live companion —
   *  "cover realistic concurrency" (BACKLOG.md) means two or three
   *  simultaneous consults should read as visually distinct, not that each
   *  guardian carries any per-role meaning. Falls back to a plain
   *  round-robin once all three are in use, so a fourth+ concurrent consult
   *  still gets a species rather than failing. */
  private pickSpecies(): string {
    const inUse = new Set(this.companions.filter((c) => !c.despawning).map((c) => c.speciesId));
    const free = ADVISOR_DEX_IDS.find((id) => !inUse.has(id));
    if (free) return free;
    const id = ADVISOR_DEX_IDS[this.rrIndex % ADVISOR_DEX_IDS.length];
    this.rrIndex++;
    return id;
  }

  private handleSpawn(parentId: string, toolUseId?: string): void {
    const rt = this.deps.getRuntime(parentId);
    if (!rt) return; // parent already gone — nothing to hover beside

    const speciesId = this.pickSpecies();
    const ts = this.deps.map.tileSize;
    const key = `${parentId}#advisor#${this.nextSeq++}`;

    const container = new Container();
    container.sortableChildren = true;
    container.eventMode = 'static';
    container.cursor = 'pointer';
    container.on('pointertap', () => this.deps.onCompanionClick(parentId));

    const anim: PokemonAnimation = placeholderAnimation(speciesId);
    const sprite = new WalkerSprite(anim, ts);
    container.addChild(sprite.container);

    const halfW = Math.max(8, sprite.drawnWidth / 2);
    const top = -Math.max(16, sprite.drawnHeight);
    container.hitArea = {
      contains: (x: number, y: number) => x > -halfW && x < halfW && y > top && y < 4
    };

    const diameterPx = sprite.drawnHeight * AURA_DIAMETER_MULTIPLIER;
    const centerY = -sprite.drawnHeight * 0.5;
    const aura = spawnAdvisorAura(container, centerY, diameterPx, currentAuraTint(), this.deps.getNightWeight);

    const companion: Companion = {
      key,
      parentId,
      toolUseId: toolUseId ?? null,
      taskId: null,
      speciesId,
      container,
      sprite,
      aura,
      despawning: false,
      spawnedAt: Date.now()
    };
    this.companions.push(companion);
    this.positionCompanion(companion, rt.walker);
    this.deps.charLayer.addChild(container);

    safeLogDiagnostic('advisor', 'info', 'advisor companion materialized', { parentId, speciesId });

    void loadLazyAnimation(speciesId).then((real) => {
      if (!real || !this.companions.includes(companion)) return;
      sprite.configure(real);
      // The placeholder pokeball's drawn size (what the aura was originally
      // sized against — see `handleSpawn` above) rarely matches the real
      // Lake Guardian sprite's exactly; re-derive the aura's base diameter
      // now that the real art (and therefore the real `drawnHeight`) is in.
      const hitHalfW = Math.max(8, sprite.drawnWidth / 2);
      const hitTop = -Math.max(16, sprite.drawnHeight);
      companion.container.hitArea = {
        contains: (x: number, y: number) => x > -hitHalfW && x < hitHalfW && y > hitTop && y < 4
      };
      companion.aura.resize(sprite.drawnHeight * AURA_DIAMETER_MULTIPLIER, -sprite.drawnHeight * 0.5);
    });
  }

  private handleCorrelate(parentId: string, toolUseId: string, taskId: string): void {
    const companion = this.companions.find(
      (c) => c.parentId === parentId && c.toolUseId === toolUseId && !c.despawning
    );
    if (!companion) return; // not ours (an ordinary battler's correlation) — silent no-op, see advisorBus.ts
    companion.taskId = taskId;
    safeLogDiagnostic('advisor', 'info', 'advisor companion correlated to task', {
      parentId,
      toolUseId,
      taskId
    });
  }

  private handleEnd(parentId: string, taskId?: string): void {
    if (taskId) {
      const stamped = this.companions.find((c) => c.taskId === taskId && !c.despawning);
      if (stamped) {
        safeLogDiagnostic('advisor', 'info', 'advisor companion despawning — matched by taskId', {
          parentId,
          taskId,
          key: stamped.key,
          speciesId: stamped.speciesId
        });
        this.beginDespawn(stamped);
        return;
      }
    }
    // Fallback: oldest live companion for this parent — mirrors
    // BattleManager.handleEnd's own oldest-first fallback for a companion
    // that never got stamped (correlation raced ahead) or when no taskId is
    // available at all. A `taskId` that matches no companion here means
    // this completion belongs to the battle bus instead — silent no-op.
    const candidates = this.companions.filter((c) => c.parentId === parentId && !c.despawning);
    if (candidates.length === 0) return;
    const oldest = candidates[0];
    safeLogDiagnostic('advisor', 'info', 'advisor companion despawning — fell back to oldest-live-for-parent', {
      parentId,
      taskId: taskId ?? null,
      key: oldest.key,
      speciesId: oldest.speciesId
    });
    this.beginDespawn(oldest);
  }

  private beginDespawn(companion: Companion): void {
    if (companion.despawning) return;
    companion.despawning = true;
    companion.aura.destroy();
    spawnPokeballRecall(companion.container, companion.sprite.container, companion.sprite.drawnHeight, () => {
      this.companions = this.companions.filter((c) => c !== companion);
      purgeBattleFxFor(companion.container);
      companion.sprite.destroy();
      companion.container.destroy({ children: true });
    });
  }

  private positionCompanion(companion: Companion, walker: { worldX: number; worldY: number }): void {
    const ts = this.deps.map.tileSize;
    const fanIndex = this.companions
      .filter((c) => c.parentId === companion.parentId && !c.despawning)
      .indexOf(companion);
    const worldX = walker.worldX + (OFFSET_X_TILES + fanIndex * FAN_STEP_TILES) * ts;
    const worldY = walker.worldY + OFFSET_Y_TILES * ts;
    companion.container.x = Math.round(worldX);
    companion.container.y = Math.round(worldY);
    // Companions sit in the same overlay tier bubbles use
    // (TOOL_BUBBLE_Z_BASE — see ToolBubble.ts), so they're never hidden
    // behind a nearby tool-use bubble, but keyed off the PARENT's own raw
    // worldY (not this companion's own offset `worldY` above, which floats
    // slightly north of the parent) plus a tie-break of +1 — enough to
    // reliably win against this companion's OWN parent's bubble (which
    // computes its zIndex from that exact same parent worldY, see
    // Walker.ts's syncPosition-adjacent bubble zIndex line), while still
    // Y-sorting normally — neither side unconditionally wins — against an
    // unrelated session's bubble the companion happens to float near.
    companion.container.zIndex = TOOL_BUBBLE_Z_BASE + Math.round(walker.worldY) + 1;
  }

  /** Called once a frame from GardenScene.tsx's ticker, after
   *  `battleManager.update(dt)` — re-syncs every live (non-despawning)
   *  companion's position to its parent's own walker (which may itself be
   *  walking/wandering while the consult is in flight), and ticks each
   *  companion's own idle bob/lift. A despawning companion is left alone: no
   *  further repositioning while its pokéball recall plays out, same as a
   *  retiring `Battler` (nothing drives its `px`/`py` once its own movement
   *  stops). Dirty-flag rendering needs no extra hook here — the aura's own
   *  continuous `registerFx` entry already keeps `hasActiveFx()` true for a
   *  companion's ENTIRE lifetime (spawned with it, torn down only as part of
   *  `beginDespawn`, by which point the recall's own FX has already taken
   *  over), so GardenScene.tsx's existing `battleOrFxWasActive` check
   *  already covers position-follow updates too. */
  update(dt: number): void {
    for (const companion of this.companions) {
      if (!companion.despawning) {
        const aliveMs = Date.now() - companion.spawnedAt;
        if (aliveMs >= MAX_COMPANION_LIFETIME_MS) {
          // Safety net (see MAX_COMPANION_LIFETIME_MS's own comment) — an
          // 'end' signal that was ever going to arrive should have arrived
          // long before this. Logged distinctly from a normal despawn (see
          // handleEnd) so this exact case — the real bug reproducing — is
          // greppable on its own.
          safeLogDiagnostic(
            'advisor',
            'warn',
            'advisor companion despawned by max-lifetime safety net (no end signal ever arrived)',
            { parentId: companion.parentId, key: companion.key, speciesId: companion.speciesId, aliveMs }
          );
          this.beginDespawn(companion);
          continue;
        }
        const rt = this.deps.getRuntime(companion.parentId);
        if (!rt) {
          // Parent gone without an 'end' ever arriving (shouldn't happen —
          // defensive, same posture as BattleManager's own guards).
          this.beginDespawn(companion);
          continue;
        }
        this.positionCompanion(companion, rt.walker);
      }
      companion.sprite.update(dt);
    }
  }

  /** Immediate teardown, no animation — GardenScene.tsx's cleanup(), mirrors
   *  `BattleManager.dispose()`. */
  dispose(): void {
    this.unsubscribe();
    for (const companion of this.companions) {
      companion.aura.destroy();
      purgeBattleFxFor(companion.container);
      companion.sprite.destroy();
      companion.container.destroy({ children: true });
    }
    this.companions = [];
  }
}
