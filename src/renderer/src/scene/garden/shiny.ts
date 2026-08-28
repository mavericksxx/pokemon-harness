/**
 * Shiny Pokemon (Phase 5): a session's Pokemon rolls shiny at creation, with
 * default odds 1-in-64, and stays shiny for the session's lifetime — through
 * every evolution stage. Config lives beside `evolution.ts`.
 *
 * Overridable for testing/demos via POKE_SHINY_ODDS (e.g. "1" = always
 * shiny) — see README. Same IPC-read-once pattern as evolution's
 * POKE_EVOLVE_SECONDS: the renderer can't reliably read process.env itself.
 *
 * Unlike evolution's config (read minutes into a session's life, so a late
 * resolve is harmless), the shiny roll happens at the EARLIEST possible
 * instant a session exists — `startSession` awaits `initShinyConfig()`
 * directly (memoized, so only the first caller actually pays the IPC round
 * trip) rather than relying on some other subsystem having already resolved
 * it first.
 */

export interface ShinyConfig {
  /** 1-in-N odds of a session's Pokemon rolling shiny. */
  odds: number;
}

const DEFAULT_ODDS = 64;
const DEFAULT_CONFIG: ShinyConfig = { odds: DEFAULT_ODDS };

function parseOverride(raw: string | null): ShinyConfig | null {
  if (!raw) return null;
  const n = Number(raw.trim());
  if (!Number.isFinite(n) || n <= 0) {
    console.warn(`[shiny] ignoring malformed POKE_SHINY_ODDS: "${raw}"`);
    return null;
  }
  return { odds: n };
}

let resolved: ShinyConfig = DEFAULT_CONFIG;
let initPromise: Promise<void> | null = null;

/** Fetch the env override, if any, and adopt it. Safe to call more than
 *  once — every caller shares the same in-flight/resolved promise, so the
 *  IPC round trip happens exactly once. */
export function initShinyConfig(): Promise<void> {
  if (!initPromise) {
    initPromise = (async (): Promise<void> => {
      const override = parseOverride(await window.api.getShinyOddsOverride());
      if (override) resolved = override;
    })();
  }
  return initPromise;
}

export function shinyConfig(): ShinyConfig {
  return resolved;
}

/** Roll shiny at 1-in-`odds`. Callers that need the env override guaranteed
 *  in effect (session creation) should `await initShinyConfig()` first;
 *  callers minutes into the app's life (battle wild-spawns) can rely on
 *  GardenScene's startup init having already resolved it. */
export function rollShiny(): boolean {
  return Math.floor(Math.random() * resolved.odds) === 0;
}
