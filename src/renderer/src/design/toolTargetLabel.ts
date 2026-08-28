/**
 * Display-layer compaction for a tool's target string — shown in the roster
 * card (`.roster-card-tool`, AgentRosterCard.tsx) and the garden speech
 * bubble (ToolBubble.ts, via GardenScene.tsx). Hook data reports raw values
 * with no length limit of its own: a full absolute path for Read/Edit/
 * Write/MultiEdit, or for Bash the exact shell command as typed — which can
 * be a single long space-run "token soup" (e.g. `cd <dir> && magick <a long
 * path> -crop ... -format ...`) that defeats plain CSS/word-based wrapping.
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
