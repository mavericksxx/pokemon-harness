import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
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
 *
 * MUST be mounted with `key={session.id}` by the caller (TerminalDrawer.tsx)
 * — 2026-09-26 re-review: without a key, switching the `session` PROP alone
 * left this component's `useState`/`useRef` state (including
 * `stickToBottomRef`/`isInitializingRef`, and previously observed `turns`
 * itself) attached to the SAME instance across rows, and a confirmed-live
 * CDP repro showed the header updating to the new row while the turn list
 * kept showing an EARLIER row's content. A `key` change forces React to
 * fully unmount the old instance (running its cleanup, unsubscribing its
 * live tail) and mount a brand new one with fresh state — the one fix
 * that's correct regardless of which exact internal mechanism let the old
 * state survive.
 */
export function TranscriptView({ session, onClose, onContinue }: Props): JSX.Element {
  const [turns, setTurns] = useState<ExternalTranscriptTurn[]>([]);
  const [cursor, setCursor] = useState<number | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [atTop, setAtTop] = useState(false);
  // Inline failure state (2026-09-26 re-review) — a slow/huge/deleted
  // transcript must show an error in THIS pane, never a stuck spinner, and
  // must never block switching to another row (the `key`-remount above
  // already guarantees a NEW instance's own `load()` is entirely
  // independent of any earlier instance's still-pending promise — React
  // doesn't queue effects across different component instances, and Node's
  // main process handles each `readTranscript`/`subscribe` IPC call
  // independently, keyed only by the path/id argument it was called with).
  const [loadError, setLoadError] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);
  // True from mount until the initial open-at-bottom pin (below) has
  // actually completed for THIS session — guards `onScroll`/`loadOlder`
  // from firing off the transient scrollTop=0 an empty/just-loading list
  // starts at, which would otherwise immediately fetch (and prepend) more
  // history before the intended bottom-pin ever had a chance to land.
  const isInitializingRef = useRef(true);

  useEffect(() => {
    // D11 fix (2026-09-26 review): switching quickly from row A to row B
    // used to let A's late `loadInitial` resolve AFTER A's own cleanup had
    // already run — its `subscribe` call would land after B's effect had
    // taken over (leaking a main-side fs.watch on A's file), and its late
    // `setTurns` could overwrite B's already-loading pane. `cancelled` is
    // checked after every await, and if a subscribe call itself lands after
    // cancellation, it's unsubscribed again right away rather than left
    // running. With the caller now keying this component by `session.id`
    // (see this file's header), this effect's own [session.id,
    // session.transcriptPath] deps are belt-and-braces on top of that, not
    // the only thing preventing stale state.
    let cancelled = false;
    isInitializingRef.current = true;
    stickToBottomRef.current = true;

    const load = async (): Promise<void> => {
      setTurns([]);
      setCursor(null);
      setAtTop(false);
      setLoadError(null);
      try {
        const page = await window.api.readExternalTranscript(session.transcriptPath, null);
        if (cancelled) return;
        setTurns(page.turns);
        setCursor(page.cursor);
        if (page.cursor === null) setAtTop(true);
        await window.api.subscribeExternalTranscript(session.id, session.transcriptPath, page.tailOffset);
        if (cancelled) {
          void window.api.unsubscribeExternalTranscript(session.id);
        }
      } catch (err) {
        if (cancelled) return;
        setLoadError(err instanceof Error ? err.message : String(err));
        isInitializingRef.current = false; // nothing to pin to — let the error render immediately
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

  // Pins to the bottom once the FIRST page has actually laid out (2026-09-26
  // re-review, open-at-bottom fix) — `useLayoutEffect` runs synchronously
  // after DOM mutations but BEFORE the browser paints, so this never shows a
  // top-of-history flash first; the trailing `requestAnimationFrame` covers
  // any layout that only settles a frame later (e.g. font metrics). Once
  // `isInitializingRef` clears, this same effect's ELSE branch takes over
  // for ordinary live-tail "stick to bottom if already near it" behavior —
  // unchanged from before this fix.
  useLayoutEffect(() => {
    const el = listRef.current;
    if (!el) return;
    if (isInitializingRef.current) {
      if (turns.length === 0) return; // nothing laid out yet — wait for the first non-empty page
      el.scrollTop = el.scrollHeight;
      const raf = requestAnimationFrame(() => {
        const el2 = listRef.current;
        if (el2) el2.scrollTop = el2.scrollHeight;
        isInitializingRef.current = false;
        stickToBottomRef.current = true;
      });
      return () => cancelAnimationFrame(raf);
    }
    if (!stickToBottomRef.current) return;
    el.scrollTop = el.scrollHeight;
    return undefined;
  }, [turns]);

  const loadOlder = useCallback(async () => {
    if (loadingOlder || cursor === null || isInitializingRef.current) return;
    setLoadingOlder(true);
    try {
      const el = listRef.current;
      const prevHeight = el?.scrollHeight ?? 0;
      let nextCursor: number | null = cursor;
      let collected: ExternalTranscriptTurn[] = [];
      // A run of meta/system-only records (queue-operation, cost-state,
      // custom-title, sidechain turns, hidden CLI markup...) can span an
      // entire page with ZERO turns to show — keep reading backward
      // internally until a page actually produces something, or the top of
      // the file is reached, rather than returning a no-op page that would
      // leave scrollTop sitting right at the trigger threshold, re-firing
      // `loadOlder` on every subsequent scroll tick and fighting the user's
      // own scroll input (2026-09-26 re-review).
      for (let guard = 0; guard < 50 && nextCursor !== null && collected.length === 0; guard++) {
        const page = await window.api.readExternalTranscript(session.transcriptPath, nextCursor);
        collected = page.turns;
        nextCursor = page.cursor;
      }
      if (collected.length > 0) setTurns((prev) => [...collected, ...prev]);
      setCursor(nextCursor);
      if (nextCursor === null) setAtTop(true);
      if (collected.length > 0) {
        // Preserve scroll position — prepending content must not jump the view.
        requestAnimationFrame(() => {
          if (el) el.scrollTop += el.scrollHeight - prevHeight;
        });
      }
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingOlder(false);
    }
  }, [cursor, loadingOlder, session.transcriptPath]);

  const onScroll = (): void => {
    if (isInitializingRef.current) return;
    const el = listRef.current;
    if (!el) return;
    stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    if (el.scrollTop < 60) void loadOlder();
  };

  const ageLabel = relativeAge(session.lastActiveAt);

  return (
    <div className="transcript-view" onWheel={(e) => e.stopPropagation()}>
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
      {loadError ? (
        <div className="transcript-view-list transcript-view-error-wrap">
          <p className="error transcript-view-error">could not read this transcript: {loadError}</p>
        </div>
      ) : (
        <div className="transcript-view-list" ref={listRef} onScroll={onScroll}>
          {!atTop && <div className="transcript-view-loadmore">{loadingOlder ? 'loading…' : ' '}</div>}
          {turns.map((t) => (
            <TurnRow key={t.id} turn={t} />
          ))}
          {turns.length === 0 && atTop && <p className="empty transcript-view-empty">no turns to show.</p>}
        </div>
      )}
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
  // 2026-09-26 re-review, item 2: user and assistant turns must read as
  // visually distinct at a glance, not just by a small role label — a
  // tinted, accent-bordered block for the owner's own prompts vs. plain
  // text for Claude's replies, matching the app's existing "accent = mine"
  // convention (e.g. `.roster-card.selected`'s border).
  const isUser = turn.kind === 'user';
  return (
    <div className={isUser ? 'transcript-turn transcript-turn-user' : 'transcript-turn transcript-turn-assistant'}>
      <span className={isUser ? 'transcript-turn-role transcript-turn-role-user' : 'transcript-turn-role'}>
        {isUser ? 'You' : 'Claude'}
      </span>
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
