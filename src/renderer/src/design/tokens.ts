/**
 * Design tokens — single source of truth for the app chrome (titlebar, tab
 * strip, popovers, picker, buttons, toasts, sidebar). The garden canvas
 * itself is untouched (Phase 8 §2): Pixi draws the world from its own art,
 * not from these.
 *
 * PROVISIONAL PALETTE. The color values below were an initial pass that
 * kept this app's pre-existing dark-GREEN identity (index.css's old
 * `:root` block) and only ported munder-difflin's *structure* (ramp shape,
 * space scale, type scale, panel border+shadow language). User feedback on
 * that pass: it doesn't look/feel like the munder-difflin inspiration, and
 * the green background specifically has to go — Pokemon flavor belongs in
 * CONTENT (sprites, accents, copy), not the chrome's background palette.
 *
 * This revision replaces every chrome color with values captured verbatim
 * from munder-difflin's own `design/tokens.css`, dark-theme block (MIT, see
 * ATTRIBUTION.md) — their real neutral ramp + accent hues, not invented
 * ones. It is STILL provisional: a dedicated research pass is producing an
 * exact replication spec (hexes/type/spacing/radii/motion) from their repo
 * + site, which supersedes this once it lands. Everything chrome-colored
 * routes through the CSS custom properties `applyTokens()` sets below (and
 * index.css's matching fallback block) specifically so that swap is a
 * token-file edit, not a re-skin — grep for a raw `#` in index.css before
 * adding new chrome CSS; if you find one, it isn't wired to this file yet.
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
  300: '#787684' // ink-300 (dark) — hairline borders (NOT ink-100; see comment above)
} as const;

/** Text ramp — munder-difflin `--cth-ink-*` dark theme. `900` primary text,
 *  `700` secondary, `500` tertiary/muted, `100` the quietest divider tone
 *  (their comment: "meant to recede," 1.4-1.7:1 contrast — not for text). */
export const ink = {
  900: '#DEDBD6',
  700: '#B3B0AC',
  500: '#96919F',
  300: '#3E3D46' // cth-ink-100 — subtle dividers only, not a border/text tone
} as const;

/** munder-difflin's six agent accents, dark-theme values — DESIGN.md §3.3.
 *  Distinct from `store.ts`'s `ACCENTS` (the Pixi walker-tint set, garden-
 *  side, untouched): these are for CHROME that wants a named hue (currently
 *  none of index.css's rules consume them directly — kept available for
 *  roster-card/tab accenting once the spec settles whether chrome should
 *  echo a session's tint at all). */
export const accent = {
  coral: '#E08C82',
  mint: '#74C096',
  sky: '#6FB3C4',
  lemon: '#CFAA57',
  lilac: '#A896E3',
  peach: '#DFA57F'
} as const;

/** The app's primary accent (buttons, focus rings, brand mark). Provisional:
 *  munder-difflin's own system has no single "primary" — each agent gets one
 *  of the six accents above. `sky` is a placeholder pick pending the spec. */
export const primaryAccent = accent.sky;

/** Status semantics — munder-difflin `--cth-status-*` dark theme (DESIGN.md
 *  §3.4), mapped onto this app's five `SessionStatus` values by closest
 *  meaning (their set has more granularity than this app uses). */
export const status = {
  starting: '#6F6C77', // their status-idle — "at desk, awaiting"
  idle: '#64ACBB', // their status-thinking — closest to this app's old sky "breathing" idle
  working: '#D8B052', // their status-working
  blocked: '#DF8078', // their status-blocked
  done: '#6C6A76' // their status-ghost — "pane closed, fading out"
} as const;

export const danger = accent.coral;
/** Darker border to pair with `danger`'s coral fill/text — their coral-light
 *  dark-theme value (a muted coral-brown), not a hand-picked dark red. */
export const dangerBorder = '#3B2724';

/** Gold used only for the shiny-Pokemon star badge — was accidentally the
 *  same literal hex as the old status-blocked color pre-Phase-8 (coincidence
 *  in the original file, not a deliberate shared token). Split out properly
 *  now that both route through named tokens. */
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

/** Type scale, px. This app never switched fonts (system sans throughout),
 *  so this only fixes sizes/line-heights/weights into named steps. */
export const type = {
  display: { size: 13, line: 18, weight: 600, tracking: '0.04em' }, // brand mark, section titles
  label: { size: 10, line: 12, weight: 600, tracking: '0.06em' }, // status/uppercase chips
  body: { size: 13, line: 18, weight: 400, tracking: '0' },
  bodySm: { size: 11, line: 15, weight: 400, tracking: '0' },
  mono: { size: 12, line: 17, weight: 400, tracking: '0' }
} as const;

/** Chunkier, less-rounded than the old ad hoc 6/8/10px radii — a step toward
 *  munder-difflin's "no floaty border-radius" without going all the way to
 *  0 (this app's inputs/lists still want a little softness at this size). */
export const radius = {
  sm: 3,
  md: 4,
  lg: 6
} as const;

/** Hard offset shadow, no blur — DESIGN.md §6.4, their dark-theme value
 *  ("reads as depth, not void"). Replaces the old blurred
 *  `0 6px 18px rgba(...)` on popovers/modals/toasts. */
export const shadowHard = '4px 4px 0 rgba(0, 0, 0, 0.45)';

/** Convert the token modules above into a flat CSS custom-property map and
 *  stamp it onto `document.documentElement`, so `index.css`'s existing
 *  `var(--x)` references resolve to these values. Idempotent; safe to call
 *  more than once (e.g. hot reload). */
export function applyTokens(): void {
  const root = document.documentElement.style;
  root.setProperty('--bg', ground[0]);
  root.setProperty('--panel', ground[100]);
  root.setProperty('--panel-2', ground[200]);
  root.setProperty('--line', ground[300]);
  root.setProperty('--text', ink[900]);
  root.setProperty('--text-secondary', ink[700]);
  root.setProperty('--muted', ink[500]);
  root.setProperty('--muted-dim', ink[300]);
  root.setProperty('--accent', primaryAccent);
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

  for (const [k, v] of Object.entries(space)) root.setProperty(`--space-${k}`, `${v}px`);

  root.setProperty('--radius-sm', `${radius.sm}px`);
  root.setProperty('--radius-md', `${radius.md}px`);
  root.setProperty('--radius-lg', `${radius.lg}px`);

  root.setProperty('--shadow-hard', shadowHard);

  root.setProperty('--font-display-size', `${type.display.size}px`);
  root.setProperty('--font-display-line', `${type.display.line}px`);
  root.setProperty('--font-display-weight', `${type.display.weight}`);
  root.setProperty('--font-display-tracking', type.display.tracking);
  root.setProperty('--font-label-size', `${type.label.size}px`);
  root.setProperty('--font-label-line', `${type.label.line}px`);
  root.setProperty('--font-label-tracking', type.label.tracking);
  root.setProperty('--font-body-size', `${type.body.size}px`);
  root.setProperty('--font-body-line', `${type.body.line}px`);
  root.setProperty('--font-body-sm-size', `${type.bodySm.size}px`);
  root.setProperty('--font-body-sm-line', `${type.bodySm.line}px`);
  root.setProperty('--font-mono-size', `${type.mono.size}px`);
  root.setProperty('--font-mono-line', `${type.mono.line}px`);
}

/** Hex → 0xRRGGBB, for the handful of chrome call sites (roster card accent
 *  dots) that want the same number Pixi already takes (`session.accent`). */
export function hexToNumber(hex: string): number {
  return parseInt(hex.replace('#', ''), 16);
}
