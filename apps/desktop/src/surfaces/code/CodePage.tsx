import type { TerminalInfo, Workspace } from "@kalcode/protocol";
import {
  Badge,
  Button,
  DropdownMenu,
  DropdownMenuTrigger,
  EmptyState,
  ErrorState,
  Skeleton,
} from "@kalcode/ui/components";
import { ChevronDown, FolderOpen, RotateCcw, X } from "lucide-react";
import { useEffect, useMemo, useRef } from "react";
import { useWorkspaces } from "../../runtime/WorkspaceProvider.tsx";
import { cycleTerminal, defaultShell, describeTerminalStatus, tabLabels } from "../../runtime/workspaceState.ts";
import { useResolvedTheme } from "../../shell/useResolvedTheme.ts";
import styles from "./Code.module.css";
import { CodeEmpty } from "./CodeEmpty.tsx";
import { codeShortcut } from "./shortcuts.ts";
import { panelId, TerminalTabs, tabId } from "./TerminalTabs.tsx";
import { TerminalView } from "./TerminalView.tsx";
import { WorkspaceMenuContent } from "./WorkspaceMenu.tsx";

/** The Code surface: the active workspace and its terminals. */
export function CodePage() {
  const { state, error, active, retry, refresh } = useWorkspaces();
  // Folder availability can change outside KalCode; re-read it whenever Code is shown.
  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (state === "loading") {
    return (
      <div className={styles.loading} role="status" aria-busy="true">
        <span className="visually-hidden">Loading workspaces</span>
        <Skeleton width="14rem" height="1.5rem" />
        <Skeleton width="20rem" />
      </div>
    );
  }
  if (state === "error") {
    return (
      <div className={styles.loading}>
        <h1 className="visually-hidden">Code</h1>
        <ErrorState
          title="Workspaces couldn't load"
          code={error ? `${error.category}/${error.code}` : undefined}
          actions={<Button onClick={retry}>Try again</Button>}
        >
          <p>{error?.message ?? "KalCode couldn't read its workspaces."} Your folders are unchanged.</p>
        </ErrorState>
      </div>
    );
  }
  return active ? <WorkspaceView key={active.id} workspace={active} /> : <CodeEmpty />;
}

