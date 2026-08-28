/**
 * Design tokens — single source of truth for the app chrome (titlebar, tab
 * strip, popovers, picker, buttons, toasts, sidebar). The garden canvas
 * itself is untouched (Phase 8 §2): Pixi draws the world from its own art,
 * not from these.
 *
 * FINAL PALETTE — user-approved 2026-08-28 design-spec replication of
 * munder-difflin's shipped `design/tokens.css` (dark theme, post-v0.3.4
 * recalibration; MIT, see ATTRIBUTION.md). This supersedes the earlier
 * provisional pass: the neutral ground/ink ramp and the six session accents
 * were already captured verbatim and needed no change; the deltas are the
 * primary accent (was a placeholder `sky` pick — now their brand gold),
 * two new surface tones (terminal/input fill, disabled fill), two status
 * hexes that had drifted from spec, sharpened radii, and a full type-scale
 * rebuild for the three-font stack (Press Start 2P / Inter / JetBrains
 * Mono — see fonts.css).
 *
 * Mirrored onto `:root` as CSS custom properties by `applyTokens()` (called
 * once from `main.tsx` at boot) so existing class-based CSS in `index.css`
 * keeps working unchanged — components don't need to switch to inline
 * styles from this module.
 */

/** Ground/surface ramp — munder-difflin tokens.css dark theme: `--cth-cream-*`
 *  (app ground → panel fill → raised/inset fill) and `--cth-ink-300` for the
 *  border weight their own comment says carries "this app's entire
 *  structural language" (used 93 times as `inset 0 0 0 1px`) — kept as the
 *  border here for the same reason, not softened to a dimmer divider tone. */
export const ground = {
  0: '#17171B', // cream-50 (dark) — app background, garden letterbox
  100: '#1D1D22', // cream-100 (dark) — panel fill (titlebar, drawer, popovers)
  200: '#26262C', // cream-200 (dark) — raised/inset fill (chips, inputs, list rows)
  300: '#787684', // ink-300 (dark) — hairline borders (NOT ink-100; see comment above)
  /** Terminal + real-input fill — spec-added, distinct from the app ground:
   *  `.terminal-mount`, form inputs and pickers sat on `ground[0]` before,
   *  which is meant for the letterbox behind the garden, not a control's own
   *  surface. Deliberately darker than `ground[100]`/`ground[200]` (chrome). */
  terminal: '#1A1A1F',
  /** Disabled control fill — spec-added; not yet consumed anywhere before
   *  this pass (see `button:disabled` below). */
  disabled: '#313139'
} as const;

/** Text ramp — munder-difflin `--cth-ink-*` dark theme. `900` primary text,
 *  `700` secondary, `500` tertiary/muted, `300` the quietest divider tone
 *  (their comment: "meant to recede," 1.4-1.7:1 contrast — not for text). */
export const ink = {
  900: '#DEDBD6',
  700: '#B3B0AC',
  500: '#96919F',
  300: '#3E3D46' // cth-ink-100 — subtle dividers only, not a border/text tone
} as const;

/** munder-difflin's six agent accents, dark-theme values — DESIGN.md §3.3.
 *  Distinct from `store.ts`'s `ACCENTS` (the Pixi walker-tint set, garden-
 *  side, untouched): these are for CHROME that wants a named hue (roster-
 *  card accent bars, session tabs). */
export const accent = {
  coral: '#E08C82',
  mint: '#74C096',
  sky: '#6FB3C4',
  lemon: '#CFAA57',
  lilac: '#A896E3',
  peach: '#DFA57F'
} as const;

/** Brand gold — "yellow Pokédex shell." The app's ONE primary accent
 *  (buttons, focus rings, brand mark, active states). Distinct from the six
 *  session accents above and from `shiny` below (different hue family,
 *  same calm luminance band) — three near-identical yellows exist in this
 *  palette on purpose (gold=brand, lemon=session #4, shiny=Pokemon-specific
 *  star badge); keep them visually distinguishable in context, not merged. */
export const gold = '#E8B740';

/** The app's primary accent. Was `accent.sky` (a placeholder pending the
 *  spec); now the user-approved brand gold. */
export const primaryAccent = gold;

