/**
 * Scripted terminal pane — a plain DOM stand-in for the app's xterm drawer,
 * typed out on the showreel's own clock (so it pauses with the garden).
 */
export type Wait = (ms: number) => Promise<void>;

export type LineKind = 'cmd' | 'prompt' | 'tool' | 'result' | 'dim' | 'banner' | 'ok';

export class ReelTerminal {
  private body: HTMLElement;
  private title: HTMLElement;

  constructor(
    root: HTMLElement,
    private wait: Wait
  ) {
    this.body = root.querySelector<HTMLElement>('[data-term-body]')!;
    this.title = root.querySelector<HTMLElement>('[data-term-title]')!;
  }

  clear(title: string): void {
    this.body.textContent = '';
    this.title.textContent = title;
  }

  /** Print a whole line at once. */
  print(text: string, kind: LineKind = 'result'): HTMLElement {
    const line = document.createElement('div');
    line.className = `term-line term-${kind}`;
    line.textContent = text;
    this.body.appendChild(line);
    // Keep only what fits; older lines scroll off the top like a real pty.
    while (this.body.childElementCount > 40) this.body.firstElementChild?.remove();
    this.body.scrollTop = this.body.scrollHeight;
    return line;
  }

  /** Type a line character by character, with a caret while it's typing. */
  async type(text: string, kind: LineKind = 'cmd', perCharMs = 34): Promise<void> {
    const line = this.print('', kind);
    line.classList.add('term-typing');
    for (const ch of text) {
      line.textContent += ch;
      this.body.scrollTop = this.body.scrollHeight;
      await this.wait(ch === ' ' ? perCharMs * 0.6 : perCharMs);
    }
    line.classList.remove('term-typing');
  }

  /** A Claude Code tool call: `● Tool(target)` then its `⎿` result. */
  async tool(name: string, target: string, result: string, thinkMs = 700): Promise<void> {
    this.print(`● ${name}(${target})`, 'tool');
    await this.wait(thinkMs);
    this.print(`  ⎿  ${result}`, 'result');
  }
}
