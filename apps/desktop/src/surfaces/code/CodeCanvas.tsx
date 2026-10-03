import type {
  PaneContent,
  PaneLayout,
  ProviderAccount,
  ShellOption,
  TerminalInfo,
  ThreadSummary,
  Workspace,
} from "@kalcode/protocol";
import {
  Badge,
  Button,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  EmptyState,
  ProviderGlyph,
} from "@kalcode/ui/components";
import {
  GitBranch,
  Globe,
  LayoutDashboard,
  LayoutPanelLeft,
  PowerOff,
  RotateCcw,
  SquareTerminal,
  X,
} from "lucide-react";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { VoiceSceneTarget } from "../../kalvoice/sceneTargets.ts";
import {
  registerVoicePaneScene,
  replayVoiceFocusTrace,
  type VoicePaneSceneRegistration,
  voiceTerminalStatus,
  voiceThreadEffort,
} from "../../kalvoice/useVoiceScene.ts";
import { useRuntime } from "../../runtime/RuntimeProvider.tsx";
import { usePaneFocusRequests } from "../../runtime/uiIntents.tsx";
import { useWorkspaces } from "../../runtime/WorkspaceProvider.tsx";
import { defaultShell, describeTerminalStatus, tabLabels } from "../../runtime/workspaceState.ts";
import { useNavigation, viewVisible } from "../../shell/navigation.tsx";
import { PaneNotice } from "../../shell/panes/builtinContent.tsx";
import type { PaneRenderContext, TabInfo } from "../../shell/panes/contentRegistry.ts";
import { registeredWidgets } from "../../shell/panes/contentRegistry.ts";
import {
  allContents,
  arrangeContents,
  contentKey,
  emptyLayout,
  findContent,
  leaves,
  makeLeaf,
  parseLayout,
  splitPane,
} from "../../shell/panes/model.ts";
import { PaneCanvas, type PaneHost } from "../../shell/panes/PaneCanvas.tsx";
import { paneDomId } from "../../shell/panes/PaneFrame.tsx";
import {
  applyPaneControl,
  type PaneCommand,
  type PaneCommandResult,
  paneQueryCandidates,
  providerPaneAliases,
  selectDistinctProviderThreads,
} from "../../shell/panes/paneCommands.ts";
import { type PaneController, usePaneController } from "../../shell/panes/usePaneController.ts";
import { HOME_WIDGET, PROJECT_WIDGET, WORKSPACES_WIDGET } from "../../shell/rail/paneIds.ts";
import { useResolvedTheme } from "../../shell/useResolvedTheme.ts";
import { useThreadsIntent } from "../threads/intent.tsx";
import { UtilityDockRegistration } from "../utilities/UtilityDockPane.tsx";
import styles from "./Code.module.css";
import { type AgentLaunchSpec, NewAgentDialog } from "./NewAgentDialog.tsx";
import { isPaneProvider, type PaneProviderId } from "./panes/paneChannel.ts";
import { paneStatus, providerIdentity } from "./panes/paneLabels.ts";
import "./paneContents.tsx";
import {
  BrowserPane,
  browserContent,
  createBrowserBridge,
  normalizeBrowserAddress,
  persistableBrowserUrl,
  updateBrowserUrl,
} from "../browser/index.ts";
import { resolveBrowserTarget } from "./browserTarget.ts";
import { stopsOnClose } from "./panes/agentLaunch.ts";
import { paneAccountLabel, resolvePaneAccount } from "./panes/PaneParts.tsx";
import { ProviderPane } from "./panes/ProviderPane.tsx";
import { type ProviderPanes, useProviderPanes } from "./panes/useProviderPanes.ts";
import { TerminalView } from "./TerminalView.tsx";

const terminalContent = (terminalId: string): PaneContent => ({ kind: "terminal", terminalId });
const threadContent = (threadId: string): PaneContent => ({ kind: "thread", threadId });

/** Contract tones: a running shell is working (green), a failed exit is failed (red), else muted. */
function terminalTone(terminal: TerminalInfo): "working" | "muted" | "failed" {
  if (terminal.status === "running") return "working";
  if (terminal.status === "exited" && terminal.exitCode !== 0 && terminal.exitCode !== null) return "failed";
  return "muted";
}

/** First layout of a workspace: its terminals as tabs, its provider panes beside them. */
export function defaultLayoutFor(
  terminals: readonly TerminalInfo[],
  activeTerminalId: string | null,
  paneThreadIds: readonly string[],
): PaneLayout {
  const base = emptyLayout();
  const first = leaves(base.root)[0];
  if (!first) return base;
  const tabs = terminals.map((t) => terminalContent(t.id));
  const active = Math.max(
    0,
    terminals.findIndex((t) => t.id === activeTerminalId),
  );
  let layout: PaneLayout = { ...base, root: makeLeaf(tabs, first.paneId, active) };
  if (paneThreadIds.length > 0) {
    const panes = makeLeaf(paneThreadIds.map(threadContent));
    layout = tabs.length > 0 ? splitPane(layout, first.paneId, "horizontal", panes) : { ...layout, root: panes };
  }
  return layout;
}

export interface CodeCanvasApi {
  controller: PaneController;
  /** Contents that run but aren't shown in any pane. */
  background: { content: PaneContent; title: string }[];
  providerPanes: ProviderPanes;
  shells: readonly ShellOption[];
  newTerminal: (shellId: string | null) => void;
  /** Opens the + launcher for coding agents (Claude Code by default; Codex / Gemini CLI when offered). */
  openAgentLauncher: (providerId?: PaneProviderId) => void;
  titleOf: (content: PaneContent) => string;
}

