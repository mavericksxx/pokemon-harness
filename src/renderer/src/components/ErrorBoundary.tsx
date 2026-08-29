import { Component, type ErrorInfo, type ReactNode } from 'react';
import { safeLogDiagnostic } from '@/diagnosticsClient';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
}

/**
 * Top-level React render-error catch (BACKLOG friend-testing readiness) —
 * before this existed, an uncaught throw during render anywhere in the tree
 * unmounted the whole app with zero trace in harness.log: `window.onerror`
 * (main.tsx) doesn't fire for React's own render-phase errors, and the
 * result was a permanent white screen a beta tester had no way to describe
 * beyond "it went blank." React only exposes this via a class component
 * (`componentDidCatch`/`getDerivedStateFromError` have no hook equivalent).
 *
 * Deliberately minimal: log once, then a small "reload" fallback instead of
 * main's own crash/reload recovery UI — main's own PTYs and sessions are
 * untouched by a renderer-only error, and `window.location.reload()` re-runs
 * main.tsx's `boot()`, which already re-adopts them (same path a renderer
 * crash's `render-process-gone` reload takes).
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    safeLogDiagnostic('renderer', 'error', 'React render error', {
      message: error.message,
      stack: error.stack,
      componentStack: info.componentStack
    });
  }

  render(): ReactNode {
    if (this.state.hasError) {
      return (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '12px',
            height: '100vh',
            width: '100vw',
            color: '#ddd',
            background: '#1a1a1a',
            fontFamily: 'system-ui, sans-serif'
          }}
        >
          <p>something went wrong — the error's been logged.</p>
          <button type="button" onClick={() => window.location.reload()}>
            reload
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
