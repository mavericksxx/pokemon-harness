/**
 * Evolution thresholds (Phase 3 §1): accumulated `working`-status time, in ms,
 * at which a session's walker advances to its line's next stage.
 *
 * Overridable for testing/demos via POKE_EVOLVE_SECONDS="20,60" (stage-2,
 * stage-3 seconds), optionally with a third value for `durationScale`
 * ("20,60,3" slows the ceremony itself to 3x, useful for lining up
 * screenshots) — see README. The renderer can't reliably read process.env
 * itself (it's sandboxed), so the override is read from main over IPC once at
 * startup.
 */

export interface EvolutionConfig {
  /** Working-ms to reach stage 2. */
  stage2Ms: number;
  /** Working-ms to reach stage 3. */
  stage3Ms: number;
  /** Ceremony playback speed multiplier: real-time = authored-time *
   *  durationScale, so smaller is faster. Authored timings assume 1.0 (~15s
   *  total); the default plays it back at a brisker, still-readable clip. */
  durationScale: number;
}

const DEFAULT_DURATION_SCALE = 0.6;

const DEFAULT_CONFIG: EvolutionConfig = {
  stage2Ms: 10 * 60 * 1000,
  stage3Ms: 30 * 60 * 1000,
  durationScale: DEFAULT_DURATION_SCALE
};

function parseOverride(raw: string | null): EvolutionConfig | null {
  if (!raw) return null;
  const parts = raw.split(',').map((s) => Number(s.trim()));
  if (
    (parts.length !== 2 && parts.length !== 3) ||
    parts.some((n) => !Number.isFinite(n) || n <= 0)
  ) {
    console.warn(`[evolution] ignoring malformed POKE_EVOLVE_SECONDS: "${raw}"`);
    return null;
  }
  return {
    stage2Ms: parts[0] * 1000,
    stage3Ms: parts[1] * 1000,
    durationScale: parts[2] ?? DEFAULT_DURATION_SCALE
  };
}

let resolved: EvolutionConfig = DEFAULT_CONFIG;

/** Fetch the env override, if any, and adopt it. Call once at startup, before
 *  any session can accumulate working time. */
export async function initEvolutionConfig(): Promise<void> {
  const override = parseOverride(await window.api.getEvolveSecondsOverride());
  if (override) resolved = override;
}

export function evolutionConfig(): EvolutionConfig {
  return resolved;
}
