/**
 * Design tokens — single source of truth for the app chrome (titlebar, tab
 * strip, popovers, picker, buttons, toasts, sidebar). The garden canvas
 * itself is untouched (Phase 8 §2): Pixi draws the world from its own art,
 * not from these.
 *
 * Structure (color ramp / space scale / type scale / panel border+shadow
 * language) is ported from munder-difflin's `design/tokens.ts` + `DESIGN.md`
 * §3-7 (MIT, see ATTRIBUTION.md) — but the values are ours: this app already
 * had a dark forest palette (index.css's old `:root` block) and a 6-color
 * session-tint set (`store.ts`'s `ACCENTS`) that lines up almost exactly with
 * their 6 agent-accent slots, so those hex codes are kept verbatim here
 * rather than replaced with their cream/violet ones. No pixel display font is
 * ported either — the renderer's CSP (`index.html`) is `default-src 'self'`
 * with no font-src, so a Google-Fonts pixel face isn't reachable, and this
 * app doesn't bundle one.
 *
 * Mirrored onto `:root` as CSS custom properties by `applyTokens()` (called
 * once from `main.tsx` at boot) so existing class-based CSS in `index.css`
 * keeps working unchanged — components don't need to switch to inline
 * styles from this module.
 */

/** Ground/surface ramp — darkest to lightest. Same values index.css already
 *  had (`--bg`/`--panel`/`--panel-2`), just named as a scale. */
export const ground = {
  0: '#0d150e', // app background, garden letterbox
  100: '#16220f', // panel fill (titlebar, drawer, popovers)
  200: '#1e2f16', // raised/inset fill (chips, inputs, list rows)
  300: '#2c4224' // hairline borders
} as const;

/** Text ramp. `900` is the old `--text`, `500` the old `--muted`. */
export const ink = {
  900: '#dfeed4',
  700: '#b9cdae',
  500: '#8fa383',
  300: '#5f7256'
} as const;

/** Session/agent accents — cycled per session by `store.ts`'s `ACCENTS`.
 *  Named here so chrome (roster cards, tab underlines) can reference the
 *  same hues by meaning instead of a raw hex. Order matches `ACCENTS`. */
export const accent = {
  gold: '#ffd166',
  sky: '#8ecae6',
  pink: '#ff8fa3',
  leaf: '#b5e48c',
  lilac: '#c8a2ff',
  amber: '#ffb27a'
} as const;

/** The app's primary accent (buttons, focus rings, brand mark) — leaf green,
 *  same as the old `--accent`. */
export const primaryAccent = accent.leaf;

/** Status semantics — same mapping index.css already used per `.status.*`. */
export const status = {
  starting: ink[500],
  idle: accent.sky,
  working: accent.leaf,
  blocked: '#ffd23f',
  done: ink[500]
} as const;

export const danger = '#ff8a8a';

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

/** Hard offset shadow, no blur — DESIGN.md §6.4. Replaces the old blurred
 *  `0 6px 18px rgba(...)` on popovers/modals/toasts. */
export const shadowHard = '4px 4px 0 rgba(0, 0, 0, 0.4)';

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

  root.setProperty('--accent-gold', accent.gold);
  root.setProperty('--accent-sky', accent.sky);
  root.setProperty('--accent-pink', accent.pink);
  root.setProperty('--accent-leaf', accent.leaf);
  root.setProperty('--accent-lilac', accent.lilac);
  root.setProperty('--accent-amber', accent.amber);

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
