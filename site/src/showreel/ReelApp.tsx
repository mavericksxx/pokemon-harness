/**
 * The app window the showreel plays inside — a trimmed copy of the app's
 * own App.tsx layout (topbar, party rail, garden column, terminal drawer)
 * built from the app's REAL components, reading the app's REAL zustand
 * stores (which reel.ts fills with scripted sessions). Only three pieces are
 * replicated rather than imported:
 *   - the audio button (AudioPopover pulls in the howler audio engine);
 *   - GardenScene itself (the reel mounts the Pixi scene headlessly via
 *     garden.ts — its JSX shell below is copied from GardenScene.tsx);
 *   - the window's title-bar traffic lights (macOS draws those, not the app).
 * Styling is the app's own index.css, scoped under `.reel-app` at build time.
 */
import { createRef, type RefObject } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';
import '@/index.css';
import { useStore } from '@/store/store';
import { ARCEUS_SESSION_ID } from '@shared/arceus';
import { RosterStrip } from '@/components/RosterStrip';
import { TerminalDrawer } from '@/components/TerminalDrawer';
import { ViewModeSwitcher } from '@/components/ViewModeSwitcher';
import { WorkspaceSwitcher } from '@/components/WorkspaceSwitcher';
import { HarnessInstructionsChip } from '@/components/HarnessInstructionsChip';
import { UsageChip } from '@/components/UsageChip';
import { NotificationBell } from '@/components/NotificationBell';
import { ThemeToggle } from '@/components/ThemeToggle';
import { QuickSettings } from '@/components/QuickSettings';
import { DayNightToggle } from '@/components/DayNightToggle';
import { ArceusWarp } from '@/components/ArceusWarp';
import { ArceusHud } from '@/components/ArceusHud';
import { DoubleChevronRightIcon, PokeballIcon, SpeakerHighIcon } from '@/components/icons';

function ReelWindow({ hostRef }: { hostRef: RefObject<HTMLDivElement> }): JSX.Element {
  const ascended = useStore((s) => s.selectedId === ARCEUS_SESSION_ID);
  return (
    <div className="app">
      <header className="topbar">
        <span className="brand-lockup">
          <PokeballIcon className="brand-icon" />
          <span className="brand">pokéharness</span>
        </span>
        <div className="spacer" />
        <div className="topbar-actions">
          <div className="topbar-zone topbar-zone-stage">
            <ViewModeSwitcher />
          </div>
          <div className="topbar-zone topbar-zone-garden">
            <WorkspaceSwitcher />
            <HarnessInstructionsChip />
          </div>
          <UsageChip />
          <div className="topbar-zone topbar-zone-system">
            <div className="audio-popover">
              <button type="button" className="topbar-icon-btn" aria-label="music player">
                <SpeakerHighIcon />
              </button>
            </div>
            <NotificationBell />
            <ThemeToggle />
            <QuickSettings />
            {!ascended && (
              <button type="button" className="topbar-icon-btn" aria-label="hide terminal" aria-pressed>
                <DoubleChevronRightIcon />
              </button>
            )}
          </div>
        </div>
      </header>
      <main className="body">
        <div className="body-row">
          <RosterStrip onNewSession={() => {}} />
          <div className="garden-column" data-view-mode="garden" style={{ display: 'flex' }}>
            <div className="garden-mat">
              <div className="garden-warp-frame">
                <div className="garden" ref={hostRef} />
                {!ascended && <DayNightToggle />}
                <ArceusWarp hostRef={hostRef} ascended={ascended} />
                <ArceusHud ascended={ascended} />
              </div>
            </div>
          </div>
          <TerminalDrawer />
        </div>
      </main>
    </div>
  );
}

export interface ReelWindowHandle {
  gardenHost: HTMLDivElement;
  destroy(): void;
}

export function mountReelWindow(container: HTMLElement): ReelWindowHandle {
  const root: Root = createRoot(container);
  const hostRef = createRef<HTMLDivElement>();
  flushSync(() => root.render(<ReelWindow hostRef={hostRef} />));
  if (!hostRef.current) throw new Error('reel window did not mount its garden host');
  return { gardenHost: hostRef.current, destroy: () => root.unmount() };
}
