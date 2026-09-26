import { useCallback, useEffect, useRef, useState } from 'react';
import type { ExternalSessionSummary, ExternalTranscriptTurn } from '@shared/externalSessions';

interface Props {
  session: ExternalSessionSummary;
  onClose: () => void;
  onContinue: () => void;
}

/**
 * Read-only chat preview for a session started outside Pokéharness
 * (docs/external-sessions-plan.md §7 step 3) — a plain windowed React list,
 * not xterm (plan §2: "option A"). Loads older pages on scroll-to-top and
 * sticks to the bottom as live turns arrive via `subscribeExternalTranscript`.
 *
 * Every mount re-reads the transcript fresh (§2: "the preview is always
 * live") — there is no cross-open cache; unmounting always unsubscribes the
 * main-side tail watcher.
 */
export function TranscriptView({ session, onClose, onContinue }: Props): JSX.Element {
  const [turns, setTurns] = useState<ExternalTranscriptTurn[]>([]);
  const [cursor, setCursor] = useState<number | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [atTop, setAtTop] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);

  useEffect(() => {
    // D11 fix (2026-09-26 review): switching quickly from row A to row B
    // used to let A's late `loadInitial` resolve AFTER A's own cleanup had
    // already run — its `subscribe` call would land after B's effect had
    // taken over (leaking a main-side fs.watch on A's file), and its late
    // `setTurns` could overwrite B's already-loading pane. `cancelled` is
    // checked after every await, and if a subscribe call itself lands after
    // cancellation, it's unsubscribed again right away rather than left
    // running.
    let cancelled = false;

    const load = async (): Promise<void> => {
      setTurns([]);
      setCursor(null);
      setAtTop(false);
      const page = await window.api.readExternalTranscript(session.transcriptPath, null);
      if (cancelled) return;
      setTurns(page.turns);
      setCursor(page.cursor);
      if (page.cursor === null) setAtTop(true);
      await window.api.subscribeExternalTranscript(session.id, session.transcriptPath, page.tailOffset);
      if (cancelled) {
        void window.api.unsubscribeExternalTranscript(session.id);
      }
    };
    void load();

    const unsubscribeEvents = window.api.onExternalTranscriptTurns(session.id, (newTurns) => {
      if (cancelled) return;
      const el = listRef.current;
      stickToBottomRef.current = !el || el.scrollHeight - el.scrollTop - el.clientHeight < 40;
      setTurns((prev) => [...prev, ...newTurns]);
    });
    return () => {
      cancelled = true;
      unsubscribeEvents();
      void window.api.unsubscribeExternalTranscript(session.id);
    };
  }, [session.id, session.transcriptPath]);

  // Stick to the bottom for freshly-appended live turns, unless the user has
  // scrolled up to read history.
  useEffect(() => {
    if (!stickToBottomRef.current) return;
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns]);

  const loadOlder = useCallback(async () => {
    if (loadingOlder || cursor === null) return;
    setLoadingOlder(true);
    try {
      const el = listRef.current;
      const prevHeight = el?.scrollHeight ?? 0;
      const page = await window.api.readExternalTranscript(session.transcriptPath, cursor);
      setTurns((prev) => [...page.turns, ...prev]);
      setCursor(page.cursor);
      if (page.cursor === null) setAtTop(true);
      // Preserve scroll position — prepending content must not jump the view.
      requestAnimationFrame(() => {
        if (el) el.scrollTop += el.scrollHeight - prevHeight;
      });
    } finally {
      setLoadingOlder(false);
    }
  }, [cursor, loadingOlder, session.transcriptPath]);

  const onScroll = (): void => {
    const el = listRef.current;
    if (!el) return;
    stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    if (el.scrollTop < 60) void loadOlder();
  };

  const ageLabel = relativeAge(session.lastActiveAt);

  return (
    <div className="transcript-view">
      <header className="transcript-view-header">
        <span className="transcript-view-title">{session.title}</span>
        <span className="transcript-view-meta">
          {session.repoName}
          {session.gitBranch ? ` (${session.gitBranch})` : ''}
        </span>
        <span className={`badge badge-${session.source}`}>{session.source === 'desktop' ? 'Desktop' : 'CLI'}</span>
        <span className="transcript-view-meta">{ageLabel}</span>
        <span className="transcript-view-spacer" />
        <button type="button" className="transcript-view-continue" onClick={onContinue}>
          Continue session
        </button>
        <button type="button" className="icon tip" data-tip="close preview" onClick={onClose}>
          ×
        </button>
      </header>
      <div className="transcript-view-list" ref={listRef} onScroll={onScroll}>
        {!atTop && (
          <div className="transcript-view-loadmore">{loadingOlder ? 'loading…' : ' '}</div>
        )}
        {turns.map((t) => <TurnRow key={t.id} turn={t} />)}
        {turns.length === 0 && atTop && <p className="empty transcript-view-empty">no turns to show.</p>}
      </div>
    </div>
  );
}

function TurnRow({ turn }: { turn: ExternalTranscriptTurn }): JSX.Element {
  if (turn.kind === 'tool') {
    return <div className="transcript-turn transcript-turn-tool">{turn.summary}</div>;
  }
  // Muted one-liner for the CLI's own bracketed markup — slash-command
  // echoes, bash-input/stdout, background-task notices (2026-09-26 review,
  // item 1) — never rendered as raw `<tag>...</tag>` text.
  if (turn.kind === 'system') {
    return <div className="transcript-turn transcript-turn-system">{turn.summary}</div>;
  }
  return (
    <div className={turn.kind === 'user' ? 'transcript-turn transcript-turn-user' : 'transcript-turn transcript-turn-assistant'}>
      <span className="transcript-turn-role">{turn.kind === 'user' ? 'you' : 'claude'}</span>
      <span className="transcript-turn-text">{turn.text}</span>
    </div>
  );
}

function relativeAge(atMs: number): string {
  const deltaS = Math.max(0, Math.floor((Date.now() - atMs) / 1000));
  if (deltaS < 60) return 'just now';
  const m = Math.floor(deltaS / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}
