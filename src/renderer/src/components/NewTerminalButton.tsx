import { useState } from 'react';
import { startPlainTerminal } from '@/sessions';
import { useStore } from '@/store/store';
import { useAppSettingsStore } from '@/store/appSettingsStore';
import { useWorkspaceStore } from '@/store/workspaceStore';
import { PlusIcon } from '@/components/icons';

interface Props {
  className: string;
}

/** Shared quick action for creating a shell-only session — lives at the end of the drawer tab strip and in the focus sidebar's action row. */
export function NewTerminalButton({ className }: Props): JSX.Element {
  const pushToast = useStore((s) => s.pushToast);
  const recentFolders = useAppSettingsStore((s) => s.settings.recentFolders);
  const activeWorkspaceFolder = useWorkspaceStore(
    (s) => s.workspaces.find((workspace) => workspace.id === s.activeWorkspaceId)?.primaryFolder
  );
  const [starting, setStarting] = useState(false);

  const onClick = async (): Promise<void> => {
    if (starting) return;
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
      onClick={() => void onClick()}
      disabled={starting}
    >
      <PlusIcon />
    </button>
  );
}
