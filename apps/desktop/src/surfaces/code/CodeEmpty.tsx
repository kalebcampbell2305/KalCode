import type { Workspace } from "@kalcode/protocol";
import { Badge, Button, EmptyState, IconButton, Section, Tooltip } from "@kalcode/ui/components";
import { FolderOpen, X } from "lucide-react";
import { formatAbsolute, formatRelative } from "../../runtime/describeEvent.ts";
import { useWorkspaces } from "../../runtime/WorkspaceProvider.tsx";
import { Page } from "../../shell/Page.tsx";
import styles from "./Code.module.css";

/** No active workspace: open a folder, or pick up a recent one. */
export function CodeEmpty() {
  const { workspaces, openFolder, picking } = useWorkspaces();
  return (
    <Page title="Code" description="Open a project folder to work in it with real terminals." width="narrow">
      <EmptyState
        headingLevel={2}
        art={<FolderOpen className={styles.emptyArt} />}
        title="Open a project folder"
        actions={
          <Button variant="primary" icon={<FolderOpen />} onClick={() => void openFolder()} busy={picking}>
            Open folder…
          </Button>
        }
      >
        <p>
          KalCode starts terminals in the folder you choose, with the shells already installed on this computer. Opening
          or removing a workspace never changes your files.
        </p>
      </EmptyState>
      {workspaces.length > 0 ? (
        <Section id="recent-workspaces" title="Recent workspaces">
          <ul className={styles.recentList}>
            {workspaces.map((workspace) => (
              <RecentWorkspace key={workspace.id} workspace={workspace} />
            ))}
          </ul>
        </Section>
      ) : null}
    </Page>
  );
}

function RecentWorkspace({ workspace }: { workspace: Workspace }) {
  const { activate, remove } = useWorkspaces();
  return (
    <li className={styles.recentRow} data-available={workspace.available}>
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