interface CodeCanvasProps {
  workspace: Workspace;
  /** Renders the header toolbar and status bar around the canvas. */
  children: (api: CodeCanvasApi, canvas: ReactNode) => ReactNode;
}

/**
 * The Code surface's pane canvas (Z7-W1): terminals (Z1) and provider panes (Z7-W4) side by
 * side, arranged freely and saved per workspace. Waits for the provider pane list so the first
 * layout of a workspace can include them.
 */
export function CodeCanvas({ workspace, children }: CodeCanvasProps) {
  const providerPanes = useProviderPanes(workspace);
  if (!providerPanes.loaded) {
    return (
      <div className={styles.canvasLoading} role="status" aria-busy="true">
        <span className="visually-hidden">Loading panes</span>
      </div>
    );
  }
  return (
    <LoadedCanvas workspace={workspace} providerPanes={providerPanes}>
      {children}
    </LoadedCanvas>
  );
}

function LoadedCanvas({ workspace, providerPanes, children }: CodeCanvasProps & { providerPanes: ProviderPanes }) {
  const [browserBridge] = useState(createBrowserBridge);
  const initialBrowserUrls = useRef(new Map<string, string>());
  const { client, info } = useRuntime();
  const { current, navigate } = useNavigation();
  const threadsIntent = useThreadsIntent();
  const theme = useResolvedTheme();
  const [providerAccounts, setProviderAccounts] = useState<ProviderAccount[] | null>(null);
  const [providerAccountsUnavailable, setProviderAccountsUnavailable] = useState(false);
  const {
    terminals,
    shells,
    activeTerminalId,
    focusRequest,
    createTerminal,
    closeTerminal,
    restartTerminal,
    selectTerminal,
  } = useWorkspaces();
  const labels = useMemo(() => tabLabels(terminals), [terminals]);
  const terminalById = useMemo(() => new Map(terminals.map((t) => [t.id, t])), [terminals]);
  const paneById = useMemo(() => new Map(providerPanes.panes.map((p) => [p.thread.id, p])), [providerPanes.panes]);
  useEffect(() => {
    let cancelled = false;
    setProviderAccounts(null);
    setProviderAccountsUnavailable(false);
    void client
      .listProviderAccounts()
      .then((accounts) => {
        if (!cancelled) setProviderAccounts(accounts);
      })
      .catch(() => {
        if (!cancelled) setProviderAccountsUnavailable(true);
      });
    return () => {
      cancelled = true;
    };
  }, [client]);
  const accountFor = useCallback(
    (thread: ThreadSummary) => resolvePaneAccount(thread, providerAccounts, providerAccountsUnavailable),
    [providerAccounts, providerAccountsUnavailable],
  );

  const titleOf = useCallback(
    (content: PaneContent): string => {
      if (content.kind === "terminal") {
        const terminal = terminalById.get(content.terminalId);
        return terminal ? (labels.get(terminal.id) ?? terminal.title) : "Terminal";
      }
      if (content.kind === "thread") {
        const thread = paneById.get(content.threadId)?.thread;
        if (!thread) return "Thread";
        const account = accountFor(thread);
        return account ? `${thread.name} · ${paneAccountLabel(account)}` : thread.name;
      }
      if (content.kind === "dashboard") return "Dashboard";
      if (content.kind === "browser") return "Browser";
      if (content.kind === "git") return "Git";
      return "Widget";
    },
    [terminalById, labels, paneById, accountFor],
  );

  // Closing an agent pane stops its agent (owner decision): no confirmation, nothing left running,
  // and a launch still held for resources is cancelled rather than starting later without a pane.
  const stopAgent = useCallback(
    async (threadId: string) => {
      if (!stopsOnClose(paneById.get(threadId))) return;
      try {
        providerPanes.updated(await client.stopThread(threadId));
      } catch (error) {
        if (import.meta.env.DEV) console.warn("stop on close failed", error);
      }
    },
    [paneById, providerPanes, client],
  );

  const initialState = useRef({ terminals, activeTerminalId, panes: providerPanes.panes.map((p) => p.thread.id) });
  const store = useMemo(
    () => ({
      load: async () => {
        const stored = await client.layoutGet(workspace.id);
        return stored ? parseLayout(stored.layout) : null;
      },
      save: async (layout: PaneLayout) => {
        await client.layoutSave(workspace.id, layout);
      },
    }),
    [client, workspace.id],
  );
  const controller = usePaneController({
    scope: workspace.id,
    store,
    initial: () =>
      defaultLayoutFor(
        initialState.current.terminals,
        initialState.current.activeTerminalId,
        initialState.current.panes,
      ),
    titleOf,
    onCloseContent: (content) => {
      if (content.kind === "terminal") void closeTerminal(content.terminalId);
      if (content.kind === "thread") void stopAgent(content.threadId);
    },
  });
  const controllerRef = useRef(controller);
  controllerRef.current = controller;

  // KalVoice reads the same live layout and identities that this canvas renders. The registry is
  // in-memory and publishes metadata only: terminal output, provider responses and browser URLs
  // never enter the scene snapshot.
  const sceneLive = useRef({
    controller,
    terminals,
    labels,
    paneById,
    providerPanes,
    accountFor,
    titleOf,
    workspaceName: workspace.name,
  });
  sceneLive.current = {
    controller,
    terminals,
    labels,
    paneById,
    providerPanes,
    accountFor,
    titleOf,
    workspaceName: workspace.name,
  };
  // Code stays mounted (hidden) while other pages are shown; KalVoice sees its panes only when shown.
  const codeShown = current === "code";
  useEffect(() => {
    if (!codeShown) return;
    const registration: VoicePaneSceneRegistration = {
      workspaceId: workspace.id,
      snapshot: () => {
        const current = sceneLive.current;
        const layout = current.controller.layout;
        const aliases = providerPaneAliases(
          current.providerPanes.panes.map((entry) => ({
            threadId: entry.thread.id,
            providerId: entry.thread.providerId,
          })),
          (providerId) => {
            const full = providerIdentity(providerId).name;
            return {
              full,
              short: providerId === "claude-code" ? "Claude" : providerId === "gemini-cli" ? "Gemini" : full,
            };
          },
        );
        const terminalById = new Map(current.terminals.map((terminal) => [terminal.id, terminal]));
        return leaves(layout.root).flatMap((leaf) => {
          const element = typeof document === "undefined" ? null : document.getElementById(paneDomId(leaf.paneId));
          const bounds = element?.getBoundingClientRect();
          const paneVisible = !leaf.collapsed && (!layout.maximizedPaneId || layout.maximizedPaneId === leaf.paneId);
          return leaf.tabs.flatMap((content, index): VoiceSceneTarget[] => {
            const active = index === leaf.activeTab;
            const shared = {
              workspaceId: workspace.id,
              workspaceName: current.workspaceName,
              paneId: leaf.paneId,
              visible: active && paneVisible,
              focused: active && paneVisible && current.controller.focusedPaneId === leaf.paneId,
              rect:
                active && paneVisible && bounds
                  ? { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height }
                  : null,
            } as const;
            if (content.kind === "terminal") {
              const terminal = terminalById.get(content.terminalId);
              if (!terminal) return [];
              const ordinal = terminal.position + 1;
              const title = current.labels.get(terminal.id) ?? terminal.title;
              return [
                {
                  ...shared,
                  kind: "terminal" as const,
                  entityId: terminal.id,
                  title,
                  aliases: [`${title} terminal`, `Terminal ${ordinal}`, `${terminal.title} ${ordinal}`],
                  status: voiceTerminalStatus(terminal),
                  updatedAt: terminal.endedAt ?? terminal.startedAt,
                },
              ];
            }
            if (content.kind === "thread") {
              const thread = current.paneById.get(content.threadId)?.thread;
              if (!thread) return [];
              const account = current.accountFor(thread);
              const effort = voiceThreadEffort(thread);
              return [
                {
                  ...shared,
                  kind: "thread" as const,
                  entityId: thread.id,
                  title: account ? `${thread.name} · ${paneAccountLabel(account)}` : thread.name,
                  aliases: [
                    ...(aliases.get(contentKey(content)) ?? []),
                    thread.providerName,
                    ...(thread.accountLabel ? [thread.accountLabel] : []),
                    thread.workspaceName,
                    `${thread.workspaceName} workspace`,
                    ...(thread.model ? [thread.model] : []),
                    ...(effort ? [effort] : []),
                    ...(thread.branch ? [thread.branch] : []),
                  ],
                  subtitle: thread.currentActivity,
                  status: thread.status,
                  providerId: thread.providerId,
                  providerName: thread.providerName,
                  providerAccountId: thread.providerAccountId,
                  accountLabel: thread.accountLabel,
                  model: thread.model,
                  effort,
                  branch: thread.branch,
                  updatedAt: thread.lastActivityAt,
                },
              ];
            }
            if (content.kind === "browser") {
              return [
                {
                  ...shared,
                  kind: "browser" as const,
                  entityId: content.browserId,
                  title: "Browser",
                  aliases: ["Browser pane", "web preview"],
                },
              ];
            }
            if (content.kind === "dashboard") {
              return [{ ...shared, kind: "dashboard" as const, entityId: "dashboard", title: "Dashboard" }];
            }
            if (content.kind === "widget") {
              return [
                {
                  ...shared,
                  kind: "widget" as const,
                  entityId: content.widgetId,
                  title: current.titleOf(content),
                },
              ];
            }
            if (content.kind === "git") {
              return [{ ...shared, kind: "git" as const, entityId: content.workspaceId, title: "Git" }];
            }
            return [];
          });
        });
      },
      focus: (target) => {
        const current = sceneLive.current.controller;
        const content = allContents(current.layout).find((candidate) => {
          if (target.kind === "terminal" && candidate.kind === "terminal")
            return candidate.terminalId === target.entityId;
          if (target.kind === "thread" && candidate.kind === "thread") return candidate.threadId === target.entityId;
          if (target.kind === "browser" && candidate.kind === "browser") return candidate.browserId === target.entityId;
          if (target.kind === "dashboard") return candidate.kind === "dashboard";
          if (target.kind === "widget" && candidate.kind === "widget") return candidate.widgetId === target.entityId;
          return target.kind === "git" && candidate.kind === "git" && candidate.workspaceId === target.entityId;
        });
        if (!content) return false;
        const found = findContent(current.layout, contentKey(content));
        if (!found) return false;
        current.show(content, { paneId: found.paneId, focus: true });
        const replay = () => {
          const element = typeof document === "undefined" ? null : document.getElementById(paneDomId(found.paneId));
          if (element) replayVoiceFocusTrace(element);
        };
        if (typeof requestAnimationFrame === "function") requestAnimationFrame(replay);
        else queueMicrotask(replay);
        return true;
      },
    };
    return registerVoicePaneScene(registration);
  }, [workspace.id, codeShown]);

  // ---------- Keep the layout in step with the runtime ----------
  const seenTerminals = useRef<Set<string> | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: reconcile on runtime changes only.
  useEffect(() => {
    if (!controller.ready) return;
    const known = new Set(terminals.map((t) => t.id));
    // Terminals closed elsewhere leave the layout.
    const gone = allContents(controller.layout)
      .filter((c) => c.kind === "terminal" && !known.has(c.terminalId))
      .map(contentKey);
    if (gone.length > 0) controller.forget(new Set(gone));
    // Terminals opened while the canvas is up join the focused pane; ones that existed when it
    // opened and aren't in the layout stay in the background (they were closed from a pane).
    if (seenTerminals.current === null) {
      seenTerminals.current = known;
      return;
    }
    for (const terminal of terminals) {
      if (seenTerminals.current.has(terminal.id)) continue;
      seenTerminals.current.add(terminal.id);
      if (!findContent(controller.layout, contentKey(terminalContent(terminal.id)))) {
        controller.show(terminalContent(terminal.id), { focus: false, activate: false });
      }
    }
  }, [terminals, controller.ready]);

  // Coming back to Code puts keyboard focus back in the focused pane's terminal, as opening Code
  // did when it was mounted afresh (a request made while hidden couldn't focus anything). Runs
  // before the request handling below, so a request that brought the person here wins.
  const wasShown = useRef(codeShown);
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when Code is shown again.
  useEffect(() => {
    const returning = codeShown && !wasShown.current;
    wasShown.current = codeShown;
    if (!returning || !controller.ready) return;
    const leaf = leaves(controller.layout.root).find((l) => l.paneId === controller.focusedPaneId);
    const content = leaf?.tabs[leaf.activeTab];
    if (leaf && (content?.kind === "terminal" || content?.kind === "thread")) controller.focusPane(leaf.paneId, true);
  }, [codeShown]);

  // A terminal selected elsewhere (palette, Dashboard, KalVoice, a new terminal) comes forward.
  // The request that brought the person here (a new terminal, Dashboard "Show") runs on mount.
  const handledFocus = useRef(-1);
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs per focus request.
  useEffect(() => {
    if (!controller.ready || focusRequest.n === handledFocus.current) return;
    // A new terminal's request can arrive before the terminal list has it; wait for it.
    if (!terminalById.has(focusRequest.terminalId)) return;
    handledFocus.current = focusRequest.n;
    seenTerminals.current?.add(focusRequest.terminalId);
    controller.show(terminalContent(focusRequest.terminalId), { focus: true });
  }, [focusRequest, controller.ready, terminalById]);

  // The terminal in the focused pane is the workspace's active terminal (palette, Dashboard).
  const focusedLeaf = leaves(controller.layout.root).find((l) => l.paneId === controller.focusedPaneId);
  const focusedContent = focusedLeaf?.tabs[focusedLeaf.activeTab];
  const focusedTerminalId = focusedContent?.kind === "terminal" ? focusedContent.terminalId : null;
  // biome-ignore lint/correctness/useExhaustiveDependencies: follow the focused pane only.
  useEffect(() => {
    if (focusedTerminalId && focusedTerminalId !== activeTerminalId && terminalById.has(focusedTerminalId)) {
      selectTerminal(focusedTerminalId, false);
    }
  }, [focusedTerminalId]);

  // Z7-W3: a Dashboard card, a notification or KalVoice asked to focus a provider pane's thread.
  usePaneFocusRequests((threadId) => {
    if (!controller.ready || !paneById.has(threadId)) return false;
    controller.show(threadContent(threadId), { focus: true });
    return true;
  });

  const newTerminal = useCallback(
    (shellId: string | null) => {
      void createTerminal(shellId);
    },
    [createTerminal],
  );

  // Coding agents (AGENTS.md): each one is a real provider CLI in its own terminal pane, so a
  // launch of N agents starts N panes and lays them out together.
  const [launcher, setLauncher] = useState<{ providerId: PaneProviderId; paneId: string | null } | null>(null);
  // One flag for the whole batch: the dialog can't be cancelled or resubmitted between creates.
  const [launching, setLaunching] = useState(false);
  const openAgentLauncher = useCallback(
    (providerId: PaneProviderId = "claude-code", paneId: string | null = null) => setLauncher({ providerId, paneId }),
    [],
  );
  const launchAgents = useCallback(
    async ({ providerId, count, ...launch }: AgentLaunchSpec, paneId: string | null) => {
      const created: string[] = [];
      setLaunching(true);
      try {
        for (let i = 0; i < count; i += 1) {
          const thread = await providerPanes.create(providerId, launch);
          if (!thread) break;
          created.push(thread.id);
        }
      } finally {
        setLaunching(false);
      }
      const current = controllerRef.current;
      if (paneId) current.focusPane(paneId, false);
      const [first] = created;
      if (created.length === 1 && first) {
        const focused = leaves(current.layout.root).find((l) => l.paneId === current.focusedPaneId);
        current.show(threadContent(first), {
          focus: true,
          placement: focused && focused.tabs.length > 0 ? "split" : "tab",
        });
      } else if (created.length > 1 && first) {
        const next = arrangeContents(current.layout, created.map(threadContent));
        if (next) {
          current.replace(next, `Arranged ${created.length} agents.`);
          const shown = findContent(next, contentKey(threadContent(first)));
          if (shown) current.focusPane(shown.paneId);
        } else {
          for (const id of created) current.show(threadContent(id), { focus: id === first, placement: "tab" });
        }
      }
      // Any started agent closes the launcher, so a retry never duplicates them; a failure that
      // stopped the batch stays visible in the Code toolbar.
      return created.length > 0;
    },
    [providerPanes],
  );

  // ---------- Contents ----------
  // Closing a terminal's tab ends it (the shell and everything it started, owner decision). The
  // tab leaves the layout at once; ending the process tree finishes in the background, and a
  // failure is reported by `closeTerminal` (the terminal then stays listed in the background).
  const closeTerminalTab = useCallback(
    (terminalId: string) => {
      controllerRef.current.forget(new Set([contentKey(terminalContent(terminalId))]));
      void closeTerminal(terminalId);
    },
    [closeTerminal],
  );

  const describe = useCallback(
    (content: PaneContent): TabInfo | null => {
      if (content.kind === "browser") return { title: "Browser", glyph: <Globe />, statusText: "Web preview" };
      if (content.kind === "terminal") {
        const terminal = terminalById.get(content.terminalId);
        if (!terminal) return null;
        const running = terminal.status === "running";
        return {
          title: labels.get(terminal.id) ?? terminal.title,
          glyph: <ProviderGlyph provider="shell" size="xs" />,
          tone: terminalTone(terminal),
          stateLabel: running ? undefined : "Ended",
          statusText: describeTerminalStatus(terminal),
          terminal: true,
          running,
          stop: running ? { label: "End terminal", run: () => closeTerminalTab(terminal.id) } : undefined,
          onClose: () => closeTerminalTab(terminal.id),
        };
      }
      if (content.kind === "thread") {
        const entry = paneById.get(content.threadId);
        if (!entry) return null;
        const status = paneStatus(entry.thread.status);
        const account = accountFor(entry.thread);
        return {
          title: account ? `${entry.thread.name} · ${paneAccountLabel(account)}` : entry.thread.name,
          glyph: <ProviderGlyph provider={entry.thread.providerId} size="xs" />,
          tone: status.tone,
          statusText: `${entry.thread.providerName}${account ? ` · ${paneAccountLabel(account)}` : ""} · ${status.label}`,
          terminal: true,
          running: entry.info.running,
          // Closing the tab stops the agent and takes the pane thread out of the layout.
          onClose: () => {
            void stopAgent(entry.thread.id);
            controllerRef.current.forget(new Set([contentKey(threadContent(entry.thread.id))]));
          },
        };
      }
      return null;
    },
    [terminalById, labels, paneById, closeTerminalTab, accountFor, stopAgent],
  );

  const render = useCallback(
    (content: PaneContent, context: PaneRenderContext): ReactNode | null => {
      if (content.kind === "browser")
        return (
          <BrowserContentPanel
            bridge={browserBridge}
            content={content}
            workspaceId={workspace.id}
            context={context}
            controllerRef={controllerRef}
            visible={current === "code"}
            initialUrl={initialBrowserUrls.current.get(content.browserId)}
          />
        );
      if (content.kind === "terminal") {
        const terminal = terminalById.get(content.terminalId);
        if (!terminal) return null;
        return (
          <TerminalPanel
            terminal={terminal}
            label={labels.get(terminal.id) ?? terminal.title}
            context={context}
            theme={theme}
            workspace={workspace}
            onRestart={() => void restartTerminal(terminal.id)}
            onClose={() => closeTerminalTab(terminal.id)}
          />
        );
      }
      if (content.kind === "thread") {
        const entry = paneById.get(content.threadId);
        if (!entry) {
          return (
            <PaneNotice
              icon={<LayoutPanelLeft />}
              title="This thread isn't a pane here"
              actions={
                <Button
                  size="sm"
                  onClick={() => {
                    navigate("threads");
                    threadsIntent.request("open", content.threadId);
                  }}
                >
                  Open in Threads
                </Button>
              }
            >
              <p>It runs without a terminal pane, or provider panes are off in this build. Threads shows it in full.</p>
            </PaneNotice>
          );
        }
        return (
          <ProviderPane
            thread={entry.thread}
            info={entry.info}
            channel={providerPanes.channel}
            account={accountFor(entry.thread)}
            theme={theme}
            focusRequest={context.focusRequest}
            throttled={!context.focused}
            onChanged={providerPanes.updated}
          />
        );
      }
      return null;
    },
    [
      terminalById,
      labels,
      paneById,
      theme,
      workspace,
      restartTerminal,
      closeTerminalTab,
      providerPanes,
      navigate,
      threadsIntent,
      current,
      accountFor,
      browserBridge,
    ],
  );

  // Browser children are resources, unlike background provider jobs. Release children removed
  // from the layout (tab or whole-pane close), and recreate from safe saved state on undo.
  const browserIds = useRef(new Set<string>());
  useEffect(() => {
    const next = new Set(
      allContents(controller.layout).flatMap((item) => (item.kind === "browser" ? [item.browserId] : [])),
    );
    for (const id of browserIds.current) {
      if (!next.has(id)) {
        initialBrowserUrls.current.delete(id);
        void browserBridge.close(id).catch(() => undefined);
      }
    }
    browserIds.current = next;
  }, [controller.layout, browserBridge]);
  useEffect(
    () => () => {
      for (const id of browserIds.current) void browserBridge.close(id).catch(() => undefined);
      browserIds.current.clear();
    },
    [browserBridge],
  );

  const shown = useMemo(() => new Set(allContents(controller.layout).map(contentKey)), [controller.layout]);
  const background = useMemo(() => {
    const list: { content: PaneContent; title: string }[] = [];
    for (const t of terminals) {
      const content = terminalContent(t.id);
      if (t.status === "running" && !shown.has(contentKey(content))) list.push({ content, title: titleOf(content) });
    }
    for (const p of providerPanes.panes) {
      const content = threadContent(p.thread.id);
      if (p.info.running && !shown.has(contentKey(content))) list.push({ content, title: titleOf(content) });
    }
    return list;
  }, [terminals, providerPanes.panes, shown, titleOf]);

  const shell = defaultShell(shells);
  // Git in a pane hasn't shipped. Builds that show the Git feature (Development) name it as coming;
  // Stable and Beta never advertise it.
  const gitTeaser = info.flags.features?.some((f) => f.id === "git_core" && f.visible) ?? false;

  const renderEmpty = useCallback(
    (paneId: string) => (
      <EmptyPane
        shell={shell}
        providerPanes={providerPanes}
        background={background}
        gitTeaser={gitTeaser}
        onTerminal={() => newTerminal(null)}
        onProviderPane={() => openAgentLauncher("claude-code", paneId)}
        onShow={(content) => controllerRef.current.show(content, { paneId, focus: true })}
      />
    ),
    [shell, providerPanes, background, gitTeaser, newTerminal, openAgentLauncher],
  );

  // Z7-W2's widgets stay registered (saved layouts restore them) but are offered only when their
  // views are visible, like the palette's "Show in a pane" commands.
  const features = info.flags.features;
  const addableWidgets = useCallback(
    () =>
      registeredWidgets().filter((w) =>
        w.widgetId === HOME_WIDGET
          ? viewVisible("home", features)
          : w.widgetId === PROJECT_WIDGET || w.widgetId === WORKSPACES_WIDGET
            ? viewVisible("folder", features)
            : true,
      ),
    [features],
  );

  const addMenu = useCallback(
    (paneId: string) => (
      <>
        <DropdownMenuLabel>Open here</DropdownMenuLabel>
        {shells.map((s) => (
          <DropdownMenuItem
            key={s.id}
            icon={<SquareTerminal />}
            description={s.isDefault ? "Default shell" : undefined}
            onSelect={() => {
              controllerRef.current.focusPane(paneId, false);
              newTerminal(s.id);
            }}
          >
            {`New ${s.name} terminal`}
          </DropdownMenuItem>
        ))}
        {/* Near the top: at small window heights the menu scrolls, and Browser must not be below it. */}
        <DropdownMenuItem
          icon={<Globe />}
          onSelect={() => controllerRef.current.show(browserContent(), { paneId, focus: true })}
        >
          Browser
        </DropdownMenuItem>
        {providerPanes.enabled ? (
          <DropdownMenuItem
            icon={<ProviderGlyph provider="claude-code" size="xs" />}
            description="A coding agent: the real Claude Code, checked by KalCode"
            onSelect={() => openAgentLauncher("claude-code", paneId)}
          >
            Claude Code agent
          </DropdownMenuItem>
        ) : null}
        {providerPanes.enabled
          ? providerPanes.offered.map((providerId) => (
              <DropdownMenuItem
                key={providerId}
                icon={<ProviderGlyph provider={providerId} size="xs" />}
                description={`A coding agent: the real ${providerIdentity(providerId).name}; approvals in its own prompt`}
                onSelect={() => openAgentLauncher(providerId, paneId)}
              >
                {`${providerIdentity(providerId).name} agent`}
              </DropdownMenuItem>
            ))
          : null}
        <DropdownMenuItem
          icon={<LayoutDashboard />}
          onSelect={() => controllerRef.current.show({ kind: "dashboard" }, { paneId, focus: true })}
        >
          Dashboard
        </DropdownMenuItem>
        {addableWidgets().length > 0 ? <DropdownMenuLabel>Widgets</DropdownMenuLabel> : null}
        {addableWidgets().map((w) => (
          <DropdownMenuItem
            key={w.widgetId}
            icon={<LayoutPanelLeft />}
            onSelect={() => controllerRef.current.show({ kind: "widget", widgetId: w.widgetId }, { paneId })}
          >
            {w.title}
          </DropdownMenuItem>
        ))}
        {background.length > 0 ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>Running in the background</DropdownMenuLabel>
            {background.map((item) => (
              <DropdownMenuItem
                key={contentKey(item.content)}
                icon={
                  item.content.kind === "thread" ? (
                    <ProviderGlyph
                      provider={paneById.get(item.content.threadId)?.thread.providerId ?? "claude-code"}
                      size="xs"
                    />
                  ) : (
                    <ProviderGlyph provider="shell" size="xs" />
                  )
                }
                onSelect={() => controllerRef.current.show(item.content, { paneId, focus: true })}
              >
                {`Show ${item.title}`}
              </DropdownMenuItem>
            ))}
          </>
        ) : null}
        {gitTeaser ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem icon={<GitBranch />} disabled description="Not in this build yet">
              Git
            </DropdownMenuItem>
          </>
        ) : null}
      </>
    ),
    [
      shells,
      providerPanes.enabled,
      providerPanes.offered,
      background,
      newTerminal,
      openAgentLauncher,
      paneById,
      addableWidgets,
      gitTeaser,
    ],
  );

  const onCommand = useCallback(
    (command: PaneCommand): PaneCommandResult | null => {
      const current = controllerRef.current;
      if (command.kind === "open-agent-launcher") {
        if (!providerPanes.enabled) return { handled: false, message: "Coding agents aren't available in this build." };
        const providerId = command.providerId ?? "claude-code";
        openAgentLauncher(isPaneProvider(providerId) ? providerId : "claude-code");
        return { handled: true };
      }
      if (command.kind === "browser-control") {
        const action = command.command;
        const target = resolveBrowserTarget(
          current.layout,
          current.focusedPaneId,
          action.kind === "open" ? null : action.browserId,
        );
        const openNew = (url: string | null) => {
          const runtimeUrl = url === null ? null : normalizeBrowserAddress(url);
          const content = browserContent(undefined, runtimeUrl === null ? null : persistableBrowserUrl(runtimeUrl));
          if (runtimeUrl !== null) initialBrowserUrls.current.set(content.browserId, runtimeUrl);
          current.show(content, { focus: true, placement: "split" });
          return { handled: true as const, message: "Opening Browser." };
        };
        try {
          if (action.kind === "open" && (action.newPane || !target)) return openNew(action.url);
          if (
            action.kind === "navigate" &&
            !target &&
            !action.browserId &&
            !allContents(current.layout).some((item) => item.kind === "browser")
          )
            return openNew(action.url);
          if (!target) return { handled: false, message: "Focus the browser pane you want to control first." };
          current.show(target.content, { paneId: target.paneId, focus: true });
          if (action.kind === "open" && action.url === null) return { handled: true };
          const operation =
            action.kind === "open" || action.kind === "navigate"
              ? browserBridge.navigate(target.content.browserId, normalizeBrowserAddress(action.url as string))
              : browserBridge.action(target.content.browserId, action.kind);
          void operation
            .then((state) => {
              const latest = controllerRef.current;
              const next = updateBrowserUrl(latest.layout, state.browserId, state.url);
              if (next !== latest.layout) latest.replace(next);
            })
            .catch(() =>
              controllerRef.current.announce("That browser action did not complete. Check the browser pane."),
            );
          return { handled: true, message: "Browser action requested." };
        } catch {
          return { handled: false, message: "That address cannot be opened in Browser." };
        }
      }
      if (command.kind === "open" && command.content.kind === "thread" && !paneById.has(command.content.threadId)) {
        navigate("threads");
        threadsIntent.request("open", command.content.threadId);
        return { handled: true, message: "Opened the thread in Threads." };
      }
      if (command.kind === "arrange-providers") {
        const selected = selectDistinctProviderThreads(
          command.providerIds,
          providerPanes.panes.map((entry) => ({ threadId: entry.thread.id, providerId: entry.thread.providerId })),
        );
        const found = selected.threadIds.map(threadContent);
        if (found.length === 0) {
          return { handled: false, message: "None of those providers has a pane in this workspace yet." };
        }
        const [first, ...rest] = found;
        if (first) current.show(first, { focus: true });
        for (const content of rest) {
          const target = current.focusedPaneId;
          if (target) current.split(target, command.axis, content);
        }
        return selected.missing.length > 0
          ? { handled: true, message: `Arranged the available panes. No pane yet for ${selected.missing.join(", ")}.` }
          : { handled: true };
      }
      if (command.kind === "open-provider-panes") {
        const threadIds = [...new Set(command.threadIds.filter((threadId) => threadId.trim().length > 0))];
        if (threadIds.length === 0) return { handled: false, message: "No provider panes were created." };
        const next = arrangeContents(current.layout, threadIds.map(threadContent));
        if (!next) {
          return { handled: false, message: "There isn't room to show every new provider pane." };
        }
        current.replace(next, `Arranged ${threadIds.length} provider ${threadIds.length === 1 ? "pane" : "panes"}.`);
        const first = findContent(next, contentKey(threadContent(threadIds[0] as string)));
        if (first) current.focusPane(first.paneId);
        // The exact ids are already authoritative; refresh fills their runtime labels and status.
        void providerPanes.refresh();
        return { handled: true };
      }
      if (command.kind === "control-pane") {
        const aliases = providerPaneAliases(
          providerPanes.panes.map((entry) => ({ threadId: entry.thread.id, providerId: entry.thread.providerId })),
          (providerId) => {
            const full = providerIdentity(providerId).name;
            const short = providerId === "claude-code" ? "Claude" : providerId === "gemini-cli" ? "Gemini" : full;
            return { full, short };
          },
        );
        const contents = new Map(allContents(current.layout).map((content) => [contentKey(content), content]));
        const candidates = paneQueryCandidates(current.layout, (key) => {
          const content = contents.get(key);
          return content ? { title: titleOf(content), aliases: aliases.get(key) ?? [] } : null;
        });
        const result = applyPaneControl(
          current.layout,
          command.command,
          candidates,
          current.focusedPaneId,
          current.size.current,
        );
        if (!result.handled) return result;
        current.replace(result.layout, "Updated the pane layout.");
        if (result.paneId) current.focusPane(result.paneId);
        return { handled: true };
      }
      return null;
    },
    [paneById, providerPanes, navigate, threadsIntent, titleOf, browserBridge, openAgentLauncher],
  );

  const host: PaneHost = useMemo(
    () => ({ describe, render, renderEmpty, addMenu, onCommand }),
    [describe, render, renderEmpty, addMenu, onCommand],
  );

  const canvas = controller.ready ? (
    <PaneCanvas
      controller={controller}
      host={host}
      label={`Panes in ${workspace.name}`}
      scope={workspace.id}
      active={codeShown}
    />
  ) : (
    <div className={styles.canvasLoading} role="status" aria-busy="true">
      <span className="visually-hidden">Loading the layout</span>
    </div>
  );

  return (
    <>
      <UtilityDockRegistration />
      {children({ controller, background, providerPanes, shells, newTerminal, openAgentLauncher, titleOf }, canvas)}
      {launcher ? (
        <NewAgentDialog
          workspace={workspace}
          offered={providerPanes.offered}
          initialProvider={launcher.providerId}
          busy={launching || providerPanes.creating}
          error={providerPanes.error}
          onLaunch={(spec) => launchAgents(spec, launcher.paneId)}
          onClose={() => setLauncher(null)}
        />
      ) : null}
    </>
  );
}

