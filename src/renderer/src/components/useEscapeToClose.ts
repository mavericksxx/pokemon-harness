import { useEffect } from 'react';

/** Escape-to-close for the `.modal-backdrop` dialogs that didn't already
 *  have it (NewSessionDialog, QuitDialog, NewWorkspaceDialog,
 *  DeleteWorkspaceDialog, ResetArceusDialog, SummonArceusDialog,
 *  SessionsOverview) — every popover (SettingsPanel, WorkspaceSwitcher,
 *  NotificationBell, QuickSettings, AudioPopover) already binds its own
 *  copy of this exact `window`-level keydown listener; this just factors
 *  it out for the modals that were missing it. */
export function useEscapeToClose(onClose: () => void, enabled = true): void {
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [enabled, onClose]);
}
