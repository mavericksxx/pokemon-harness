import { Container, Graphics, Text } from 'pixi.js';
import { markDirty } from './renderDirty';

// Speech bubble shown above a walker: "<icon> <label>" (e.g. "> editing App.tsx").
// Ported from munder-difflin (src/renderer/src/scene/office/ToolBubble.ts),
// itself ported from shahar061/the-office (office/characters/ToolBubble.ts).
//
// Redesigned (garden bubble pass) as a miniature Game Boy-style dialogue box
// — hard 2px pixel border, opaque parchment fill, a blocky pixel step-tail
// pointing down at the walker's head — replacing the old plain dark rounded
// rect. Colors are fixed Pixi-native hex, not sourced from design/tokens:
// per that module's own header note the garden canvas draws from its own
// art rather than the app-chrome theme, and a static parchment/ink pair
// reads consistently against both grass and path tiles regardless of which
// chrome theme is active.

const TOOL_ICONS: Record<string, string> = {
  Read: '<',
  Edit: '>',
  MultiEdit: '>',
  Write: '>',
  Bash: '$',
  Grep: '?',
  Glob: '?',
  WebFetch: '@',
  WebSearch: '@',
  TodoWrite: '=',
  Task: '*'
};

const DEFAULT_ICON = '*';

const PADDING_X = 6;
const PADDING_Y = 4;
const BORDER_WIDTH = 2;
const FILL_COLOR = 0xf4ecd3; // parchment — Game Boy dialogue-box paper
const BORDER_COLOR = 0x2b2320; // near-black warm charcoal, not flat pure black
const TEXT_COLOR = 0x2b2320;
const FONT_SIZE = 12;
const RENDER_SCALE = 0.5; // render at 2x, scale down for crispness
const MAX_WIDTH = 140;
const WRAP_WIDTH = MAX_WIDTH / RENDER_SCALE - PADDING_X * 2;
const MAX_CHARS = 120;

// Blocky 2-step pixel tail under the box, tapering 8px -> 4px wide over 4px
// of drop — a "staircase" point rather than a smooth triangle, to stay on
// the hard pixel grid the rest of the box uses.
const TAIL_STEP_H = 2;
const TAIL_OUTER_HALF_W = 4;
const TAIL_INNER_HALF_W = 2;
const TAIL_HEIGHT = TAIL_STEP_H * 2;

// Small consistent gap between the tail tip and the sprite's head — the
// caller (Walker.ts) already passes a `py` that sits at the top of the
// sprite's head (feet position minus the sprite's own drawnHeight, which
// itself folds in that species' scale), so this is the ONLY altitude this
// bubble adds — no per-species tuning needed here.
const GAP = 6;

// Stepped pop-in: one snap from a half-size frame to full size, not a
// smooth tween — reads as a game-ish "blip" rather than an eased grow.
const POP_SCALE_START = 0.55;
const POP_DURATION = 0.08; // ~2 frames @60fps
const FADE_OUT_DURATION = 0.3;
const LINGER_DURATION = 2.0;
const DOTS_CYCLE_SPEED = 0.5;

type BubbleState = 'hidden' | 'fading-in' | 'visible' | 'lingering' | 'fading-out';

export function toolIcon(toolName: string): string {
  return TOOL_ICONS[toolName] ?? DEFAULT_ICON;
}

export class ToolBubble {
  readonly container: Container;
  private inner: Container;
  private bg: Graphics;
  private label: Text;
  private state: BubbleState = 'hidden';
  private fadeElapsed = 0;
  private lingerElapsed = 0;
  private bgW = 0;
  private bgH = 0;
  private isThinking = false;
  private dotsElapsed = 0;
  private dotsPhase = 0;

  constructor() {
    this.container = new Container();
    this.container.zIndex = 100000;
    this.container.eventMode = 'none';
    this.container.alpha = 0;
    this.container.visible = false;

    this.inner = new Container();
    this.inner.scale.set(RENDER_SCALE);
    this.container.addChild(this.inner);

    this.bg = new Graphics();
    this.label = new Text({
      text: '',
      style: {
        fontSize: FONT_SIZE,
        fontWeight: 'bold',
        fill: TEXT_COLOR,
        fontFamily: 'monospace',
        align: 'left',
        wordWrap: true,
        wordWrapWidth: WRAP_WIDTH,
        breakWords: true
      }
    });
    this.label.x = PADDING_X;
    this.label.y = PADDING_Y;

    this.inner.addChild(this.bg, this.label);
  }

  /** Show a tool action. Pass toolName='' & target='...' for a thinking ellipsis. */
  show(toolName: string, target: string): void {
    const icon = toolIcon(toolName);
    this.isThinking = !toolName && target === '...';

    if (this.isThinking) {
      this.dotsElapsed = 0;
      this.dotsPhase = 0;
      this.label.text = '.';
    } else {
      const displayText = target ? `${icon} ${target}` : `${icon} ${toolName}`;
      this.label.text =
        displayText.length > MAX_CHARS
          ? displayText.slice(0, MAX_CHARS - 1).trimEnd() + '…'
          : displayText;
    }

    this.redrawBg();
    this.reveal();
  }

  /** Show plain text with no tool icon (session title, block reason). */
  showText(text: string): void {
    this.isThinking = false;
    const display = text || '…';
    this.label.text =
      display.length > MAX_CHARS ? display.slice(0, MAX_CHARS - 1).trimEnd() + '…' : display;
    this.redrawBg();
    this.reveal();
  }

