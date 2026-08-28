import { Container, Graphics, Text } from 'pixi.js';
import { ground, ink, hexToNumber } from '@/design/tokens';

// Speech bubble shown above a walker: "<icon> <target>" (e.g. "> App.tsx").
// Ported from munder-difflin (src/renderer/src/scene/office/ToolBubble.ts),
// itself ported from shahar061/the-office (office/characters/ToolBubble.ts).
//
// Recolored to the chrome neutral+ink system (design spec §5): these bubbles
// now also carry idle-chatter lines (gardenLines.ts), not just tool actions,
// so they read as part of the UI's text system rather than garden-only set
// dressing — the old dark-green/light-green pairing was a leftover from
// before that widened scope.

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
const PADDING_Y = 3;
const CORNER_RADIUS = 2; // spec: 0 everywhere, 2px max for corner clips
const MAX_WIDTH = 140;
const BG_COLOR = hexToNumber(ground[100]); // panel fill, not the app ground
const BG_ALPHA = 0.95;
const BORDER_COLOR = hexToNumber(ground[300]); // the border hairline token
const TEXT_COLOR = ink[900];
const FONT_SIZE = 12;
const RENDER_SCALE = 0.5; // render at 2x, scale down for crispness
const OFFSET_Y = -34;
const FADE_IN_DURATION = 0.15;
const FADE_OUT_DURATION = 0.3;
const LINGER_DURATION = 2.0;
const DOTS_CYCLE_SPEED = 0.5;
const WRAP_WIDTH = MAX_WIDTH / RENDER_SCALE - PADDING_X * 2;
const MAX_CHARS = 120;

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
    } else {
      this.state = 'visible';
      this.container.alpha = 1;
    }
    this.lingerElapsed = 0;
  }

  startLinger(): void {
    if (this.state === 'hidden') return;
    this.state = 'lingering';
    this.lingerElapsed = 0;
  }

  setPosition(px: number, py: number): void {
    const halfBubble = (this.bgW * RENDER_SCALE) / 2;
    // Round: the walker glides at sub-pixel steps every frame, and a bubble on
    // fractional coordinates resamples its half-scaled text differently each
    // frame — visible as shimmering while it walks.
    this.container.x = Math.round(px - halfBubble);
    this.container.y = Math.round(py + OFFSET_Y - this.bgH * RENDER_SCALE);
  }

  hide(): void {
    this.state = 'hidden';
    this.isThinking = false;
    this.container.alpha = 0;
    this.container.visible = false;
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
      }
    }

    switch (this.state) {
      case 'fading-in': {
        this.fadeElapsed += dt;
        const t = Math.min(this.fadeElapsed / FADE_IN_DURATION, 1);
        this.container.alpha = t;
        if (t >= 1) this.state = 'visible';
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
        if (t >= 1) this.hide();
        break;
      }
    }
  }

  destroy(): void {
    this.container.destroy({ children: true });
  }

  private redrawBg(): void {
    this.bgW = this.label.width + PADDING_X * 2;
    this.bgH = this.label.height + PADDING_Y * 2;
    this.bg.clear();
    this.bg.roundRect(0, 0, this.bgW, this.bgH, CORNER_RADIUS);
    this.bg.fill({ color: BG_COLOR, alpha: BG_ALPHA });
    this.bg.roundRect(0, 0, this.bgW, this.bgH, CORNER_RADIUS);
    this.bg.stroke({ width: 1, color: BORDER_COLOR, alpha: BG_ALPHA });
  }
}
