import type { Workspace } from "@kalcode/protocol";
import { Badge, Button, EmptyState, IconButton, Section, Tooltip } from "@kalcode/ui/components";
import { Bot, FolderOpen, LayoutGrid, SquareTerminal, X } from "lucide-react";
import { formatAbsolute, formatRelative } from "../../runtime/describeEvent.ts";
import { useWorkspaces } from "../../runtime/WorkspaceProvider.tsx";
import { Page } from "../../shell/Page.tsx";
import styles from "./Code.module.css";

/** No active workspace: open a folder, or pick up a recent one. */
export function CodeEmpty() {
  const { workspaces, openFolder, picking } = useWorkspaces();
  const hasRecent = workspaces.length > 0;
  return (
    <Page
      title="Code"
      description="Open a project, launch coding agents, and keep every terminal in one focused workspace."
      width="narrow"
    >
      <div className={styles.codeLanding}>
        <EmptyState
          className={styles.codeWelcome}
          headingLevel={2}
          artStyle="free"
          art={
            <span className={styles.launchArt}>
              <FolderOpen className={styles.emptyArt} />
            </span>
          }
          title="Open a project folder"
          actions={
            <Button variant="primary" icon={<FolderOpen />} onClick={() => void openFolder()} busy={picking}>
              Open folder…
            </Button>
          }
        >
          <p className={styles.launchEyebrow}>Code the future</p>
          <p>KalCode opens real terminals in the folder you choose. Your project files stay exactly where they are.</p>
          <ul className={styles.entryFeatures} aria-label="Code workspace features">
            <li>
              <SquareTerminal aria-hidden="true" />
              <span>
                <strong>Real terminals</strong>
                <small>Use the shells already installed on this computer.</small>
              </span>
            </li>
            <li>
              <Bot aria-hidden="true" />
              <span>
                <strong>Coding agents</strong>
                <small>Launch provider sessions in their own terminal panes.</small>
              </span>
            </li>
            <li>
              <LayoutGrid aria-hidden="true" />
              <span>
                <strong>Your layout</strong>
                <small>Arrange terminals and tools around the work at hand.</small>
              </span>
            </li>
          </ul>
        </EmptyState>
        {hasRecent ? (
          <Section id="recent-workspaces" title="Recent workspaces">
            <ul className={styles.recentList}>
              {workspaces.map((workspace) => (
                <RecentWorkspace key={workspace.id} workspace={workspace} />
              ))}
            </ul>
          </Section>
        ) : null}
      </div>
    </Page>
  );
}

function RecentWorkspace({ workspace }: { workspace: Workspace }) {
  const { activate, remove } = useWorkspaces();
  return (
    <li className={styles.recentRow} data-available={workspace.available}>
      <span className={styles.recentGlyph} aria-hidden="true">
        <FolderOpen />
      </span>
      <div className={styles.recentText}>
        <span className={styles.recentName}>{workspace.name}</span>
        <span className={styles.recentPath} title={workspace.rootPath}>
          {workspace.displayPath}
        </span>
      </div>
      {workspace.available ? (
        <time
          className={styles.recentTime}
          dateTime={workspace.lastOpenedAt}
          title={formatAbsolute(workspace.lastOpenedAt)}
        >
          Opened {formatRelative(workspace.lastOpenedAt)}
        </time>
      ) : (
        <Badge tone="waiting">Folder not found</Badge>
      )}
      <div className={styles.recentActions}>
        {workspace.available ? (
          <Button size="sm" onClick={() => void activate(workspace.id)} aria-label={`Open ${workspace.name}`}>
            Open
          </Button>
        ) : null}
        <Tooltip content="Remove from KalCode. The folder isn't touched.">
          <IconButton
            size="sm"
            label={`Remove ${workspace.name} from KalCode`}
            icon={<X />}
            onClick={() => void remove(workspace)}
          />
        </Tooltip>
      </div>
    </li>
  );
}