/** A terminal in a pane: its view, and the restart / ended states (Z1). */
function TerminalPanel({
  terminal,
  label,
  context,
  theme,
  workspace,
  onRestart,
  onClose,
}: {
  terminal: TerminalInfo;
  label: string;
  context: PaneRenderContext;
  theme: "light" | "dark";
  workspace: Workspace;
  onRestart: () => void;
  onClose: () => void;
}) {
  if (terminal.status === "ended_by_app") {
    return (
      <div className={styles.panelMessage} data-status={terminal.status}>
        <EmptyState
          headingLevel={2}
          framed={false}
          art={<PowerOff />}
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
    );
  }
  return (
    <div className={styles.paneTerminal} data-status={terminal.status}>
      <TerminalView
        key={`${terminal.id}:${terminal.startedAt ?? ""}`}
        terminal={terminal}
        label={label}
        visible
        focusRequest={context.focusRequest}
        theme={theme}
        throttled={!context.focused}
      />
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
    </div>
  );
}

/** An empty pane: what can be opened here. */
function EmptyPane({
  shell,
  providerPanes,
  background,
  onTerminal,
  onProviderPane,
  onShow,
  gitTeaser,
}: {
  shell: ShellOption | null;
  providerPanes: ProviderPanes;
  background: { content: PaneContent; title: string }[];
  onTerminal: () => void;
  onProviderPane: () => void;
  onShow: (content: PaneContent) => void;
  gitTeaser: boolean;
}) {
  return (
    <div className={styles.emptyPane}>
      <div className={styles.emptyHead}>
        <span className={styles.emptyPaneArt} aria-hidden="true">
          <LayoutPanelLeft />
        </span>
        <div>
          <h2 className={styles.emptyTitle}>Empty pane</h2>
          <p className={styles.emptyText}>Open something here. Closing a pane ends what runs in it.</p>
        </div>
      </div>
      <div className={styles.emptyActions}>
        <Button size="sm" icon={<Globe />} onClick={() => onShow(browserContent())}>
          Open Browser
        </Button>
        <Button variant="primary" size="sm" icon={<SquareTerminal />} onClick={onTerminal} disabled={!shell}>
          {shell ? `New ${shell.name} terminal` : "No shells found"}
        </Button>
        {providerPanes.enabled ? (
          <Button
            size="sm"
            icon={<ProviderGlyph provider="claude-code" size="xs" />}
            busy={providerPanes.creating}
            onClick={onProviderPane}
          >
            Launch an agent
          </Button>
        ) : null}
      </div>
      {background.length > 0 ? (
        <div className={styles.emptyGroup}>
          <h3 className={styles.emptyLabel}>Running in the background</h3>
          <ul className={styles.emptyList}>
            {background.slice(0, 6).map((item) => (
              <li key={contentKey(item.content)}>
                <button type="button" className={styles.emptyItem} onClick={() => onShow(item.content)}>
                  <span className={styles.emptyDot} aria-hidden="true" />
                  <span className={styles.emptyItemTitle}>{item.title}</span>
                  <span className={styles.emptyItemAction}>Show</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {gitTeaser ? (
        <div className={styles.emptyGroup}>
          <h3 className={styles.emptyLabel}>Not in this build yet</h3>
          <p className={styles.emptyComing}>
            <Badge tone="outline">
              <GitBranch aria-hidden="true" /> Git
            </Badge>
          </p>
        </div>
      ) : null}
    </div>
  );
}

function BrowserContentPanel({
  bridge,
  content,
  workspaceId,
  context,
  controllerRef,
  visible,
  initialUrl,
}: {
  bridge: ReturnType<typeof createBrowserBridge>;
  content: Extract<PaneContent, { kind: "browser" }>;
  workspaceId: string;
  context: PaneRenderContext;
  controllerRef: { current: PaneController };
  visible: boolean;
  initialUrl?: string;
}) {
  const onRequestFocus = useCallback(
    () => controllerRef.current.focusPane(context.paneId, false),
    [controllerRef, context.paneId],
  );
  const onUrlChange = useCallback(
    (url: string) => {
      const controller = controllerRef.current;
      const next = updateBrowserUrl(controller.layout, content.browserId, url);
      if (next !== controller.layout) controller.replace(next);
    },
    [controllerRef, content.browserId],
  );
  return (
    <BrowserPane
      content={content}
      workspaceId={workspaceId}
      context={context}
      bridge={bridge}
      visible={visible}
      initialUrl={initialUrl}
      onRequestFocus={onRequestFocus}
      onUrlChange={onUrlChange}
    />
  );
}
