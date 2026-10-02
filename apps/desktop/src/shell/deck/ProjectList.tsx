/**
 * The Command Deck's projects list in the left rail: every workspace, the active one marked, each
 * with live counts of its agents (working, needing you). Choosing one makes it active and opens
 * Code. When the build has the workspace rail, that rail is the projects list instead.
 */
import type { ThreadSummary } from "@kalcode/protocol";
import { IconButton, Tooltip } from "@kalcode/ui/components";
import { FolderOpen } from "lucide-react";
import { useMemo } from "react";
import { useWorkspaces } from "../../runtime/WorkspaceProvider.tsx";
import { useThreadSummaries } from "../../surfaces/dashboard/data/DashboardData.tsx";
import { STATUS_META } from "../../surfaces/dashboard/data/status.ts";
import { useNavigation } from "../navigation.tsx";
import styles from "./ProjectList.module.css";

interface Counts {
  working: number;
  needsYou: number;
}

function countsByWorkspace(threads: readonly ThreadSummary[]): Map<string, Counts> {
  const map = new Map<string, Counts>();
  for (const thread of threads) {
    if (thread.archivedAt !== null) continue;
    const group = STATUS_META[thread.status].group;
    if (group !== "working" && group !== "attention") continue;
    const counts = map.get(thread.workspaceId) ?? { working: 0, needsYou: 0 };
    if (group === "working") counts.working += 1;
    else counts.needsYou += 1;
    map.set(thread.workspaceId, counts);
  }
  return map;
}

export function ProjectList({ collapsed }: { collapsed: boolean }) {
  const { workspaces, active, activate, openFolder, state: loadState } = useWorkspaces();
  const { state } = useThreadSummaries();
  const { navigate } = useNavigation();
  const counts = useMemo(() => (state.status === "ready" ? countsByWorkspace(state.data) : new Map()), [state]);
  const ordered = useMemo(
    () => [...workspaces].sort((a, b) => Date.parse(b.lastOpenedAt) - Date.parse(a.lastOpenedAt)),
    [workspaces],
  );
  const choose = (id: string) =>
    void activate(id).then((ok) => {
      if (ok) navigate("code");
    });
  const open = () =>
    void openFolder().then((workspace) => {
      if (workspace) navigate("code");
    });

  return (
    <section
      className={styles.projects}
      aria-labelledby={collapsed ? undefined : "deck-projects"}
      aria-label={collapsed ? "Projects" : undefined}
    >
      {collapsed ? (
        <hr className={styles.divider} />
      ) : (
        <div className={styles.header}>
          <h2 className={styles.heading} id="deck-projects">
            Projects
          </h2>
          <Tooltip content="Open a project folder">
            <IconButton size="sm" label="Open a project folder" icon={<FolderOpen />} onClick={open} />
          </Tooltip>
        </div>
      )}
      {ordered.length === 0 && loadState !== "loading" ? (
        collapsed ? (
          <Tooltip content="Open a project folder" side="right">
            <button type="button" className={styles.tile} onClick={open} aria-label="Open a project folder">
              <FolderOpen aria-hidden="true" />
            </button>
          </Tooltip>
        ) : (
          <button type="button" className={styles.emptyRow} onClick={open}>
            <FolderOpen aria-hidden="true" />
            Open a project folder
          </button>
        )
      ) : (
        <ul className={styles.list}>
          {ordered.map((workspace) => {
            const c: Counts = counts.get(workspace.id) ?? { working: 0, needsYou: 0 };
            const isActive = workspace.id === active?.id;
            const status = [
              c.working > 0 ? `${c.working} working` : null,
              c.needsYou > 0 ? `${c.needsYou} ${c.needsYou === 1 ? "needs" : "need"} you` : null,
              workspace.available ? null : "folder not found",
            ]
              .filter(Boolean)
              .join(", ");
            const label = status ? `${workspace.name}, ${status}` : workspace.name;
            const button = (
              <button
                type="button"
                className={collapsed ? styles.tile : styles.row}
                aria-current={isActive ? "true" : undefined}
                aria-label={collapsed || status ? label : undefined}
                data-unavailable={workspace.available ? undefined : true}
                onClick={() => choose(workspace.id)}
              >
                <span className={styles.initial} aria-hidden="true">
                  {workspace.name.trim().charAt(0).toUpperCase() || "·"}
                </span>
                {collapsed ? (
                  c.needsYou > 0 || c.working > 0 ? (
                    <span
                      className={styles.tileDot}
                      data-tone={c.needsYou > 0 ? "waiting" : "working"}
                      aria-hidden="true"
                    />
                  ) : null
                ) : (
                  <>
                    <span className={styles.name}>{workspace.name}</span>
                    <span className={styles.signals} aria-hidden="true">
                      {c.working > 0 ? (
                        <span className={styles.working}>
                          <span className={styles.workingDot} />
                          {c.working}
                        </span>
                      ) : null}
                      {c.needsYou > 0 ? <span className={styles.needs}>{c.needsYou}</span> : null}
                    </span>
                  </>
                )}
              </button>
            );
            return (
              <li key={workspace.id}>
                {collapsed ? (
                  <Tooltip content={label} side="right">
                    {button}
                  </Tooltip>
                ) : (
                  <Tooltip content={workspace.available ? workspace.displayPath : "Folder not found"} side="right">
                    {button}
                  </Tooltip>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
