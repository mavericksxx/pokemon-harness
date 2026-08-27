import { createRoot } from 'react-dom/client';
import { App } from './App';
import './index.css';

const root = document.getElementById('root');
if (!root) throw new Error('#root missing');

// Deliberately NOT wrapped in StrictMode: the Pixi application and the PTY
// subscriptions are real, non-idempotent resources, and StrictMode's dev-only
// double mount would build two gardens.
createRoot(root).render(<App />);
