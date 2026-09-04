/**
 * Display-layer compaction for a tool's target string — shown in the roster
 * card (`.roster-card-tool`, AgentRosterCard.tsx) and the garden speech
 * bubble (ToolBubble.ts, via GardenScene.tsx). Hook data reports raw values
 * with no length limit of its own: a full absolute path for Read/Edit/
 * Write/MultiEdit, or for Bash the exact shell command as typed — which can
 * be a single long space-run "token soup" (e.g. `cd <dir> && magick <a long
 * path> -crop ... -format ...`) that defeats plain CSS/word-based wrapping.
 *
 * `formatToolTarget` below feeds the roster card, which has room for a
 * compact-but-still-technical rendering (path tails, a command word + arg
 * tail). `formatBubbleLabel` feeds the garden bubble instead: at garden
 * scale a raw path/command reads as noise (a `$ sed …src/index.css` tail
 * told a player nothing useful), so it trades completeness for a short
 * human phrase — a verb plus the one meaningful fragment (a bare filename,
 * not a path; a command word, not its flags) — hard-capped well under the
 * roster card's limits.
 *
 * Purely a display reformat — never touches session data, and the hook/pty
 * ingestion side (hookRouter.ts, ptyParser.ts) is untouched.
 */

const BASH_COMMAND_MAX = 20;
const BASH_TAIL_MAX = 20;
const PATH_MAX = 40;
const PLAIN_MAX = 60;

/** `cd <dir> && magick some/very/long/path.png -crop 20x20+0+0 …` →
 *  `magick …0+0+repage.png` — drop a leading `cd <dir>` segment (almost
 *  never the interesting part of a Bash call), then show the command word
 *  plus a short tail of its arguments, both hard-capped so the combined
 *  result can never exceed roughly BASH_COMMAND_MAX + BASH_TAIL_MAX chars
 *  regardless of how long either half is. */
function compactBashCommand(command: string): string {
  const withoutCd = command.replace(/^cd\s+\S+\s*(?:&&|;|\||\n)\s*/, '');
  const rest = withoutCd || command;

  const firstSpace = rest.search(/\s/);
  const head = firstSpace === -1 ? rest : rest.slice(0, firstSpace);
  const args = firstSpace === -1 ? '' : rest.slice(firstSpace + 1).replace(/\s+/g, ' ').trim();

  const shortHead = head.length > BASH_COMMAND_MAX ? head.slice(0, BASH_COMMAND_MAX - 1) + '…' : head;
  if (!args) return shortHead;

  const shortTail = args.length > BASH_TAIL_MAX ? '…' + args.slice(-BASH_TAIL_MAX) : args;
  return `${shortHead} ${shortTail}`;
}

/** `/Users/mav/Developer/pokemon-harness/src/renderer/src/index.css` →
 *  `…/renderer/src/index.css` — keeps the tail of the path (the part a user
 *  actually wants to read), cutting at a `/` boundary when one falls inside
 *  the kept window so it doesn't split a directory/file name in half. */
function middleTruncatePath(path: string): string {
  if (path.length <= PATH_MAX) return path;
  const tailChars = path.slice(-(PATH_MAX - 1));
  const slashIdx = tailChars.indexOf('/');
  const tail = slashIdx > 0 && slashIdx < tailChars.length - 1 ? tailChars.slice(slashIdx) : tailChars;
  return `…${tail}`;
}

export function formatToolTarget(tool: string | undefined, target: string | undefined): string {
  if (!target) return target ?? '';
  if (tool === 'Bash') return compactBashCommand(target.trim());
  if (target.includes('/') && !target.includes(' ')) return middleTruncatePath(target);
  return target.length > PLAIN_MAX ? target.slice(0, PLAIN_MAX - 1).trimEnd() + '…' : target;
}

const BUBBLE_MAX = 24;

function capBubble(text: string): string {
  return text.length > BUBBLE_MAX ? text.slice(0, BUBBLE_MAX - 1).trimEnd() + '…' : text;
}

/** `/Users/mav/…/src/renderer/src/index.css` -> `index.css` — the bubble
 *  phrase wants just the filename, never a path fragment. */
function lastPathSegment(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  const idx = trimmed.lastIndexOf('/');
  return idx === -1 ? trimmed : trimmed.slice(idx + 1);
}

/** `cd /some/dir && sed -i '' -e 's/a/b/' src/index.css` -> `sed` — drop a
 *  leading `cd <dir>` segment (per compactBashCommand above), then take the
 *  first whitespace-delimited word and its own basename (so `/usr/bin/sed`
 *  still reads as `sed`). */
function firstBashWord(command: string): string {
  const withoutCd = command.replace(/^cd\s+\S+\s*(?:&&|;|\||\n)\s*/, '');
  const rest = (withoutCd || command).trim();
  const firstToken = rest.split(/\s+/)[0] ?? rest;
  const word = firstToken.split('/').pop();
  // Defensive fallback for a leftover fragment that slipped past the regex
  // scrape (issue #1) — a real command word is never a bare number, and
  // legitimate short ones (ls, cd) are still 2+ chars, so this only catches
  // garbage.
  if (!word || word.length < 2 || /^\d+$/.test(word)) return 'a command';
  return word;
}

/** Short game-flavored phrase for the garden speech bubble: verb + the one
 *  meaningful fragment, lowercase, hard-capped to BUBBLE_MAX chars. Unlike
 *  `formatToolTarget`, this never shows a path or raw command — see this
 *  file's header comment. */
export function formatBubbleLabel(tool: string | undefined, target: string | undefined): string {
  const t = (target ?? '').trim();
  switch (tool) {
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
    case 'NotebookEdit':
      return capBubble(t ? `editing ${lastPathSegment(t)}` : 'editing');
    case 'Read':
      return capBubble(t ? `reading ${lastPathSegment(t)}` : 'reading');
    case 'Bash':
      return capBubble(`running ${t ? firstBashWord(t) : 'a command'}`);
    case 'Grep':
    case 'Glob':
      return capBubble(t ? `searching ${t}` : 'searching');
    case 'WebSearch':
      return capBubble(t ? `searching ${t}` : 'browsing');
    case 'WebFetch':
      return 'browsing';
    case 'Task':
      return 'summoning help';
    case 'TodoWrite':
      return 'planning';
    default: {
      const toolLabel = tool ? tool.toLowerCase() : 'working';
      if (!t) return toolLabel;
      return capBubble(`${toolLabel} ${t.includes('/') ? lastPathSegment(t) : t}`);
    }
  }
}
