import { useState } from 'react';
import { startPlainTerminal } from '@/sessions';
import { useStore } from '@/store/store';
import { useAppSettingsStore } from '@/store/appSettingsStore';
import { useWorkspaceStore } from '@/store/workspaceStore';
import { PlusIcon } from '@/components/icons';

interface Props {
  className: string;
  /** Visible text alongside the icon — omitted by the drawer tab strip
   *  (icon-only, tooltip carries the label there), set by the focus
   *  sidebar's add-agent menu where it appears as a labeled menu item. */
  label?: string;
  /** Fired synchronously at the start of the click, before the async
   *  terminal-cwd resolution — lets a host menu (focus sidebar) close
   *  itself immediately rather than waiting on that round-trip. */
  onSelect?(): void;
  /** ARIA role override — the focus sidebar's add-agent menu sets
   *  "menuitem" to match its sibling button; the drawer tab strip omits it
   *  (plain icon button, not part of a `role="menu"` list). */
  role?: string;
}

/** Shared quick action for creating a shell-only session — lives at the end of the drawer tab strip and as a menu item in the focus sidebar's add-agent menu. */
export function NewTerminalButton({ className, label, onSelect, role }: Props): JSX.Element {
  const pushToast = useStore((s) => s.pushToast);
  const recentFolders = useAppSettingsStore((s) => s.settings.recentFolders);
  const activeWorkspaceFolder = useWorkspaceStore(
    (s) => s.workspaces.find((workspace) => workspace.id === s.activeWorkspaceId)?.primaryFolder
  );
  const [starting, setStarting] = useState(false);

  const onClick = async (): Promise<void> => {
    if (starting) return;
    onSelect?.();
    setStarting(true);
    try {
      // A stale garden folder makes main reject the pty, then removeSession's fallback
      // selection makes the failed click appear to jump to an unrelated tab.
      const cwd = await window.api.resolveTerminalCwd(
        [activeWorkspaceFolder, ...recentFolders].filter((folder): folder is string => !!folder?.trim())
      );
      await startPlainTerminal(cwd);
    } catch (err) {
      pushToast(`couldn't open terminal: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setStarting(false);
    }
  };

  return (
    <button
      type="button"
      className={`${className} tip`}
      data-tip="new terminal"
      aria-label="new terminal"
      title="new terminal"
      role={role}
      onClick={() => void onClick()}
      disabled={starting}
    >
      <PlusIcon />
      {label}
    </button>
  );
}