function WorkspaceView({ workspace }: { workspace: Workspace }) {
  const {
    terminals,
    shells,
    activeTerminalId,
    createTerminal,
    closeTerminal,
    restartTerminal,
    selectTerminal,
    focusRequest,
    openFolder,
    picking,
    remove,
  } = useWorkspaces();
  const theme = useResolvedTheme();
  const labels = useMemo(() => tabLabels(terminals), [terminals]);
  const select = selectTerminal;
  const create = createTerminal;
  const restart = restartTerminal;

  // Keyboard shortcuts work anywhere on this surface, including inside a terminal.
  const latest = useRef({ terminals, activeTerminalId, create, select, closeTerminal });
  latest.current = { terminals, activeTerminalId, create, select, closeTerminal };
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const shortcut = codeShortcut(event);
      if (!shortcut || shortcut === "new-terminal") return; // new terminal is global (Shell)
      const { terminals: tabs, activeTerminalId: current, select: choose, closeTerminal: close } = latest.current;
      event.preventDefault();
      if (shortcut === "next-tab" || shortcut === "previous-tab") {
        const next = cycleTerminal(tabs, current, shortcut === "next-tab" ? 1 : -1);
        if (next) choose(next, true);
      } else if (shortcut === "close-tab") {
        if (current) void close(current);
      } else if (shortcut === "leave-terminal") {
        const target = current ? document.getElementById(tabId(current)) : null;
        (target ?? document.getElementById("code-actions"))?.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const shell = defaultShell(shells);
  const activeTerminal = terminals.find((t) => t.id === activeTerminalId) ?? null;

  return (
    <div className={styles.code}>
      <header className={styles.header}>
        <div className={styles.heading}>
          <div className={styles.titleRow}>
            <h1 className={styles.title}>{workspace.name}</h1>
            {workspace.available ? null : <Badge tone="waiting">Folder not found</Badge>}
          </div>
          <p className={styles.path} title={workspace.rootPath} data-selectable>
            {workspace.displayPath}
          </p>
        </div>
        <div className={styles.headerActions} id="code-actions" tabIndex={-1}>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm">
                Switch workspace
                <ChevronDown aria-hidden="true" />
              </Button>
            </DropdownMenuTrigger>
            <WorkspaceMenuContent align="end" />
          </DropdownMenu>
          <Button size="sm" icon={<FolderOpen />} onClick={() => void openFolder()} busy={picking}>
            Open folder…
          </Button>
        </div>
      </header>

      <TerminalTabs
        terminals={terminals}
        labels={labels}
        activeId={activeTerminalId}
        shells={shells}
        disabled={!workspace.available}
        onSelect={select}
        onClose={(id) => void closeTerminal(id)}
        onNew={(shellId) => void create(shellId)}
      />

      <div className={styles.panels}>
        {!workspace.available ? (
          <div className={styles.panelMessage}>
            <ErrorState
              title="This folder can't be found"
              actions={
                <>
                  <Button onClick={() => void openFolder()} busy={picking}>
                    Open another folder…
                  </Button>
                  <Button variant="ghost" onClick={() => void remove(workspace)}>
                    Remove from KalCode
                  </Button>
                </>
              }
            >
              <p>
                {workspace.displayPath} was moved or deleted outside KalCode. Terminals can't start until it's back.
                Removing the workspace only forgets it here.
              </p>
            </ErrorState>
          </div>
        ) : terminals.length === 0 ? (
          <div className={styles.panelMessage}>
            <EmptyState
              headingLevel={2}
              title="No terminals open"
              actions={
                <Button variant="primary" onClick={() => void create(null)} disabled={!shell}>
                  {shell ? `New ${shell.name} terminal` : "No shells found"}
                </Button>
              }
            >
              <p>
                Terminals start in {workspace.displayPath}. Pick another shell from the arrow next to the plus button.
              </p>
            </EmptyState>
          </div>
        ) : null}

        {workspace.available
          ? terminals.map((terminal) => (
              <TerminalPanel
                key={`${terminal.id}:${terminal.startedAt ?? ""}`}
                terminal={terminal}
                label={labels.get(terminal.id) ?? terminal.title}
                visible={terminal.id === activeTerminal?.id}
                focusRequest={focusRequest.terminalId === terminal.id ? focusRequest.n : 0}
                theme={theme}
                workspace={workspace}
                onRestart={() => void restart(terminal.id)}
                onClose={() => void closeTerminal(terminal.id)}
              />
            ))
          : null}
      </div>
    </div>
  );
}

interface TerminalPanelProps {
  terminal: TerminalInfo;
  label: string;
  visible: boolean;
  focusRequest: number;
  theme: "light" | "dark";
  workspace: Workspace;
  onRestart: () => void;
  onClose: () => void;
}

function TerminalPanel({ terminal, label, visible, focusRequest, theme, workspace, onRestart, onClose }: TerminalPanelProps) {
  const endedBeforeLaunch = terminal.status === "ended_by_app";
  return (
    <section
      id={panelId(terminal.id)}
      role="tabpanel"
      aria-labelledby={tabId(terminal.id)}
      className={styles.panel}
      hidden={!visible}
      data-status={terminal.status}
    >
      {endedBeforeLaunch ? (
        <div className={styles.panelMessage}>
          <EmptyState
            headingLevel={2}
            title="This terminal ended when KalCode closed"
            actions={
              <>
                <Button variant="primary" icon={<RotateCcw />} onClick={onRestart}>
                  Restart
                </Button>
                <Button variant="ghost" icon={<X />} onClick={onClose}>
                  Close tab
                </Button>
              </>
            }
          >
            <p>
              Shells can't keep running after KalCode exits. Restart starts a fresh {terminal.title} in{" "}
              {workspace.displayPath}.
            </p>
          </EmptyState>
        </div>
      ) : (
        <TerminalView terminal={terminal} label={label} visible={visible} focusRequest={focusRequest} theme={theme} />
      )}
      {terminal.status === "exited" ? (
        <div className={styles.endedBar} role="status">
          <span className={styles.endedText}>
            {describeTerminalStatus(terminal)}
            {terminal.exitCode === 0 ? "." : ""}
          </span>
          <Button size="sm" variant="primary" icon={<RotateCcw />} onClick={onRestart}>
            Restart
          </Button>
          <Button size="sm" variant="ghost" onClick={onClose}>
            Close tab
          </Button>
        </div>
      ) : null}
    </section>
  );
}
