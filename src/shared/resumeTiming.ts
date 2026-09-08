/** Grace period a `claude --resume` respawn gets before it's trusted to
 *  actually be alive — an invalid/expired session id makes the CLI print an
 *  error and exit almost immediately, which a bare successful spawn() can't
 *  detect (the binary itself started fine). Shared between main's own
 *  disk-persisted respawn (`main/sessionRespawn.ts`) and the renderer's
 *  mid-run Arceus resume (`renderer/src/arceus.ts`'s `tryResumeArceus`) —
 *  both wait out the identical failure mode for the identical reason. Plain
 *  number, no node/electron imports, so both sides can import it as-is. */
export const RESUME_GRACE_MS = 4000;
