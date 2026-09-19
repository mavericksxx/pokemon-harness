/**
 * Silent stand-in for the app's `@/audio/audioEngine` (aliased in
 * astro.config.mjs). The showreel is a muted autoplay loop, and the real
 * engine pulls in howler plus IPC-backed settings. Exports exactly the names
 * the imported garden modules use:
 *   walkerLifecycle.ts  — playSpawnCry
 *   BattleManager.ts    — notifyBattleStart, notifyBattleEnd, playAttackSound, playVictoryChime
 *   EvolutionCeremony.ts — notifyEvolutionStart, notifyEvolutionFlash, notifyEvolutionEnd, playEvolutionCry
 */
export function playSpawnCry(_speciesId: string): void {}
export function notifyBattleStart(_parentId: string): void {}
export function notifyBattleEnd(_parentId: string): void {}
export function playAttackSound(_tool: string): void {}
export function playVictoryChime(): void {}
export function notifyEvolutionStart(): void {}
export function notifyEvolutionFlash(): void {}
export function notifyEvolutionEnd(): void {}
export function playEvolutionCry(_speciesId: string): void {}
