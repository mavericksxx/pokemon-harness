/**
 * Arceus's system prompt file (Phase 8.8 §2) — `agents/arceus/SYSTEM.md` in
 * the harness home directory (see harnessHome.ts; that module already
 * creates the empty `agents/` dir it lives under). Written ONCE, from the
 * user-approved template (shared/arceus.ts), the first time Arceus is ever
 * summoned — never overwritten after, so the user can retune him by editing
 * the FILE, not code. Every summon re-reads it fresh; nothing here caches
 * the contents across calls.
 */
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ARCEUS_SYSTEM_PROMPT_TEMPLATE, ARCEUS_SYSTEM_PROMPT_TEMPLATE_V1 } from '../shared/arceus';

function arceusDir(harnessHomeDir: string): string {
  return join(harnessHomeDir, 'agents', 'arceus');
}

/** Exported for `PtyManager.setArceusPaths` (main/index.ts, at boot and on
 *  every harness-home change) — pty.ts's `spawn()` reads this file fresh at
 *  every Arceus spawn to compose his one system-prompt file (shared/
 *  arceus.ts's `buildArceusSystemPrompt`), the same "live source" contract
 *  this function's own fresh-read already relies on for the renderer's
 *  `ensureArceusSystemPrompt` IPC round trip. */
export function arceusSystemPromptPath(harnessHomeDir: string): string {
  return join(arceusDir(harnessHomeDir), 'SYSTEM.md');
}

/** Ensures the file exists (seeding it from the template on first call
 *  only) and returns its CURRENT on-disk contents plus its path — called
 *  fresh on every summon (see arceus.ts's renderer-side `summonArceus`), so
 *  a user's edit to the file takes effect the very next time Arceus is
 *  summoned, no app restart needed. The returned `prompt`/`path` are no
 *  longer used to build a first-prompt (pty.ts's `spawn()` re-reads the file
 *  itself at spawn time to compose his system prompt, appending the
 *  code-owned tool contract regardless of what's here); calling this before
 *  every real spawn is still what guarantees the file — and (via the
 *  `arceus:ensureSystemPrompt` IPC handler's own extra call, ipc/app.ts) —
 *  roster.json exist on disk before that read.
 *
 *  Arceus v2 migration (advisor must-fix): a real install's SYSTEM.md may
 *  predate this change and still be the OLD v1 seed describing the deleted
 *  `@@relay` directive — with `ArceusRelayWatcher` gone, that would have
 *  Arceus emit `@@relay` lines into a void forever. If the on-disk file is
 *  STILL byte-identical to `ARCEUS_SYSTEM_PROMPT_TEMPLATE_V1` (never
 *  hand-edited), it's migrated to the current template; any OTHER content
 *  (a genuine user edit, or an already-migrated v2 file) is left alone,
 *  same "never overwritten once touched" contract this function always had. */
export async function ensureArceusSystemPrompt(
  harnessHomeDir: string
): Promise<{ path: string; prompt: string }> {
  await mkdir(arceusDir(harnessHomeDir), { recursive: true });
  const p = arceusSystemPromptPath(harnessHomeDir);
  if (!existsSync(p)) {
    await writeFile(p, ARCEUS_SYSTEM_PROMPT_TEMPLATE, 'utf8');
  } else {
    const current = await readFile(p, 'utf8');
    if (current === ARCEUS_SYSTEM_PROMPT_TEMPLATE_V1) {
      await writeFile(p, ARCEUS_SYSTEM_PROMPT_TEMPLATE, 'utf8');
    }
  }
  const prompt = await readFile(p, 'utf8');
  return { path: p, prompt };
}