/** Status semantics — munder-difflin `--cth-status-*` dark theme, mapped
 *  onto this app's five `SessionStatus` values by closest meaning (their set
 *  has more granularity than this app uses): `starting` borrows their idle
 *  grey, `idle` borrows their thinking blue (this app's old sky "breathing"
 *  idle), `done` is their status-success green (NOT their status-ghost grey
 *  — "done", not "success", per copy, but the color is the success one).
 *
 *  Note: `done` fires on plain PTY exit regardless of `exitCode` (see
 *  terminalRegistry.ts) — a crashed session gets the same green badge as a
 *  clean one. That's a pre-existing status-model gap, not something this
 *  color pass changes; exit-code-aware coloring is out of scope here.
 *
 *  `starting` is lightened from the spec's literal #6C6C77 (their
 *  status-idle) to #8C8C97: the WCAG spot-check (see index.css's `.status`
 *  comment) found the literal value's badge DOT — a small graphical
 *  indicator, needs >=3.0:1 per WCAG 1.4.11 — measured only 2.38:1 against
 *  its own 20%-tinted chip background. Same hue, lightened until the dot
 *  clears the bar with margin (3.39:1). */
export const status = {
  starting: '#8C8C97', // their status-idle, lightened — see comment above
  idle: '#64ACBB', // their status-thinking
  working: '#D8B052', // their status-working
  blocked: '#DF8078', // their status-blocked
  done: '#6FB88B' // their status-success
} as const;

export const danger = accent.coral;
/** Darker border to pair with `danger`'s coral fill/text — their coral-light
 *  dark-theme value (a muted coral-brown), not a hand-picked dark red. */
export const dangerBorder = '#3B2724';

/** Gold used only for the shiny-Pokemon star badge — a different named token
 *  from `gold` above (the brand accent) even though both sit in the same
 *  warm-yellow family; keep them distinguishable in context. */
export const shiny = accent.lemon;

/** 4px base grid. */
export const space = {
  0: 0,
  1: 4,
  2: 8,
  3: 12,
  4: 16,
  5: 24,
  6: 32,
  7: 48,
  8: 64
} as const;

/** Font stacks. Press Start 2P is CHROME-ONLY (titlebar, section/modal
 *  headers) — never terminal content, never body text (fonts.css bundles
 *  all three; see that file's header for why they're self-hosted). */
export const font = {
  display: `'Press Start 2P', ui-monospace, SFMono-Regular, Menlo, monospace`,
  ui: `'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif`,
  mono: `'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace`
} as const;

/** Type scale, px int only. Press Start 2P renders ONLY at the three display
 *  sizes (8/12/16 — its pixel grid breaks at anything else); Inter/JetBrains
 *  Mono are otherwise unconstrained but these are this app's chosen steps.
 *  No per-step letter-spacing or weight: tracking is 0 everywhere (a tracked
 *  Press Start 2P breaks its own pixel grid) and weight is 400 nearly
 *  everywhere — emphasis comes from color, not bold. */
export const type = {
  displaySm: { size: 8, line: 12 },
  displayMd: { size: 12, line: 20 },
  displayLg: { size: 16, line: 24 },
  bodyLg: { size: 16, line: 24 },
  bodyMd: { size: 14, line: 20 }, // was 13/18
  bodySm: { size: 13, line: 18 }, // was 11/15
  monoMd: { size: 14, line: 20 },
  monoSm: { size: 13, line: 18 }
} as const;

/** Border radius — spec: 0 everywhere, 2px max for modals/corner clips
 *  (was 3/4/6). `lg` is consumed by exactly one rule (`.modal`); everything
 *  else routes through `sm`/`md`, both now 0. */
export const radius = {
  sm: 0,
  md: 0,
  lg: 2
} as const;

/** Hard offset shadow, no blur — DESIGN.md §6.4, their dark-theme value
 *  ("reads as depth, not void"). Modals/toasts/dragging only, never static
 *  panels. */
export const shadowHard = '4px 4px 0 rgba(0, 0, 0, 0.45)';

/** Hex → `rgba(r, g, b, alpha)`, for status badge fills (20% opacity of the
 *  status color, per spec's badge anatomy) — computed here rather than
 *  hand-picked so the fill always tracks the status hex above. */
