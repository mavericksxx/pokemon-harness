import { createRoot } from 'react-dom/client';
import { App } from './App';
import { useStore } from './store/store';
import { startSession, stopSession } from './sessions';
import {
  initAudio,
  debugSnapshot,
  Howler,
  notifyBattleStart,
  notifyBattleEnd,
  playAttackSound,
  playVictoryChime,
  notifyEvolutionStart,
  notifyEvolutionFlash,
  notifyEvolutionEnd,
  playSpawnCry,
  playEvolutionCry
} from './audio/audioEngine';
import { useAudioStore } from './audio/audioStore';
import './index.css';

// Independent of the garden scene's own mount/unmount — the speaker popover
// works even before/without it (see audioEngine.ts's initAudio doc comment).
void initAudio();

// Dev-only introspection hook (stripped from production builds by Vite's
// import.meta.env.DEV dead-code elimination) — lets an external CDP/manual
// verification pass drive the exact same session pipeline the UI uses,
// without a UI round-trip. See Phase 4 Part A/B verification notes.
if (import.meta.env.DEV) {
  (window as unknown as { __pokeDebug: unknown }).__pokeDebug = {
    sessions: () => useStore.getState().sessions,
    store: useStore,
    startSession,
    stopSession,
    // Phase 7 — audio: no speakers in CI, so verification reads Howler state
    // and this snapshot over CDP instead.
    audio: {
      Howler,
      store: useAudioStore,
      snapshot: debugSnapshot,
      // Exercises the same entry points BattleManager/EvolutionCeremony call,
      // without needing a live PTY session wired end-to-end — same rationale
      // as exposing startSession/stopSession above.
      notifyBattleStart,
      notifyBattleEnd,
      playAttackSound,
      playVictoryChime,
      notifyEvolutionStart,
      notifyEvolutionFlash,
      notifyEvolutionEnd,
      playSpawnCry,
      playEvolutionCry
    }
  };
}

const root = document.getElementById('root');
if (!root) throw new Error('#root missing');

// Deliberately NOT wrapped in StrictMode: the Pixi application and the PTY
// subscriptions are real, non-idempotent resources, and StrictMode's dev-only
// double mount would build two gardens.
createRoot(root).render(<App />);
