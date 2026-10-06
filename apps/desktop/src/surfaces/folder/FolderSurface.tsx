import type { Branch, Commit, FileRef, ThreadSummary, WorkspaceRailEntry } from "@kalcode/protocol";
import { displayStatusOf } from "@kalcode/protocol";
import {
  Button,
  EmptyState,
  IconButton,
  Panel,
  ProviderMark,
  Skeleton,
  Stat,
  StatGroup,
  StatusChip,
  Tooltip,
} from "@kalcode/ui/components";
import {
  Activity,
  Bot,
  Code2,
  Files,
  Flag,
  FolderGit2,
  FolderOpen,
  GitBranch,
  GitCommitHorizontal,
  History,
  MessageSquarePlus,
  MessagesSquare,
  PanelRight,
  Pin,
  PinOff,
  ScanSearch,
  ShieldAlert,
  SquareTerminal,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { GitStatusResponse } from "../../ipc/client.ts";
import { toKalCodeError } from "../../ipc/errors.ts";
import { useEvents, useRuntime } from "../../runtime/RuntimeProvider.tsx";
import { useUiIntents } from "../../runtime/uiIntents.tsx";
import { useWorkspaces } from "../../runtime/WorkspaceProvider.tsx";
import { ContentContextMenu } from "../../shell/context/ContentContextMenu.tsx";
import { FilePreview } from "../../shell/context/FilePreview.tsx";
import { useNavigation } from "../../shell/navigation.tsx";
import { useOpenInPane } from "../../shell/panes/useOpenInPane.ts";
import { allEntries, relativeTime } from "../../shell/rail/model.ts";
import { useOptionalRail } from "../../shell/rail/RailProvider.tsx";
import { ScopedHeading, useSurfaceScope } from "../../shell/rail/surfaceScope.tsx";
import { useThreadsIntent } from "../threads/intent.tsx";
import { FileTree } from "./FileTree.tsx";
import styles from "./Folder.module.css";
import { changeOf, type RecentFile, recentFilesFrom, splitPath } from "./folderModel.ts";

function fail(cause: unknown) {
  const e = toKalCodeError(cause);
  return { state: "error" as const, message: e.message, code: e.code };
}

type Loaded<T> =
  | { state: "loading" }
  | { state: "ready"; value: T }
  | { state: "error"; message: string; code: string };

const REVEAL_LABEL =
  typeof navigator !== "undefined" && /Mac/.test(navigator.platform) ? "Reveal in Finder" : "Show in File Explorer";

/**
 * The folder/project surface (Z7-W2): the active workspace as the whole context — files (Z6a
 * handles), Git status, recent files, threads, terminals, branches — with honest states for
 * what arrives later (worktrees, agents, missions). Also shown in a pane (`kalcode.project`),
 * and its Git status is the pane system's Git content (`{ kind: "git" }`, read-only).
 */
export function FolderSurface() {
  const { active, openFolder } = useWorkspaces();
  const rail = useOptionalRail();
  const scope = useSurfaceScope();
  if (!active) {
    return (
      <div className={styles.page} data-in-pane={scope.inPane || undefined}>
        <EmptyState
          headingLevel={scope.level(1)}
          art={<FolderGit2 />}
          title="No workspace is open"
          align="center"
          actions={
            <Button
              variant="primary"
              icon={<FolderOpen />}
              onClick={async () => {
                const opened = await openFolder();
                if (opened && rail) await rail.openWorkspace(opened.id);
              }}
            >
              Open folder
            </Button>
          }
        >
          Open a project folder to see its files, Git status, threads and terminals here.
        </EmptyState>
      </div>
    );
  }
  return <Project key={active.id} workspaceId={active.id} />;
}

function Project({ workspaceId }: { workspaceId: string }) {
  const { client } = useRuntime();
  const { events } = useEvents();
  const workspaces = useWorkspaces();
  const rail = useOptionalRail();
  const { navigate } = useNavigation();
  const threadsIntent = useThreadsIntent();
  const workspace = workspaces.workspaces.find((w) => w.id === workspaceId) ?? workspaces.active;
  const entry: WorkspaceRailEntry | undefined = rail?.rail
    ? allEntries(rail.rail).find((e) => e.workspaceId === workspaceId)
    : undefined;

  const scope = useSurfaceScope();
  const [threads, setThreads] = useState<Loaded<ThreadSummary[]>>({ state: "loading" });
  const { git, commits, branches, loadGit } = useGit(workspaceId);
  const [files, setFiles] = useState<RecentFile[] | null>(null);

  const loadThreads = useCallback(() => {
    client
      .listThreads({ workspaceId })
      .then((value) => setThreads({ state: "ready", value }))
      .catch((cause) => setThreads(fail(cause)));
  }, [client, workspaceId]);
  const loadFiles = useCallback(() => {
    client
      .queryEvents({ types: ["file.*"], correlation: { workspaceId }, limit: 200 })
      .then((page) => setFiles(recentFilesFrom(page.events)))
      .catch(() => setFiles([]));
  }, [client, workspaceId]);

  useEffect(() => {
    loadThreads();
    loadGit();
    loadFiles();
  }, [loadThreads, loadGit, loadFiles]);

  // Live: threads and files change with events for this workspace.
  const newest = events[0]?.seq ?? 0;
  const seen = useRef(newest);
  useEffect(() => {
    const fresh = events.filter((e) => e.seq > seen.current);
    seen.current = Math.max(seen.current, newest);
    const mine = fresh.filter((e) => e.correlation.workspaceId === workspaceId || e.type.startsWith("thread."));
    if (mine.length === 0) return;
    const timer = setTimeout(() => {
      loadThreads();
      if (mine.some((e) => e.type.startsWith("file."))) {
        loadFiles();
        loadGit();
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [events, newest, workspaceId, loadThreads, loadFiles, loadGit]);

  if (!workspace) return null;
  const name = entry?.name ?? workspace.name;
  const open = threads.state === "ready" ? threads.value.filter((t) => t.archivedAt === null) : [];
  const working = open.filter((t) => displayStatusOf(t.status).chip === "working").length;
  const needs = open.filter((t) => displayStatusOf(t.status).chip === "waiting_for_you").length;
  const running = workspaces.terminals.filter((t) => t.status === "running").length;
  const branch = git.state === "ready" ? git.value.branch : null;
  const changed =
    git.state === "ready" && git.value.summary ? git.value.summary.changed + git.value.summary.untracked : null;

  return (
    <div className={styles.page} data-in-pane={scope.inPane || undefined}>
      <header className={styles.header}>
        <div className={styles.titleBlock}>
          <p className={styles.eyebrow}>
            <FolderGit2 aria-hidden="true" />
            Project
          </p>
          <ScopedHeading level={1} className={styles.title}>
            {name}
          </ScopedHeading>
          <p className={styles.path}>
            <span className={styles.mono}>{workspace.displayPath}</span>
            {branch?.branch ? (
              <span className={styles.branch}>
                <GitBranch aria-hidden="true" />
                {branch.branch}
                {branch.ahead ? <span className={styles.ahead}>↑{branch.ahead}</span> : null}
                {branch.behind ? <span className={styles.behind}>↓{branch.behind}</span> : null}
              </span>
            ) : null}
            {workspace.available ? null : <span className={styles.missing}>Folder missing</span>}
          </p>
        </div>
        <div className={styles.actions}>
          <Button
            variant="primary"
            icon={<MessageSquarePlus />}
            disabled={!workspace.available}
            onClick={() => {
              navigate("threads");
              threadsIntent.request("new");
            }}
          >
            New thread
          </Button>
          {scope.inPane ? null : (
            <Button variant="secondary" icon={<Code2 />} onClick={() => navigate("code")}>
              Open in Code
            </Button>
          )}
          {rail && entry ? (
            <Button
              variant="ghost"
              icon={entry.pinned ? <PinOff /> : <Pin />}
              onClick={() => void rail.update({ workspaceId, pinned: !entry.pinned })}
            >
              {entry.pinned ? "Unpin" : "Pin"}
            </Button>
          ) : null}
          {rail ? (
            <Button
              variant="ghost"
              icon={<FolderOpen />}
              disabled={!workspace.available}
              onClick={() => void rail.reveal(workspaceId)}
            >
              {REVEAL_LABEL}
            </Button>
          ) : null}
        </div>
      </header>

      <StatGroup className={styles.stats}>
        <Stat
          label="Threads"
          value={threads.state === "ready" ? open.length : "–"}
          icon={<MessagesSquare />}
          quiet={open.length === 0}
        />
        <Stat
          label="Working"
          value={working}
          icon={<Activity />}
          tone={working > 0 ? "working" : undefined}
          quiet={working === 0}
        />
        <Stat
          label="Needs you"
          value={needs}
          icon={<ShieldAlert />}
          tone={needs > 0 ? "waiting" : undefined}
          quiet={needs === 0}
        />
        <Stat label="Terminals" value={running} icon={<SquareTerminal />} quiet={running === 0} />
        <Stat
          label="Changed files"
          value={changed ?? "–"}
          icon={<Files />}
          hint={git.state === "ready" && !git.value.repository ? "Not a Git repository" : undefined}
        />
      </StatGroup>

      <div className={styles.grid}>
        <Panel
          id={scope.id("project-files")}
          title="Files"
          headingLevel={scope.level(2)}
          icon={<Files />}
          padding="none"
          className={styles.files}
        >
          {workspace.available ? (
            <FileTree workspaceId={workspaceId} />
          ) : (
            <p className={styles.note}>
              The folder was moved or deleted outside KalCode, so its files can't be listed.
            </p>
          )}
        </Panel>

        <div className={`${styles.column} ${styles.gitColumn}`}>
          <GitPanel git={git} workspaceId={workspaceId} />
          <RecentFilesPanel files={files} commits={commits} workspaceId={workspaceId} />
        </div>

        <div className={`${styles.column} ${styles.contextColumn}`}>
          <ThreadsPanel threads={threads} />
          <TerminalsPanel />
          <BranchesPanel branches={branches} />
          <Panel
            id={scope.id("project-later")}
            title="Also in this workspace"
            headingLevel={scope.level(2)}
            icon={<Bot />}
            padding="none"
          >
            <ul className={styles.later}>
              <li>
                <Bot aria-hidden="true" />
                <span>
                  <strong>Agents</strong> arrive with Agents.
                </span>
              </li>
              <li>
                <Flag aria-hidden="true" />
                <span>
                  <strong>Missions</strong> arrive with Missions.
                </span>
              </li>
              <li>
                <GitBranch aria-hidden="true" />
                <span>
                  <strong>KalCode worktrees</strong> appear here once worktree commands are in this build.
                </span>
              </li>
            </ul>
          </Panel>
          {rail && entry ? <SearchPrivacyPanel entry={entry} /> : null}
        </div>
      </div>
    </div>
  );
}

/** Read-only Git status, log and branches for a workspace (the project page and the Git pane). */
function useGit(workspaceId: string) {
  const { client } = useRuntime();
  const [git, setGit] = useState<Loaded<GitStatusResponse>>({ state: "loading" });
  const [commits, setCommits] = useState<Loaded<Commit[]>>({ state: "loading" });
  const [branches, setBranches] = useState<Loaded<Branch[]>>({ state: "loading" });
  const loadGit = useCallback(() => {
    client
      .gitStatus(workspaceId)
      .then((value) => setGit({ state: "ready", value }))
      .catch((cause) => setGit(fail(cause)));
    client
      .gitLog(workspaceId, 8)
      .then((page) => setCommits({ state: "ready", value: page.items }))
      .catch((cause) => setCommits(fail(cause)));
    client
      .gitBranches(workspaceId)
      .then((value) => setBranches({ state: "ready", value }))
      .catch((cause) => setBranches(fail(cause)));
  }, [client, workspaceId]);
  return { git, commits, branches, loadGit };
}

/**
 * The pane system's Git content (`{ kind: "git", workspaceId }`): the workspace's status,
 * recent commits and branches, read-only and refreshed when its files change.
 */
export function GitPane({ workspaceId }: { workspaceId: string }) {
  const { events } = useEvents();
  const { workspaces } = useWorkspaces();
  const { git, commits, branches, loadGit } = useGit(workspaceId);
  useEffect(() => loadGit(), [loadGit]);
  const newest = events[0]?.seq ?? 0;
  const seen = useRef(newest);
  useEffect(() => {
    const fresh = events.filter((e) => e.seq > seen.current);
    seen.current = Math.max(seen.current, newest);
    if (!fresh.some((e) => e.correlation.workspaceId === workspaceId && e.type.startsWith("file."))) return;
    const timer = setTimeout(loadGit, 300);
    return () => clearTimeout(timer);
  }, [events, newest, workspaceId, loadGit]);
  const workspace = workspaces.find((w) => w.id === workspaceId);
  if (!workspace) {
    return (
      <div className={styles.page} data-in-pane>
        <p className={styles.note}>This workspace is no longer in KalCode. Close the tab to tidy up.</p>
      </div>
    );
  }
  const branch = git.state === "ready" ? git.value.branch : null;
  return (
    <div className={styles.page} data-in-pane>
      <p className={styles.path}>
        <span className={styles.mono}>{workspace.displayPath}</span>
        {branch?.branch ? (
          <span className={styles.branch}>
            <GitBranch aria-hidden="true" />
            {branch.branch}
            {branch.ahead ? <span className={styles.ahead}>↑{branch.ahead}</span> : null}
            {branch.behind ? <span className={styles.behind}>↓{branch.behind}</span> : null}
          </span>
        ) : null}
      </p>
      <div className={styles.gitPaneGrid}>
        <GitPanel git={git} workspaceId={workspaceId} inGitPane />
        <div className={styles.column}>
          <CommitsPanel commits={commits} />
          <BranchesPanel branches={branches} />
        </div>
      </div>
    </div>
  );
}

function GitPanel({
  git,
  workspaceId,
  inGitPane = false,
}: {
  git: Loaded<GitStatusResponse>;
  workspaceId: string;
  /** Shown as the Git pane itself (no "open in a pane" action). */
  inGitPane?: boolean;
}) {
  const scope = useSurfaceScope();
  const [preview, setPreview] = useState<FileRef | null>(null);
  const fileRows = useRef(new Map<string, HTMLLIElement>());
  const openInPane = useOpenInPane();
  const count = git.state === "ready" ? (git.value.files.totalEstimate ?? git.value.files.items.length) : undefined;
  return (
    <Panel
      id={scope.id("project-git")}
      title="Git status"
      headingLevel={scope.level(2)}
      icon={<GitCommitHorizontal />}
      count={count}
      padding="none"
      actions={
        inGitPane ? undefined : (
          <Tooltip content="Open Git status in a pane">
            <IconButton
              size="sm"
              label="Open Git status in a pane"
              icon={<PanelRight />}
              onClick={() => void openInPane({ kind: "git", workspaceId }, { workspaceId, placement: "split" })}
            />
          </Tooltip>
        )
      }
    >
      {git.state === "loading" ? (
        <div className={styles.loading}>
          <Skeleton width="50%" />
        </div>
      ) : git.state === "error" ? (
        <ContentContextMenu
          workspaceId={workspaceId}
          context={{ kind: "error", label: "Git status error", text: git.message }}
        >
          <p className={styles.note} role="alert">
            {git.message}
          </p>
        </ContentContextMenu>
      ) : !git.value.repository ? (
        <p className={styles.note}>
          This folder isn't a Git repository. Run git init in a terminal to start tracking it.
        </p>
      ) : git.value.files.items.length === 0 ? (
        <p className={styles.clean}>
          <GitCommitHorizontal aria-hidden="true" />
          Working tree clean
        </p>
      ) : (
        <ul className={styles.changes} aria-label="Changed files">
          {git.value.files.items.map((file) => {
            const change = changeOf(file);
            const { dir, name } = splitPath(file.path);
            return (
              <ContentContextMenu
                key={file.path}
                workspaceId={workspaceId}
                context={{
                  kind: "file",
                  label: file.path,
                  path: file.path,
                  text: `${change.words}${change.staged ? ", staged" : ""}`,
                }}
                onOpen={
                  file.file && file.unstaged !== "deleted" && file.staged !== "deleted"
                    ? () => setPreview(file.file)
                    : undefined
                }
              >
                <li
                  className={styles.change}
                  ref={(node) => {
                    if (node) fileRows.current.set(file.path, node);
                    else fileRows.current.delete(file.path);
                  }}
                >
                  <span className={styles.changeLetter} data-tone={change.tone} title={change.words} aria-hidden="true">
                    {change.letter}
                  </span>
                  <span className="visually-hidden">{`${change.words}${change.staged ? ", staged" : ""}: `}</span>
                  <span className={styles.changePath}>
                    <span className={styles.dir}>{dir}</span>
                    {name}
                  </span>
                  {change.staged ? <span className={styles.staged}>staged</span> : null}
                </li>
              </ContentContextMenu>
            );
          })}
          {git.value.truncated ? <li className={styles.note}>More changes than shown.</li> : null}
        </ul>
      )}
      {preview ? (
        <FilePreview
          file={preview}
          returnFocus={fileRows.current.get(preview.displayPath)}
          onClose={() => setPreview(null)}
        />
      ) : null}
    </Panel>
  );
}

function RecentFilesPanel({
  files,
  commits,
  workspaceId,
}: {
  files: RecentFile[] | null;
  commits: Loaded<Commit[]>;
  workspaceId: string;
}) {
  const scope = useSurfaceScope();
  const now = Date.now();
  return (
    <Panel
      id={scope.id("project-recent")}
      title="Recent files"
      headingLevel={scope.level(2)}
      icon={<History />}
      padding="none"
    >
      <p className={styles.subhead}>Changed by threads</p>
      {files === null ? (
        <div className={styles.loading}>
          <Skeleton width="45%" />
        </div>
      ) : files.length === 0 ? (
        <p className={styles.note}>No thread has changed a file here yet.</p>
      ) : (
        <ul className={styles.recentFiles} aria-label="Files changed by threads">
          {files.map((file) => {
            const { dir, name } = splitPath(file.path);
            return (
              <ContentContextMenu
                key={file.path}
                workspaceId={workspaceId}
                context={{ kind: "file", label: file.path, path: file.path, text: `Change: ${file.change}` }}
              >
                <li className={styles.recentFile}>
                  <span className={styles.changePath}>
                    <span className={styles.dir}>{dir}</span>
                    {name}
                  </span>
                  <span className={styles.fileChange} data-change={file.change}>
                    {file.change}
                  </span>
                  <span className={styles.age}>{relativeTime(file.at, now)}</span>
                </li>
              </ContentContextMenu>
            );
          })}
        </ul>
      )}
      <p className={styles.subhead}>Recent commits</p>
      <CommitList commits={commits} />
    </Panel>
  );
}

function CommitsPanel({ commits }: { commits: Loaded<Commit[]> }) {
  const scope = useSurfaceScope();
  return (
    <Panel
      id={scope.id("git-commits")}
      title="Recent commits"
      headingLevel={scope.level(2)}
      icon={<History />}
      padding="none"
    >
      <CommitList commits={commits} />
    </Panel>
  );
}

function CommitList({ commits }: { commits: Loaded<Commit[]> }) {
  const now = Date.now();
  return commits.state === "loading" ? (
    <div className={styles.loading}>
      <Skeleton width="60%" />
    </div>
  ) : commits.state === "error" ? (
    <p className={styles.note}>{commits.code === "not_a_repository" ? "No Git history." : commits.message}</p>
  ) : commits.value.length === 0 ? (
    <p className={styles.note}>No commits yet.</p>
  ) : (
    <ul className={styles.commits} aria-label="Recent commits">
      {commits.value.map((commit) => (
        <li key={commit.oid} className={styles.commit}>
          <span className={styles.oid}>{commit.oid.slice(0, 7)}</span>
          <span className={styles.subject}>{commit.subject}</span>
          <span className={styles.age}>{relativeTime(commit.committedAt, now)}</span>
        </li>
      ))}
    </ul>
  );
}

function ThreadsPanel({ threads }: { threads: Loaded<ThreadSummary[]> }) {
  const intents = useUiIntents();
  const scope = useSurfaceScope();
  const open = threads.state === "ready" ? threads.value.filter((t) => t.archivedAt === null) : [];
  const now = Date.now();
  return (
    <Panel
      id={scope.id("project-threads")}
      title="Threads"
      headingLevel={scope.level(2)}
      icon={<MessagesSquare />}
      count={open.length}
      padding="none"
    >
      {threads.state === "loading" ? (
        <div className={styles.loading}>
          <Skeleton width="55%" />
        </div>
      ) : threads.state === "error" ? (
        <p className={styles.note} role="alert">
          {threads.message}
        </p>
      ) : open.length === 0 ? (
        <p className={styles.note}>No threads in this workspace yet.</p>
      ) : (
        <ul className={styles.threads} aria-label="Threads in this workspace">
          {open.map((t) => {
            const info = displayStatusOf(t.status, { resumable: t.resumable });
            return (
              <li key={t.id}>
                <button
                  type="button"
                  className={styles.threadButton}
                  onClick={() => void intents.focus({ kind: "thread", threadId: t.id, workspaceId: t.workspaceId })}
                >
                  <ProviderMark provider={t.providerId} name={t.providerName} size="xs" hideName />
                  <span className={styles.threadName}>{t.name}</span>
                  <StatusChip status={info.status} qualifier={info.qualifierLabel} variant="inline" size="sm" />
                  <span className={styles.age}>{relativeTime(t.lastActivityAt, now)}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}

function TerminalsPanel() {
  const workspaces = useWorkspaces();
  const openInPane = useOpenInPane();
  const scope = useSurfaceScope();
  const tabs = workspaces.terminals;
  return (
    <Panel
      id={scope.id("project-terminals")}
      title="Terminals"
      headingLevel={scope.level(2)}
      icon={<SquareTerminal />}
      count={tabs.length}
      padding="none"
    >
      {tabs.length === 0 ? (
        <p className={styles.note}>No terminal tabs. Open Code to start one.</p>
      ) : (
        <ul className={styles.threads} aria-label="Terminals in this workspace">
          {tabs.map((tab) => (
            <li key={tab.id}>
              <button
                type="button"
                className={styles.threadButton}
                onClick={() =>
                  void openInPane({ kind: "terminal", terminalId: tab.id }, { workspaceId: tab.workspaceId })
                }
              >
                <SquareTerminal className={styles.terminalIcon} aria-hidden="true" />
                <span className={styles.threadName}>{tab.title}</span>
                <StatusChip
                  tone={tab.status === "running" ? "working" : "muted"}
                  label={
                    tab.status === "running" ? "Running" : tab.exitCode !== null ? `Exited ${tab.exitCode}` : "Ended"
                  }
                  variant="inline"
                  size="sm"
                />
              </button>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

function BranchesPanel({ branches }: { branches: Loaded<Branch[]> }) {
  const scope = useSurfaceScope();
  const local = branches.state === "ready" ? branches.value.filter((b) => b.kind === "local") : [];
  return (
    <Panel
      id={scope.id("project-branches")}
      title="Branches"
      headingLevel={scope.level(2)}
      icon={<GitBranch />}
      count={branches.state === "ready" ? local.length : undefined}
      padding="none"
    >
      {branches.state === "loading" ? (
        <div className={styles.loading}>
          <Skeleton width="40%" />
        </div>
      ) : branches.state === "error" ? (
        <p className={styles.note}>{branches.message}</p>
      ) : local.length === 0 ? (
        <p className={styles.note}>No local branches.</p>
      ) : (
        <ul className={styles.branches} aria-label="Local branches">
          {local.map((b) => (
            <li key={b.name} className={styles.branchRow} data-current={b.current || undefined}>
              <GitBranch aria-hidden="true" />
              <span className={styles.branchName}>{b.name}</span>
              {b.current ? <span className={styles.current}>current</span> : null}
              {b.ahead ? <span className={styles.ahead}>↑{b.ahead}</span> : null}
              {b.behind ? <span className={styles.behind}>↓{b.behind}</span> : null}
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

function SearchPrivacyPanel({ entry }: { entry: WorkspaceRailEntry }) {
  const rail = useOptionalRail();
  const scope = useSurfaceScope();
  const [busy, setBusy] = useState(false);
  return (
    <Panel
      id={scope.id("project-search")}
      title="Search"
      headingLevel={scope.level(2)}
      icon={<ScanSearch />}
      padding="md"
    >
      <label className={styles.toggle}>
        <input
          type="checkbox"
          checked={entry.indexMessages}
          disabled={busy || !rail}
          onChange={async (e) => {
            if (!rail) return;
            setBusy(true);
            await rail.update({ workspaceId: entry.workspaceId, indexMessages: e.target.checked });
            setBusy(false);
          }}
        />
        <span>
          <span className={styles.toggleTitle}>Search message text in this workspace</span>
          <span className={styles.toggleText}>
            Off by default. When on, KalCode's local search also looks inside this workspace's thread messages. The
            index stays on this computer and results never show the message text.
          </span>
        </span>
      </label>
    </Panel>
  );
}