function hexToRgba(hex: string, alpha: number): string {
  const n = parseInt(hex.replace('#', ''), 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** Convert the token modules above into a flat CSS custom-property map and
 *  stamp it onto `document.documentElement`, so `index.css`'s existing
 *  `var(--x)` references resolve to these values. Idempotent; safe to call
 *  more than once (e.g. hot reload). */
export function applyTokens(): void {
  const root = document.documentElement.style;
  root.setProperty('--bg', ground[0]);
  root.setProperty('--panel', ground[100]);
  root.setProperty('--panel-2', ground[200]);
  root.setProperty('--bg-terminal', ground.terminal);
  root.setProperty('--disabled', ground.disabled);
  root.setProperty('--line', ground[300]);
  root.setProperty('--text', ink[900]);
  root.setProperty('--text-secondary', ink[700]);
  root.setProperty('--muted', ink[500]);
  root.setProperty('--muted-dim', ink[300]);
  root.setProperty('--accent', primaryAccent);
  root.setProperty('--gold', gold);
  root.setProperty('--danger', danger);
  root.setProperty('--danger-border', dangerBorder);
  root.setProperty('--shiny', shiny);

  root.setProperty('--accent-coral', accent.coral);
  root.setProperty('--accent-mint', accent.mint);
  root.setProperty('--accent-sky', accent.sky);
  root.setProperty('--accent-lemon', accent.lemon);
  root.setProperty('--accent-lilac', accent.lilac);
  root.setProperty('--accent-peach', accent.peach);

  root.setProperty('--status-idle', status.idle);
  root.setProperty('--status-working', status.working);
  root.setProperty('--status-blocked', status.blocked);
  root.setProperty('--status-done', status.done);
  root.setProperty('--status-starting', status.starting);
  root.setProperty('--status-idle-bg', hexToRgba(status.idle, 0.2));
  root.setProperty('--status-working-bg', hexToRgba(status.working, 0.2));
  root.setProperty('--status-blocked-bg', hexToRgba(status.blocked, 0.2));
  root.setProperty('--status-done-bg', hexToRgba(status.done, 0.2));
  root.setProperty('--status-starting-bg', hexToRgba(status.starting, 0.2));

  for (const [k, v] of Object.entries(space)) root.setProperty(`--space-${k}`, `${v}px`);

  root.setProperty('--radius-sm', `${radius.sm}px`);
  root.setProperty('--radius-md', `${radius.md}px`);
  root.setProperty('--radius-lg', `${radius.lg}px`);

  root.setProperty('--shadow-hard', shadowHard);

  root.setProperty('--font-display', font.display);
  root.setProperty('--font-ui', font.ui);
  root.setProperty('--font-mono', font.mono);

  root.setProperty('--font-display-sm-size', `${type.displaySm.size}px`);
  root.setProperty('--font-display-sm-line', `${type.displaySm.line}px`);
  root.setProperty('--font-display-md-size', `${type.displayMd.size}px`);
  root.setProperty('--font-display-md-line', `${type.displayMd.line}px`);
  root.setProperty('--font-display-lg-size', `${type.displayLg.size}px`);
  root.setProperty('--font-display-lg-line', `${type.displayLg.line}px`);
  root.setProperty('--font-body-lg-size', `${type.bodyLg.size}px`);
  root.setProperty('--font-body-lg-line', `${type.bodyLg.line}px`);
  root.setProperty('--font-body-md-size', `${type.bodyMd.size}px`);
  root.setProperty('--font-body-md-line', `${type.bodyMd.line}px`);
  root.setProperty('--font-body-sm-size', `${type.bodySm.size}px`);
  root.setProperty('--font-body-sm-line', `${type.bodySm.line}px`);
  root.setProperty('--font-mono-md-size', `${type.monoMd.size}px`);
  root.setProperty('--font-mono-md-line', `${type.monoMd.line}px`);
  root.setProperty('--font-mono-sm-size', `${type.monoSm.size}px`);
  root.setProperty('--font-mono-sm-line', `${type.monoSm.line}px`);
}

/** Hex → 0xRRGGBB, for the handful of chrome call sites (roster card accent
 *  dots) that want the same number Pixi already takes (`session.accent`). */
export function hexToNumber(hex: string): number {
  return parseInt(hex.replace('#', ''), 16);
}
