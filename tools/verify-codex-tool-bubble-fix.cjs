#!/usr/bin/env node
'use strict';
/**
 * Regression check for GitHub issue #1: a Codex session's speech bubble
 * sometimes read `$ running 3` instead of an actual shell command.
 *
 * Root cause: Codex has no hook-backed status source, so ptyParser.ts
 * regex-scrapes its raw PTY bytes for tool/toolTarget. During a partial
 * mid-redraw repaint, Codex's own status footer could glue directly onto a
 * captured "Ran ..." target with no separator; when the glued fragment
 * started with a bare digit, that digit became the whole "command" text,
 * rendered as `$ running <digit>` by the (intentional, unchanged)
 * `$ running <text>` bubble format.
 *
 * This project has no test framework (no jest/vitest/mocha in package.json),
 * so this is a plain Node script per the tools/*.cjs convention already used
 * here (see tools/ensure-pty-perms.cjs). ptyParser.ts and toolTargetLabel.ts
 * are TypeScript with non-trivial imports (the store, ansiText, etc.), so
 * rather than transpile them this script duplicates just the two fixed
 * regexes and the two fixed functions verbatim. To keep that duplication
 * honest, assertSourceContains() below reads the real .ts files and fails
 * loudly if the duplicated regex literals ever drift from what's actually
 * shipped, instead of silently testing a stale copy.
 *
 * Run with: node tools/verify-codex-tool-bubble-fix.cjs
 */
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

// --- Duplicated from src/renderer/src/pty/ptyParser.ts ---
const CODEX_RAN_RE = /•\s+Ran\s+(?!\s*\d+(?:[\s•›└]|$))([^\n•›└]+)/g;
const CODEX_SUBACTION_RE = /└\s+(List|Read)\s+(?!\s*\d+(?:[\s•›└]|$))([^\n•›└]+)/g;

// --- Duplicated from src/renderer/src/design/toolTargetLabel.ts ---
function firstBashWord(command) {
  const withoutCd = command.replace(/^cd\s+\S+\s*(?:&&|;|\||\n)\s*/, '');
  const rest = (withoutCd || command).trim();
  const firstToken = rest.split(/\s+/)[0] ?? rest;
  const word = firstToken.split('/').pop();
  if (!word || word.length < 2 || /^\d+$/.test(word)) return 'a command';
  return word;
}

function formatBubbleLabelBash(target) {
  const t = (target ?? '').trim();
  return `running ${t ? firstBashWord(t) : 'a command'}`;
}

// --- Fixtures ---
let failures = 0;

function check(name, actual, expected) {
  const pass = actual === expected;
  if (!pass) failures++;
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${name}`);
  console.log(`       got:      ${JSON.stringify(actual)}`);
  console.log(`       expected: ${JSON.stringify(expected)}`);
}

/** Fails loudly (rather than silently testing a stale copy) if the regex
 *  literals duplicated above ever drift from what ptyParser.ts actually
 *  ships. */
function assertSourceContains(relPath, needle, label) {
  const filePath = join(__dirname, '..', relPath);
  const source = readFileSync(filePath, 'utf8');
  const pass = source.includes(needle);
  if (!pass) failures++;
  console.log(`[${pass ? 'PASS' : 'FAIL'}] source check: ${label}`);
  if (!pass) console.log(`       ${relPath} no longer contains: ${needle}`);
}

assertSourceContains(
  'src/renderer/src/pty/ptyParser.ts',
  'const CODEX_RAN_RE = /•\\s+Ran\\s+(?!\\s*\\d+(?:[\\s•›└]|$))([^\\n•›└]+)/g;',
  'CODEX_RAN_RE matches the duplicate in this script'
);
assertSourceContains(
  'src/renderer/src/pty/ptyParser.ts',
  'const CODEX_SUBACTION_RE = /└\\s+(List|Read)\\s+(?!\\s*\\d+(?:[\\s•›└]|$))([^\\n•›└]+)/g;',
  'CODEX_SUBACTION_RE matches the duplicate in this script'
);

// (a) Normal, unglued line — proves the regex still parses a real command.
{
  CODEX_RAN_RE.lastIndex = 0;
  const m = CODEX_RAN_RE.exec('• Ran ls -la\n');
  const target = m ? m[1].trim() : null;
  check('(a) unglued "• Ran ls -la" still captures a real command', target, 'ls -la');
  check('(a) firstBashWord/formatBubbleLabel renders it normally', formatBubbleLabelBash(target), 'running ls');
}

// (b) Synthetic glued-footer fixture reproducing the "$ running 3" bug
// shape: "Ran <cmd>" with Codex's own status footer glued directly onto the
// end, no separator, and a bare leading digit right after "Ran ". This is
// the exact shape that used to make CODEX_RAN_RE capture just "3".
{
  const glued = '• Ran 3 (12s • esc to interrupt) · Ctrl+C to quit\n';
  CODEX_RAN_RE.lastIndex = 0;
  const m = CODEX_RAN_RE.exec(glued);
  check('(b) glued-footer fixture no longer matches at all (rejected by the guard)', m, null);
}
{
  // Same shape, but the digit is immediately followed by a stop char instead
  // of whitespace — also must be rejected.
  const glued = '• Ran 3•esc to interrupt\n';
  CODEX_RAN_RE.lastIndex = 0;
  const m = CODEX_RAN_RE.exec(glued);
  check('(b) glued-footer fixture (digit then stop char) also rejected', m, null);
}
{
  // CODEX_SUBACTION_RE's List verb maps to the Bash tool too (see
  // CODEX_VERB_TO_TOOL in ptyParser.ts), so it can hit the same bubble text
  // and needs the same guard.
  const glued = '  └ List 3 (12s • esc to interrupt) · Ctrl+C to quit\n';
  CODEX_SUBACTION_RE.lastIndex = 0;
  const m = CODEX_SUBACTION_RE.exec(glued);
  check('(b) glued-footer fixture on CODEX_SUBACTION_RE also rejected', m, null);
}
{
  // Regression for a backtracking hole in the lookahead: `Ran\s+` is greedy
  // but can give back a space to let `(?!\d+...)` see a clean digit start,
  // sliding the extra space into the capture instead of being rejected —
  // real input can have runs of >1 space (translated cursor-forwards
  // standing for several columns, per the space-collapse comment in
  // ptyParser.ts). The lookahead's own `\s*` must absorb that space too.
  const glued = '• Ran  3 (12s • esc to interrupt) · Ctrl+C to quit\n';
  CODEX_RAN_RE.lastIndex = 0;
  const m = CODEX_RAN_RE.exec(glued);
  check('(b) glued-footer fixture with extra leading whitespace also rejected', m, null);
}

// (c) Numeric-only / suspiciously-short target hitting the toolTargetLabel.ts
// guard directly — defense in depth regardless of what parses through.
check('(c) numeric-only target "3" falls back to generic label', formatBubbleLabelBash('3'), 'running a command');
check('(c) single-char target "x" falls back to generic label', formatBubbleLabelBash('x'), 'running a command');
check('(c) legitimate short command "ls" is NOT swallowed', formatBubbleLabelBash('ls'), 'running ls');
check('(c) legitimate short command "cd" is NOT swallowed', formatBubbleLabelBash('cd'), 'running cd');

console.log('');
if (failures > 0) {
  console.log(`${failures} fixture(s) FAILED`);
  process.exit(1);
} else {
  console.log('All fixtures PASSED');
  process.exit(0);
}
