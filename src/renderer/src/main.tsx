import { createRoot } from 'react-dom/client';
import { App } from './App';
import { useStore } from './store/store';
import { startSession, stopSession } from './sessions';
import './index.css';

// Dev-only introspection hook (stripped from production builds by Vite's
// import.meta.env.DEV dead-code elimination) — lets an external CDP/manual
// verification pass drive the exact same session pipeline the UI uses,
// without a UI round-trip. See Phase 4 Part A/B verification notes.
if (import.meta.env.DEV) {
  (window as unknown as { __pokeDebug: unknown }).__pokeDebug = {
    sessions: () => useStore.getState().sessions,
    store: useStore,
    startSession,
    stopSession
  };
}

const root = document.getElementById('root');
if (!root) throw new Error('#root missing');

// Deliberately NOT wrapped in StrictMode: the Pixi application and the PTY
// subscriptions are real, non-idempotent resources, and StrictMode's dev-only
// double mount would build two gardens.
createRoot(root).render(<App />);
