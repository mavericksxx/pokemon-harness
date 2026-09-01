import { useState } from 'react';
import { startPlainTerminal } from '@/sessions';
import { useStore } from '@/store/store';
import { useAppSettingsStore } from '@/store/appSettingsStore';
import { useWorkspaceStore } from '@/store/workspaceStore';
import { TerminalIcon } from '@/components/icons';

interface Props {
  className: string;
}

/** Shared quick action for creating a shell-only session from any roster. */
export function NewTerminalButton({ className }: Props): JSX.Element {
  const pushToast = useStore((s) => s.pushToast);
  const recentFolders = useAppSettingsStore((s) => s.settings.recentFolders);
  const activeWorkspaceFolder = useWorkspaceStore(
    (s) => s.workspaces.find((workspace) => workspace.id === s.activeWorkspaceId)?.primaryFolder
  );
  const [starting, setStarting] = useState(false);

  const onClick = async (): Promise<void> => {
    if (starting) return;
    const cwd = activeWorkspaceFolder?.trim() || recentFolders[0]?.trim() || '~';
    setStarting(true);
    try {
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
      <TerminalIcon />
    </button>
  );
}
