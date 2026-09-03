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
 * Mirrored onto `:root` as CSS custom properties by `applyTheme()` (called
 * once from `main.tsx` at boot, with dark defaults, then again once the
 * persisted theme setting resolves — parity sweep item 3 added a light
 * theme, see `groundLight`/`inkLight`/etc. below and `design/theme.ts`) so
 * existing class-based CSS in `index.css` keeps working unchanged —
 * components don't need to switch to inline styles from this module.
 *
 * VOICE (ship-cut item 6, lowercase sweep): every chrome string — labels,
 * buttons, headers, tooltips, toasts, notification bodies — is lowercase,
 * including the first word of a sentence-shaped hint (e.g. QuitDialog's
 * "quitting stops every session where it stands. claude sessions resume
 * next launch..."). Not colors/type/space, but it's this file's only home
 * for a rule that spans every component, so it lives here rather than
 * nowhere. Exemptions: user-entered content (session titles, workspace
 * names as typed) is shown verbatim; Pokemon species names and other proper
 * nouns (Claude Code, Codex CLI, Arceus, Mac) keep their real casing even
 * mid-sentence; game-flavor battle/flavor text keeps normal casing; the
 * brand mark is the one deliberate exception THIS rule creates rather than
 * follows — "pokéharness" is lowercase by design choice (App.tsx has the
 * font-rendering note), not because this rule forced it.
 */
import { TERMINAL_COLORS } from '@shared/terminalColors';

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
  terminal: TERMINAL_COLORS.dark.background,
  /** Disabled control fill — spec-added; not yet consumed anywhere before
   *  this pass (see `button:disabled` below). */
  disabled: '#313139'
} as const;

/** Text ramp — munder-difflin `--cth-ink-*` dark theme. `900` primary text,
 *  `700` secondary, `500` tertiary/muted, `300` the quietest divider tone
 *  (their comment: "meant to recede," 1.4-1.7:1 contrast — not for text). */