  private reveal(): void {
    if (this.state === 'hidden' || this.state === 'fading-out') {
      this.state = 'fading-in';
      this.fadeElapsed = 0;
      this.container.visible = true;
      this.container.alpha = 1;
      this.inner.scale.set(RENDER_SCALE * POP_SCALE_START);
    } else {
      this.state = 'visible';
      this.container.alpha = 1;
      this.inner.scale.set(RENDER_SCALE);
    }
    this.lingerElapsed = 0;
    markDirty(); // show()/showText() both funnel through here
  }

  startLinger(): void {
    if (this.state === 'hidden') return;
    this.state = 'lingering';
    this.lingerElapsed = 0;
  }

  /** `px, py`: the sprite's top-of-head world position — the caller already
   *  subtracts the sprite's own drawnHeight (which folds in that species'
   *  scale), so a small fixed GAP is all this needs regardless of how tall
   *  or short the species sprite is. */
  setPosition(px: number, py: number): void {
    // Round: the walker glides at sub-pixel steps every frame, and a bubble on
    // fractional coordinates resamples its half-scaled text differently each
    // frame — visible as shimmering while it walks.
    this.container.x = Math.round(px);
    this.container.y = Math.round(py - GAP);
  }

  hide(): void {
    this.state = 'hidden';
    this.isThinking = false;
    this.container.alpha = 0;
    this.container.visible = false;
    markDirty();
  }

  isHidden(): boolean {
    return this.state === 'hidden';
  }

  update(dt: number): void {
    if (this.isThinking && (this.state === 'visible' || this.state === 'fading-in')) {
      this.dotsElapsed += dt;
      const newPhase = Math.floor(this.dotsElapsed / DOTS_CYCLE_SPEED) % 3;
      if (newPhase !== this.dotsPhase) {
        this.dotsPhase = newPhase;
        this.label.text = ['.', '..', '...'][this.dotsPhase];
        this.redrawBg();
        markDirty();
      }
    }

    switch (this.state) {
      case 'fading-in': {
        this.fadeElapsed += dt;
        if (this.fadeElapsed >= POP_DURATION / 2) {
          this.inner.scale.set(RENDER_SCALE);
        }
        if (this.fadeElapsed >= POP_DURATION) this.state = 'visible';
        markDirty(); // scale (pop-in) or state settling, every frame while active
        break;
      }
      case 'lingering': {
        this.lingerElapsed += dt;
        if (this.lingerElapsed >= LINGER_DURATION) {
          this.state = 'fading-out';
          this.fadeElapsed = 0;
        }
        break;
      }
      case 'fading-out': {
        this.fadeElapsed += dt;
        const t = Math.min(this.fadeElapsed / FADE_OUT_DURATION, 1);
        this.container.alpha = 1 - t;
        markDirty(); // alpha steps every frame while fading out
        if (t >= 1) this.hide();
        break;
      }
    }
  }

  destroy(): void {
    this.container.destroy({ children: true });
  }

  private redrawBg(): void {
    // Snap to a 4px/2px grid (not just the nearest integer): the pivot below
    // sits at (bgW/2, bgH+TAIL_HEIGHT) in inner's *unscaled* space, and inner
    // renders at RENDER_SCALE (0.5) — so bgW must land on a multiple of 4 and
    // bgH on a multiple of 2 (TAIL_HEIGHT already is) for that pivot point,
    // and the text/border pixels around it, to fall on whole device pixels
    // rather than resampling soft.
    this.bgW = Math.ceil((this.label.width + PADDING_X * 2) / 4) * 4;
    this.bgH = Math.ceil((this.label.height + PADDING_Y * 2) / 2) * 2;

    // Pivot on the tail tip (bottom-center, below the box+tail) so both the
    // fixed screen position (setPosition) and the pop-in scale animation
    // (update) anchor at the point nearest the walker's head, not the box's
    // top-left corner.
    this.inner.pivot.set(this.bgW / 2, this.bgH + TAIL_HEIGHT);

    this.bg.clear();
    this.bg.rect(0, 0, this.bgW, this.bgH);
    this.bg.fill(FILL_COLOR);
    this.bg.rect(0, 0, this.bgW, this.bgH);
    this.bg.stroke({ width: BORDER_WIDTH, color: BORDER_COLOR });

    const cx = this.bgW / 2;
    const y0 = this.bgH;
    const y1 = y0 + TAIL_STEP_H;
    const y2 = y1 + TAIL_STEP_H;
    const tailPoints = [
      cx - TAIL_OUTER_HALF_W, y0,
      cx - TAIL_OUTER_HALF_W, y1,
      cx - TAIL_INNER_HALF_W, y1,
      cx - TAIL_INNER_HALF_W, y2,
      cx + TAIL_INNER_HALF_W, y2,
      cx + TAIL_INNER_HALF_W, y1,
      cx + TAIL_OUTER_HALF_W, y1,
      cx + TAIL_OUTER_HALF_W, y0
    ];
    this.bg.poly(tailPoints);
    this.bg.fill(FILL_COLOR);
    this.bg.poly(tailPoints);
    this.bg.stroke({ width: BORDER_WIDTH, color: BORDER_COLOR });
  }
}