export const ink = {
  900: TERMINAL_COLORS.dark.foreground,
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

/** Text painted ON an accent fill (a primary button, a selected chip). The
 *  accents are light, saturated surfaces in BOTH themes (see `groundLight`
 *  below), so this is the SAME dark value in both — munder-difflin's own
 *  `--cth-on-accent` (light+dark theme, unchanged) uses the same logic:
 *  using the theme's own ink-900 here would invert with the theme and paint
 *  near-white text on a pale-gold button in light mode. */
export const onAccent = '#1A1320';

// ─── Light theme (parity sweep item 3) ─────────────────────────────────────
// munder-difflin tokens.css's base `:root` block (the LIGHT theme — their
// dark theme is the override) — same mapping as the dark constants above:
// ground[0..200] <- cream-50/100/200, ground[300] <- ink-300 (border),
// ground.terminal <- paper-100, ground.disabled <- cream-300, ink[300] <-
// ink-100 (dividers). See ATTRIBUTION.md.

export const groundLight = {
  0: '#FFFDF5', // cream-50 (light) — app background, garden letterbox
  100: '#FFF8E7', // cream-100 (light) — panel fill
  200: '#F4E9C7', // cream-200 (light) — raised/inset fill
  300: '#A899B5', // ink-300 (light) — hairline borders
  terminal: TERMINAL_COLORS.light.background, // paper-100 (light)
  disabled: '#E8D9A0' // cream-300 (light)
} as const;

export const inkLight = {
  900: TERMINAL_COLORS.light.foreground,
  700: '#3D2E4A',
  500: '#6B5878',
  300: '#D9CFE0' // ink-100 (light) — subtle dividers only
} as const;

export const accentLight = {
  coral: '#D96A62',
  mint: '#5CA97A',
  sky: '#4F9FAF',
  lemon: '#DCAB3C',
  lilac: '#9482D3',
  peach: '#D99168'
} as const;

/** Light-theme primary accent. Per the parity sweep's explicit instruction:
 *  use munder-difflin's light-theme lemon value (their tokens.css has no
 *  separate "brand gold" token at all — `gold` above was this app's own
 *  user-approved pick, split from their dark lemon). Measures ~2.08:1
 *  against `groundLight[0]` (WCAG relative-luminance formula) — well under
 *  the 4.5:1 text floor, so this literal spec value is now used ONLY for
 *  backgrounds/fills (button.primary, `.summon-arceus.active`, the roster
 *  evo-bar fill, the checked-checkbox swatch) where `onAccent`'s near-black
 *  text sits on top; see `accentTextLight` below for the darkened variant
 *  everywhere this accent is painted as text or a thin stroke/outline. */
export const goldLight = accentLight.lemon;
export const primaryAccentLight = goldLight;

/** Darkened light-theme accent for TEXT and thin strokes (borders, the
 *  selected-card ring, the focus outline, `.summon-arceus`'s inactive
 *  border+label) — `goldLight` itself (~2.08:1 on the palest ground) fails
 *  WCAG 4.5:1 for text, so this is a deeper amber/ochre in the same hue
 *  family (~36° hue vs. goldLight's ~42°, slightly higher saturation, much
 *  lower lightness) chosen to clear 4.5:1 against every light-theme surface
 *  this app paints text/strokes on — including `groundLight.disabled`
 *  (~4.77:1, the `.summon-arceus:hover` fill and the tightest of the four
 *  surfaces checked), `groundLight[200]` (~5.56:1), `groundLight[100]`
 *  (~6.36:1), and `groundLight[0]` (~6.61:1). Backgrounds/fills keep
 *  `goldLight` unchanged (dark `onAccent` text already reads fine there —
 *  see that token's own comment). Dark theme is untouched: `applyTheme`
 *  maps this slot to the same `primaryAccent` value dark theme already
 *  used. */
export const accentTextLight = '#7D5312';

export const statusLight = {
  starting: '#A199AB', // their light status-idle, used as-is (no WCAG relighten pass — see statusLight's header note)
  idle: '#4F9FAF', // their light status-thinking
  working: '#DCAB3C', // their light status-working
  blocked: '#D96A62', // their light status-blocked
  done: '#5CA97A' // their light status-success
} as const;

export const dangerLight = accentLight.coral;
export const dangerBorderLight = '#F3D3CD'; // their light coral-light fill

export const shinyLight = accentLight.lemon;

/** Hard shadow, light theme — their tokens.css light value (softer than the
 *  dark theme's, same "reads as depth, not void" intent). */
export const shadowHardLight = '3px 3px 0 rgba(26, 19, 32, 0.14)';

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
  // Density pass (topbar overhaul, BACKLOG.md brand-squash fix): the app
  // used to fake ~9% extra density with Chromium zoomLevel -0.5, which broke
  // Press Start 2P's integer pixel grid app-wide. Zoom is back to 0; these
  // two steps (the ones actually used for general chrome body text — see
  // index.css's --font-body-md/sm-size call sites) absorb that density
  // directly instead, at real, always-integer CSS px.
  bodyMd: { size: 13, line: 18 }, // was 14/20 (13/18 before that)
  bodySm: { size: 12, line: 16 }, // was 13/18 (11/15 before that)
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

/** Effective theme, after resolving a 'system' setting against the OS
 *  preference — see design/theme.ts's `resolveEffectiveTheme`. */
export type EffectiveTheme = 'light' | 'dark';

/** Convert the token modules above into a flat CSS custom-property map and
 *  stamp it onto `document.documentElement`, so `index.css`'s existing
 *  `var(--x)` references resolve to these values — picking the light or
 *  dark set per `mode`. Idempotent; safe to call more than once (hot reload,
 *  a theme-setting change, a live macOS-appearance change while the setting
 *  is 'system'). Called once from `main.tsx` before the first paint (with
 *  the dark defaults, so nothing ever renders with an unset custom
 *  property), then again once the persisted theme setting resolves. */
export function applyTheme(mode: EffectiveTheme): void {
  const dark = mode === 'dark';
  const g = dark ? ground : groundLight;
  const i = dark ? ink : inkLight;
  const a = dark ? accent : accentLight;
  const s = dark ? status : statusLight;

  const root = document.documentElement.style;
  root.setProperty('color-scheme', mode);
  root.setProperty('--bg', g[0]);
  root.setProperty('--panel', g[100]);
  root.setProperty('--panel-2', g[200]);
  root.setProperty('--bg-terminal', g.terminal);
  root.setProperty('--disabled', g.disabled);
  root.setProperty('--line', g[300]);
  root.setProperty('--text', i[900]);
  root.setProperty('--text-secondary', i[700]);
  root.setProperty('--muted', i[500]);
  root.setProperty('--muted-dim', i[300]);
  root.setProperty('--accent', dark ? primaryAccent : primaryAccentLight);
  root.setProperty('--gold', dark ? gold : goldLight);
  root.setProperty('--accent-text', dark ? primaryAccent : accentTextLight);
  root.setProperty('--on-accent', onAccent);
  root.setProperty('--danger', dark ? danger : dangerLight);
  root.setProperty('--danger-border', dark ? dangerBorder : dangerBorderLight);
  root.setProperty('--shiny', dark ? shiny : shinyLight);

  root.setProperty('--accent-coral', a.coral);
  root.setProperty('--accent-mint', a.mint);
  root.setProperty('--accent-sky', a.sky);
  root.setProperty('--accent-lemon', a.lemon);
  root.setProperty('--accent-lilac', a.lilac);
  root.setProperty('--accent-peach', a.peach);

  root.setProperty('--status-idle', s.idle);
  root.setProperty('--status-working', s.working);
  root.setProperty('--status-blocked', s.blocked);
  root.setProperty('--status-done', s.done);
  root.setProperty('--status-starting', s.starting);
  root.setProperty('--status-idle-bg', hexToRgba(s.idle, 0.2));
  root.setProperty('--status-working-bg', hexToRgba(s.working, 0.2));
  root.setProperty('--status-blocked-bg', hexToRgba(s.blocked, 0.2));
  root.setProperty('--status-done-bg', hexToRgba(s.done, 0.2));
  root.setProperty('--status-starting-bg', hexToRgba(s.starting, 0.2));

  for (const [k, v] of Object.entries(space)) root.setProperty(`--space-${k}`, `${v}px`);

  root.setProperty('--radius-sm', `${radius.sm}px`);
  root.setProperty('--radius-md', `${radius.md}px`);
  root.setProperty('--radius-lg', `${radius.lg}px`);

  root.setProperty('--shadow-hard', dark ? shadowHard : shadowHardLight);

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
