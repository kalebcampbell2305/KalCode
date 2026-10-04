import type {
  PaneContent,
  PaneLayout,
  ProviderAccount,
  ShellOption,
  StatusTone,
  TerminalInfo,
  ThreadSummary,
  Workspace,
} from "@kalcode/protocol";
import {
  Button,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  EmptyState,
  type ObjectMenuItem,
  ProviderGlyph,
  Skeleton,
  useToast,
} from "@kalcode/ui/components";
import {
  Bot,
  Copy,
  Focus,
  GitBranch,
  Globe,
  LayoutDashboard,
  LayoutPanelLeft,
  PenLine,
  PowerOff,
  RotateCcw,
  Square,
  SquareTerminal,
  UserRoundCog,
  X,
} from "lucide-react";
import { memo, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toKalCodeError } from "../../ipc/errors.ts";
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
import { useWorkspaces, useWorkspaceVisible } from "../../runtime/WorkspaceProvider.tsx";
import { defaultShell, describeTerminalStatus, tabLabels } from "../../runtime/workspaceState.ts";
import { useNavigation, viewVisible } from "../../shell/navigation.tsx";
import { suggestTask, type TaskLayout } from "../../shell/panes/adaptiveCanvas.ts";
import { PaneNotice } from "../../shell/panes/builtinContent.tsx";
import type { PaneRenderContext, TabInfo } from "../../shell/panes/contentRegistry.ts";
import { registeredWidgets } from "../../shell/panes/contentRegistry.ts";
import {
  allContents,
  arrangeContents,
  canSplit,
  contentKey,
  emptyLayout,
  findContent,
  leaves,
  makeLeaf,
  migrateAgentContents,
  parseLayout,
  removeContents,
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
  providerPaneAliasesOf,
  selectDistinctProviderThreads,
} from "../../shell/panes/paneCommands.ts";
import { PANE_SHORTCUT_LABELS } from "../../shell/panes/paneShortcuts.ts";
import { type PaneController, usePaneController } from "../../shell/panes/usePaneController.ts";
import { HOME_WIDGET, PROJECT_WIDGET, WORKSPACES_WIDGET } from "../../shell/rail/paneIds.ts";
import { useResolvedTheme } from "../../shell/useResolvedTheme.ts";
import { accountName } from "../providers/accountIdentity.ts";
import { useOptionalProviderAccountSessions } from "../providers/ProviderAccountSessions.tsx";
import { setSelectedCodeContext } from "../threads/accountIntent.ts";
import { useThreadsIntent } from "../threads/intent.tsx";
import { RebindThreadDialog } from "../threads/RebindThreadDialog.tsx";
import { rebindBlocker } from "../threads/useThreadAccount.ts";
import { UtilityDockRegistration } from "../utilities/UtilityDockPane.tsx";
import styles from "./Code.module.css";
import { CodeContextOperationsRegistration } from "./CodeContextOperations.tsx";
import { HandOffDialog } from "./HandOffDialog.tsx";
import { useKalTidyClosedPanes } from "./kaltidy/closedPanes.ts";
import { type AgentLaunchSpec, NewAgentDialog } from "./NewAgentDialog.tsx";
import { BADGES } from "./organization/model.ts";
import { type Organization, useOrganization } from "./organization/useOrganization.ts";
import { readLaunchMemory } from "./panes/agentLaunch.ts";
import { isPaneProvider, type PaneProviderId } from "./panes/paneChannel.ts";
import { paneStatus, providerIdentity } from "./panes/paneLabels.ts";
import { agentAttention, useAgentAttention } from "./useAgentAttention.ts";
import { SmartCloseDialog, useSmartClose } from "./useSmartClose.tsx";
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
import {
  canStopPane,
  type DuplicatePlacement,
  duplicatePaneInput,
  duplicatePlacement,
  paneRebindAccounts,
  rememberDuplicatePlacement,
} from "./paneContextActions.ts";
import { paneAccountLabel, resolvePaneAccount } from "./panes/PaneParts.tsx";
import { ProviderPane } from "./panes/ProviderPane.tsx";
import { type ProviderPanes, useProviderPanes } from "./panes/useProviderPanes.ts";
import { RenamePaneDialog } from "./RenamePaneDialog.tsx";
import { CODE_SHORTCUT_LABELS } from "./shortcuts.ts";
import { TerminalImageButton } from "./TerminalImageButton.tsx";
import { TerminalView } from "./TerminalView.tsx";
import { terminalImageTargetKey } from "./terminalImages.ts";

/** How long an agent pane waits for its terminal before offering Retry. */
const RETRY_AFTER_MS = 4000;

const terminalContent = (terminalId: string): PaneContent => ({ kind: "terminal", terminalId });
const agentContent = (agentId: string): PaneContent => ({ kind: "agent", agentId });

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
    const panes = makeLeaf(paneThreadIds.map(agentContent));
    layout = tabs.length > 0 ? splitPane(layout, first.paneId, "horizontal", panes) : { ...layout, root: panes };
  }
  return layout;
}

/** Something running that isn't shown in any pane, with the tone of its status dot. */
export interface BackgroundItem {
  content: PaneContent;
  title: string;
  tone: StatusTone;
}

export interface CodeCanvasApi {
  controller: PaneController;
  /** Contents that run but aren't shown in any pane. */
  background: BackgroundItem[];
  providerPanes: ProviderPanes;
  shells: readonly ShellOption[];
  newTerminal: (shellId: string | null) => void;
  /** Opens the coding-agent launcher with the last selection unless a provider is named. */
  openAgentLauncher: (providerId?: PaneProviderId) => void;
  titleOf: (content: PaneContent) => string;
  applyTaskLayout: (task: TaskLayout) => void;
  layoutSuggestion: ReturnType<typeof suggestTask>;
  /** Terminal Organization: purpose names, status badges, the stack and What's Happening. */
  organization: Organization;
}

interface CodeCanvasProps {
  workspace: Workspace;
  /**
   * Renders the header toolbar and status bar around the canvas. `api` is null while the
   * workspace's panes load: the header shows at once and the canvas is a skeleton.
   */
  children: (api: CodeCanvasApi | null, canvas: ReactNode) => ReactNode;
}

/** The canvas while panes or the saved layout load: one quiet pane frame, never a blank page. */
function CanvasSkeleton({ label }: { label: string }) {
  return (
    <div className={styles.canvasLoading} role="status" aria-busy="true">
      <span className="visually-hidden">{label}</span>
      <div className={styles.skeletonFrame} aria-hidden="true">
        <div className={styles.skeletonHeader}>
          <Skeleton width="7.5rem" height="0.75rem" />
          <Skeleton width="5rem" height="0.75rem" />
        </div>
        <div className={styles.skeletonBody}>
          <Skeleton width="38%" height="0.625rem" />
          <Skeleton width="62%" height="0.625rem" />
          <Skeleton width="47%" height="0.625rem" />
        </div>
      </div>
    </div>
  );
}

/**
 * The Code surface's pane canvas (Z7-W1): terminals (Z1) and provider panes (Z7-W4) side by
 * side, arranged freely and saved per workspace. Waits for the provider pane list so the first
 * layout of a workspace can include them.
 */
export function CodeCanvas({ workspace, children }: CodeCanvasProps) {
  const workspaceVisible = useWorkspaceVisible();
  const providerPanes = useProviderPanes(workspace, { active: useNavigation().current === "code" && workspaceVisible });
  if (!providerPanes.loaded) return <>{children(null, <CanvasSkeleton label="Loading panes" />)}</>;
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
  const toast = useToast();
  const accountSessions = useOptionalProviderAccountSessions();
  const hasSharedAccountSessions = accountSessions !== null;
  const { current, navigate, recordLocation, registerRestorer } = useNavigation();
  const workspaceVisible = useWorkspaceVisible();
  const codeShown = current === "code" && workspaceVisible;
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
    restartTerminal,
    selectTerminal,
    refresh: refreshWorkspaces,
  } = useWorkspaces();
  const labels = useMemo(() => tabLabels(terminals), [terminals]);
  const terminalById = useMemo(() => new Map(terminals.map((t) => [t.id, t])), [terminals]);
  const paneById = useMemo(() => new Map(providerPanes.panes.map((p) => [p.thread.id, p])), [providerPanes.panes]);
  const organization = useOrganization({
    workspaceId: workspace.id,
    terminals,
    shells,
    panes: providerPanes.panes,
    active: codeShown,
  });
  const orgItems = organization.byKey;
  useEffect(() => {
    if (hasSharedAccountSessions) return;
    let cancelled = false;
    // The previous accounts stay until the new read lands, so pane labels don't flicker.
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
  }, [client, hasSharedAccountSessions]);
  const restoredProviderAccounts = accountSessions?.accounts ?? providerAccounts;
  const restoredProviderAccountsUnavailable = accountSessions
    ? accountSessions.loadError !== null
    : providerAccountsUnavailable;
  const accountFor = useCallback(
    (thread: ThreadSummary) =>
      resolvePaneAccount(thread, restoredProviderAccounts, restoredProviderAccountsUnavailable),
    [restoredProviderAccounts, restoredProviderAccountsUnavailable],
  );

  const titleOf = useCallback(
    (content: PaneContent): string => {
      if (content.kind === "terminal") {
        const terminal = terminalById.get(content.terminalId);
        if (!terminal) return "Terminal";
        return orgItems.get(contentKey(content))?.title ?? labels.get(terminal.id) ?? terminal.title;
      }
      if (content.kind === "agent") {
        const thread = paneById.get(content.agentId)?.thread;
        if (!thread) return "Agent";
        const name = orgItems.get(contentKey(content))?.title ?? thread.name;
        const account = accountFor(thread);
        return account ? `${name} · ${paneAccountLabel(account)}` : name;
      }
      if (content.kind === "dashboard") return "Dashboard";
      if (content.kind === "thread") return "Thread";
      if (content.kind === "browser") return "Browser";
      if (content.kind === "git") return "Git";
      return "Widget";
    },
    [terminalById, labels, paneById, accountFor, orgItems],
  );

  const smartClose = useSmartClose({
    inspect: async (content) => {
      if (content.kind === "terminal") {
        const terminal = (await client.listTerminals(workspace.id)).find((t) => t.id === content.terminalId);
        return terminal?.status === "running";
      }
      if (content.kind === "agent") {
        const [thread, pane] = await Promise.all([
          client.getThread(content.agentId),
          providerPanes.channel.info(content.agentId),
        ]);
        return pane?.running !== false || !["completed", "failed", "interrupted", "offline"].includes(thread.status);
      }
      return false;
    },
    stop: async (content, confirmed) => {
      if (content.kind === "terminal") {
        // Use the throwing API: a failed stop must leave the pane visible.
        const terminal = (await client.listTerminals(workspace.id)).find((t) => t.id === content.terminalId);
        if (terminal) await client.closeTerminal(content.terminalId, !confirmed);
        await refreshWorkspaces();
      } else if (content.kind === "agent") {
        const [thread, pane] = await Promise.all([
          client.getThread(content.agentId),
          providerPanes.channel.info(content.agentId),
        ]);
        if (pane?.running === false && ["completed", "failed", "interrupted", "offline"].includes(thread.status))
          return;
        if (!confirmed)
          throw {
            category: "terminal",
            code: "agent_still_running",
            message: "This agent is running.",
            retryable: true,
          };
        providerPanes.updated(await client.stopThread(content.agentId));
      }
    },
  });
  const agentThreads = useMemo(() => providerPanes.panes.map((entry) => entry.thread), [providerPanes.panes]);
  const attention = useAgentAttention(agentThreads);

  const initialState = useRef({
    terminals,
    activeTerminalId,
    panes: providerPanes.panes.map((p) => p.thread.id),
    chatIds: providerPanes.chatIds,
  });
  const store = useMemo(
    () => ({
      load: async () => {
        const stored = await client.layoutGet(workspace.id);
        const layout = stored ? parseLayout(stored.layout) : null;
        return layout
          ? removeContents(
              migrateAgentContents(layout, new Set(initialState.current.panes)),
              new Set(initialState.current.chatIds.map((id) => `thread:${id}`)),
            )
          : null;
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
    requestClose: smartClose.request,
  });
  const controllerRef = useRef(controller);
  controllerRef.current = controller;
  // KalTidy (Close all, agent clears) closes the panes of what it ended.
  useKalTidyClosedPanes((keys) => controllerRef.current.forget(keys));

  useEffect(() => {
    if (!controller.ready) return;
    const layout = removeContents(
      migrateAgentContents(controller.layout, new Set(paneById.keys())),
      new Set(providerPanes.chatIds.map((id) => `thread:${id}`)),
    );
    if (layout !== controller.layout) controller.replace(layout);
  }, [controller, paneById, providerPanes.chatIds]);

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
            if (content.kind === "agent") {
              const thread = current.paneById.get(content.agentId)?.thread;
              if (!thread) return [];
              const account = current.accountFor(thread);
              const effort = voiceThreadEffort(thread);
              return [
                {
                  ...shared,
                  kind: "agent" as const,
                  entityId: thread.id,
                  title: account ? `${thread.name} · ${paneAccountLabel(account)}` : thread.name,
                  aliases: [
                    ...providerPaneAliasesOf(aliases, content),
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
          if (target.kind === "agent" && candidate.kind === "agent") return candidate.agentId === target.entityId;
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
  // Seeded at mount: a terminal created while the layout loads is new and joins a pane, while
  // ones that existed when the canvas opened and aren't in the layout stay in the background.
  const seenTerminals = useRef(new Set(initialState.current.terminals.map((t) => t.id)));
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
    if (leaf && (content?.kind === "terminal" || content?.kind === "agent")) controller.focusPane(leaf.paneId, true);
  }, [codeShown]);

  // A terminal selected elsewhere (palette, Dashboard, KalVoice, a new terminal) comes forward.
  // The request that brought the person here (a new terminal, Dashboard "Show") runs on mount.
  const handledFocus = useRef(-1);
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs per focus request.
  useEffect(() => {
    if (!codeShown || !controller.ready || focusRequest.n === handledFocus.current) return;
    // A new terminal's request can arrive before the terminal list has it; wait for it.
    if (!terminalById.has(focusRequest.terminalId)) return;
    handledFocus.current = focusRequest.n;
    seenTerminals.current.add(focusRequest.terminalId);
    controller.show(terminalContent(focusRequest.terminalId), { focus: true });
  }, [focusRequest, controller.ready, terminalById, codeShown]);

  // The terminal in the focused pane is the workspace's active terminal (palette, Dashboard).
  const focusedLeaf = leaves(controller.layout.root).find((l) => l.paneId === controller.focusedPaneId);
  const focusedContent = focusedLeaf?.tabs[focusedLeaf.activeTab];
  // Pane focus (including Browser and Runs widgets) is application navigation. Replaying
  // selects the current content by identity without replacing its live state or URL.
  useEffect(() => {
    if (!codeShown || !controller.ready) return;
    recordLocation({
      destination: "code",
      workspaceId: workspace.id,
      label: focusedContent ? titleOf(focusedContent) : workspace.name,
      ...(focusedContent ? { target: { kind: "pane" as const, content: focusedContent } } : {}),
    });
  }, [codeShown, controller.ready, workspace.id, workspace.name, focusedContent, titleOf, recordLocation]);
  useEffect(
    () =>
      registerRestorer((entry, isCurrent) => {
        if (entry.destination !== "code" || entry.workspaceId !== workspace.id || entry.target?.kind !== "pane")
          return undefined;
        const current = controllerRef.current;
        if (!current.ready) return undefined;
        const key = contentKey(entry.target.content);
        const leaf = leaves(current.layout.root).find((pane) =>
          pane.tabs.some((content) => contentKey(content) === key),
        );
        if (!leaf) return false;
        const content = leaf.tabs.find((content) => contentKey(content) === key);
        if (!content || !isCurrent()) return false;
        current.show(content, { focus: true });
        return true;
      }),
    [registerRestorer, workspace.id],
  );
  const focusedTerminalId = focusedContent?.kind === "terminal" ? focusedContent.terminalId : null;
  const focusedAgentId = focusedContent?.kind === "agent" ? focusedContent.agentId : null;
  // The shell reads only the visible pane's identity; it resolves account metadata from the
  // existing session summaries and registry. Hidden Code must never replace Threads context.
  useEffect(() => {
    if (!codeShown || !controller.ready) return;
    return setSelectedCodeContext({
      workspaceId: workspace.id,
      content: focusedAgentId
        ? { kind: "agent", agentId: focusedAgentId }
        : focusedTerminalId
          ? { kind: "terminal", terminalId: focusedTerminalId }
          : null,
    });
  }, [codeShown, controller.ready, workspace.id, focusedAgentId, focusedTerminalId]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: follow the focused pane only.
  useEffect(() => {
    if (
      codeShown &&
      focusedTerminalId &&
      focusedTerminalId !== activeTerminalId &&
      terminalById.has(focusedTerminalId)
    ) {
      selectTerminal(focusedTerminalId, false);
    }
  }, [focusedTerminalId, codeShown]);

  // Agent tabs whose threads no longer exist leave the layout once a list read succeeded (else
  // they'd wait on "Connecting" forever). Ids just announced by a command are kept until the
  // list catches up with them.
  const pendingAgents = useRef(new Set<string>());
  // biome-ignore lint/correctness/useExhaustiveDependencies: reconcile on list changes only.
  useEffect(() => {
    if (!controller.ready || !providerPanes.loaded || providerPanes.error) return;
    for (const id of pendingAgents.current) if (paneById.has(id)) pendingAgents.current.delete(id);
    const gone = allContents(controller.layout)
      .filter((c) => c.kind === "agent" && !paneById.has(c.agentId) && !pendingAgents.current.has(c.agentId))
      .map(contentKey);
    if (gone.length > 0) controller.forget(new Set(gone));
  }, [paneById, controller.ready, providerPanes.loaded, providerPanes.error]);

  // Z7-W3: a Dashboard card, a notification or KalVoice asked to focus a provider pane's thread.
  usePaneFocusRequests((threadId) => {
    if (!codeShown || !controller.ready || !paneById.has(threadId)) return false;
    controller.replace(migrateAgentContents(controller.layout, new Set([threadId])));
    controller.show(agentContent(threadId), { focus: true });
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
  const [launcher, setLauncher] = useState<{
    providerId: PaneProviderId;
    paneId: string | null;
    returnToHandoff: boolean;
  } | null>(null);
  const [handoffTargetId, setHandoffTargetId] = useState<string | null>(null);
  // The id only: the dialog always reads the thread's current summary, and closes if it's gone.
  const [handoffSourceId, setHandoffSourceId] = useState<string | null>(null);
  const handoffSource = handoffSourceId ? (paneById.get(handoffSourceId)?.thread ?? null) : null;
  useEffect(() => {
    if (handoffSourceId && providerPanes.loaded && !paneById.has(handoffSourceId)) {
      setHandoffSourceId(null);
      setHandoffTargetId(null);
    }
  }, [handoffSourceId, paneById, providerPanes.loaded]);
  // One stable hand-off handler per thread, so panes don't re-render for a new closure.
  const handOffHandlers = useRef(new Map<string, () => void>());
  const handOffFor = useCallback((threadId: string) => {
    let handler = handOffHandlers.current.get(threadId);
    if (!handler) {
      handler = () => {
        setHandoffSourceId(threadId);
        setHandoffTargetId(null);
      };
      handOffHandlers.current.set(threadId, handler);
    }
    return handler;
  }, []);
  const requestContentClose = useCallback(
    (content: PaneContent) => {
      void smartClose.request([content], () => controllerRef.current.forget(new Set([contentKey(content)])));
    },
    [smartClose.request],
  );
  const closeAgentFor = useCallback(
    (threadId: string) => () => requestContentClose(agentContent(threadId)),
    [requestContentClose],
  );
  // One flag for the whole batch: the dialog can't be cancelled or resubmitted between creates.
  const [launching, setLaunching] = useState(false);
  // A fresh launcher never shows the previous launch's refusal.
  const { clearLaunchError } = providerPanes;
  const openAgentLauncher = useCallback(
    (providerId?: PaneProviderId, paneId: string | null = null) => {
      clearLaunchError();
      setLauncher({
        providerId: providerId ?? readLaunchMemory().last?.providerId ?? "claude-code",
        paneId,
        returnToHandoff: false,
      });
    },
    [clearLaunchError],
  );
  const launchAgents = useCallback(
    async ({ providerId, count, ...launch }: AgentLaunchSpec, paneId: string | null, returnToHandoff = false) => {
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
        current.show(agentContent(first), {
          focus: true,
          placement: focused && focused.tabs.length > 0 ? "split" : "tab",
        });
      } else if (created.length > 1 && first) {
        const next = arrangeContents(current.layout, created.map(agentContent));
        if (next) {
          current.replace(next, `Arranged ${created.length} agents.`);
          const shown = findContent(next, contentKey(agentContent(first)));
          if (shown) current.focusPane(shown.paneId);
        } else {
          for (const id of created) current.show(agentContent(id), { focus: id === first, placement: "tab" });
        }
      }
      // Report the completed count so reconnect/retry creates only the unfinished agents.
      if (returnToHandoff && first) setHandoffTargetId(first);
      return created.length;
    },
    [providerPanes],
  );

  // ---------- Contents ----------
  const closeTerminalTab = useCallback(
    (terminalId: string) => requestContentClose(terminalContent(terminalId)),
    [requestContentClose],
  );

  const restartById = useCallback((terminalId: string) => void restartTerminal(terminalId), [restartTerminal]);
  const [renaming, setRenaming] = useState<{ content: PaneContent; name: string } | null>(null);
  const focusMenuObject = (content: PaneContent) => {
    document.querySelector<HTMLElement>(`[data-content-key="${CSS.escape(contentKey(content))}"]`)?.focus();
  };
  const [rebinding, setRebinding] = useState<{ threadId: string; account: ProviderAccount } | null>(null);
  const [rebindBusy, setRebindBusy] = useState(false);
  const rebindSubmitting = useRef(false);
  const pendingMenuActions = useRef(new Set<string>());
  const runMenuAction = useCallback(
    (key: string, label: string, action: () => Promise<unknown>) => {
      if (pendingMenuActions.current.has(key)) return;
      pendingMenuActions.current.add(key);
      controllerRef.current.announce(label);
      void action()
        .catch((cause) => {
          toast.show({ tone: "danger", title: label, description: toKalCodeError(cause).message });
        })
        .finally(() => pendingMenuActions.current.delete(key));
    },
    [toast],
  );

  const contextMenu = useCallback(
    (content: PaneContent, paneId: string): readonly ObjectMenuItem[] => {
      if (content.kind !== "terminal" && content.kind !== "agent") return [];
      const terminal = content.kind === "terminal" ? terminalById.get(content.terminalId) : null;
      const entry = content.kind === "agent" ? paneById.get(content.agentId) : null;
      if (!terminal && !entry) return [];
      const items: ObjectMenuItem[] = [];
      const key = contentKey(content);
      if (canSplit(controllerRef.current.layout, paneId, "horizontal")) {
        items.push({
          id: "browser",
          label: "Open Browser beside",
          icon: <Globe />,
          onSelect: () => {
            controllerRef.current.split(paneId, "horizontal", browserContent());
          },
        });
      }
      const duplicateAllowed =
        workspace.available &&
        (terminal
          ? shells.some((shell) => shell.id === terminal.shellId)
          : entry &&
            providerPanes.enabled &&
            entry.thread.permissionMode !== "custom" &&
            isPaneProvider(entry.thread.providerId) &&
            (entry.thread.providerId === "claude-code" || providerPanes.offered.includes(entry.thread.providerId)));
      if (duplicateAllowed) {
        const duplicate = (placement: DuplicatePlacement) => {
          rememberDuplicatePlacement(workspace.id, placement);
          runMenuAction(`duplicate:${key}`, "Starting a new session", async () => {
            let createdContent: PaneContent;
            if (terminal) {
              const created = await client.duplicateTerminal(terminal.id, { cols: 100, rows: 30 });
              seenTerminals.current?.add(created.id);
              createdContent = terminalContent(created.id);
            } else if (entry) {
              const input = duplicatePaneInput(entry.thread);
              if (!input) return;
              const created = await providerPanes.channel.create(input);
              pendingAgents.current.add(created.id);
              createdContent = agentContent(created.id);
            } else return;
            const current = controllerRef.current;
            // An early runtime event may already have revealed the new item as a tab.
            // Move only the new identity; the source and its attachments stay untouched.
            current.forget(new Set([contentKey(createdContent)]));
            current.show(createdContent, { paneId, focus: true, placement });
            await Promise.all([refreshWorkspaces(), providerPanes.refresh()]);
          });
        };
        items.push(
          {
            id: "duplicate",
            label: "New like this",
            icon: <Copy />,
            onSelect: () => duplicate(duplicatePlacement(workspace.id)),
          },
          {
            id: "duplicate-placement",
            label: "New like this in",
            icon: <Copy />,
            children: [
              { id: "beside", label: "Pane beside this one", onSelect: () => duplicate("split") },
              { id: "tab", label: "Tab in this pane", onSelect: () => duplicate("tab") },
            ],
          },
        );
      }
      items.push({
        id: "rename",
        label: "Rename",
        icon: <PenLine />,
        onSelect: () => {
          setRenaming({ content, name: terminal?.title ?? entry?.thread.name ?? "" });
        },
      });
      if (entry) {
        const accounts = paneRebindAccounts(entry.thread, entry.info, restoredProviderAccounts ?? []);
        if (accounts.length)
          items.push({
            id: "account",
            label: "Change account",
            icon: <UserRoundCog />,
            children: accounts.map((account) => ({
              id: account.id,
              label: accountName(account),
              onSelect: () => setRebinding({ threadId: entry.thread.id, account }),
            })),
          });
      }
      items.push({
        id: "focus",
        label: "Focus",
        icon: <Focus />,
        onSelect: () => controllerRef.current.show(content, { paneId, focus: true }),
      });
      items.push({ id: "destructive", separator: true });
      const canStop =
        (terminal?.status === "running" && !terminal.shellId.startsWith("operation:")) ||
        (entry && canStopPane(entry.thread, entry.info));
      if (canStop)
        items.push({
          id: "stop",
          label: terminal ? "Stop terminal" : "Stop agent",
          icon: <Square />,
          tone: "danger",
          onSelect: () => {
            runMenuAction(`stop:${key}`, terminal ? "Stopping terminal" : "Stopping agent", async () => {
              if (terminal) {
                await client.stopTerminal(terminal.id);
                await refreshWorkspaces();
              } else if (entry) {
                providerPanes.updated(await client.stopThread(entry.thread.id));
                await providerPanes.refresh();
              }
            });
          },
        });
      items.push({
        id: "close",
        label: terminal ? "Close terminal" : "Close agent",
        icon: <X />,
        tone: "danger",
        onSelect: () => {
          if (terminal) closeTerminalTab(terminal.id);
          else if (entry) requestContentClose(agentContent(entry.thread.id));
        },
      });
      return items;
    },
    [
      terminalById,
      paneById,
      workspace,
      shells,
      providerPanes,
      runMenuAction,
      restoredProviderAccounts,
      client,
      refreshWorkspaces,
      closeTerminalTab,
      requestContentClose,
    ],
  );

  const describe = useCallback(
    (content: PaneContent): TabInfo | null => {
      if (content.kind === "browser") return { title: "Browser", glyph: <Globe />, statusText: "Web preview" };
      if (content.kind === "terminal") {
        const terminal = terminalById.get(content.terminalId);
        if (!terminal) return null;
        const running = terminal.status === "running";
        const org = orgItems.get(contentKey(content));
        // The tab's dot takes the organization badge's tone when it is known (the words stay in the
        // tooltip and the Terminal Stack, so tab names don't change); otherwise the record's own state.
        const badge = org?.status ? BADGES[org.status.badge] : null;
        return {
          title: org?.title ?? labels.get(terminal.id) ?? terminal.title,
          glyph: <ProviderGlyph provider="shell" size="xs" />,
          tone: badge?.tone ?? terminalTone(terminal),
          stateLabel: running ? undefined : "Ended",
          statusText: org?.status ? `${badge?.label} · ${org.status.detail}` : describeTerminalStatus(terminal),
          terminal: true,
          running,
          actions: running ? (
            <TerminalImageButton targetKey={terminalImageTargetKey("terminal", terminal.id)} />
          ) : undefined,
          stop: running ? { label: "End terminal", run: () => closeTerminalTab(terminal.id) } : undefined,
          onClose: () => closeTerminalTab(terminal.id),
        };
      }
      if (content.kind === "agent") {
        const entry = paneById.get(content.agentId);
        if (!entry) return null;
        const status = paneStatus(entry.thread.status);
        const account = accountFor(entry.thread);
        const name = orgItems.get(contentKey(content))?.title ?? entry.thread.name;
        return {
          title: account ? `${name} · ${paneAccountLabel(account)}` : name,
          glyph: <ProviderGlyph provider={entry.thread.providerId} size="xs" />,
          tone: status.tone,
          statusText: `${entry.thread.providerName}${account ? ` · ${paneAccountLabel(account)}` : ""} · ${status.label}`,
          terminal: true,
          running: entry.info?.running ?? false,
          actions:
            entry.info?.running && entry.info.instanceId ? (
              <TerminalImageButton targetKey={terminalImageTargetKey("agent", entry.thread.id)} />
            ) : undefined,
          attention: attention.pending.get(entry.thread.id),
          onAttentionSeen: () => attention.acknowledge(entry.thread.id),
          stateLabel:
            agentAttention(entry.thread) === "needs-you"
              ? "Needs You"
              : entry.thread.status === "completed"
                ? "Done"
                : undefined,
          onClose: () => requestContentClose(agentContent(entry.thread.id)),
        };
      }
      return null;
    },
    [terminalById, labels, paneById, closeTerminalTab, accountFor, requestContentClose, orgItems, attention],
  );

  const continueWithAccount = useCallback(
    async (threadId: string, accountId: string) => {
      const source = paneById.get(threadId)?.thread;
      const input = source ? duplicatePaneInput(source) : null;
      if (!input) throw new Error("This coding session cannot be continued with its current settings.");
      const created = await providerPanes.channel.create({ ...input, switchAccountId: accountId });
      pendingAgents.current.add(created.id);
      const content = agentContent(created.id);
      const current = controllerRef.current;
      const pane = leaves(current.layout.root).find((leaf) =>
        leaf.tabs.some((tab) => contentKey(tab) === contentKey(agentContent(threadId))),
      );
      current.forget(new Set([contentKey(content)]));
      current.show(content, { paneId: pane?.paneId, focus: true, placement: "tab" });
      // Creation succeeded. A failed list refresh must not invite a duplicate launch on retry.
      void Promise.all([refreshWorkspaces(), providerPanes.refresh()]).catch(() => undefined);
    },
    [paneById, providerPanes, refreshWorkspaces],
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
            visible={codeShown && context.visible !== false}
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
            focused={context.focused}
            focusRequest={context.focusRequest}
            codeShown={codeShown}
            visible={context.visible !== false}
            theme={theme}
            workspace={workspace}
            onRestart={restartById}
            onClose={closeTerminalTab}
          />
        );
      }
      if (content.kind === "agent") {
        const entry = paneById.get(content.agentId);
        if (!entry?.info) {
          return <AgentConnecting error={providerPanes.error} onRetry={providerPanes.refresh} />;
        }
        return (
          <ProviderPane
            thread={entry.thread}
            info={entry.info}
            channel={providerPanes.channel}
            account={accountFor(entry.thread)}
            theme={theme}
            focusRequest={context.focusRequest}
            visible={context.visible !== false && codeShown}
            closePending={smartClose.pending !== null}
            throttled={!context.focused || !codeShown}
            onChanged={providerPanes.updated}
            onContinue={continueWithAccount}
            onHandOff={handOffFor(entry.thread.id)}
            onClose={closeAgentFor(entry.thread.id)}
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
      restartById,
      closeTerminalTab,
      providerPanes,
      codeShown,
      accountFor,
      browserBridge,
      handOffFor,
      closeAgentFor,
      continueWithAccount,
      smartClose.pending,
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
    const list: BackgroundItem[] = [];
    for (const t of terminals) {
      const content = terminalContent(t.id);
      if (t.status === "running" && !shown.has(contentKey(content)))
        list.push({ content, title: titleOf(content), tone: "working" });
    }
    for (const p of providerPanes.panes) {
      const content = agentContent(p.thread.id);
      if (p.info?.running && !shown.has(contentKey(content)))
        list.push({ content, title: titleOf(content), tone: paneStatus(p.thread.status).tone });
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
        onTerminal={() => newTerminal(null)}
        onProviderPane={() => openAgentLauncher(undefined, paneId)}
        onShow={(content) => controllerRef.current.show(content, { paneId, focus: true })}
      />
    ),
    [shell, providerPanes, background, newTerminal, openAgentLauncher],
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
                  item.content.kind === "agent" ? (
                    <ProviderGlyph
                      provider={paneById.get(item.content.agentId)?.thread.providerId ?? "claude-code"}
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
      if (command.kind === "agent-browser-beside") {
        const content = agentContent(command.threadId);
        const target = findContent(current.layout, contentKey(content))?.paneId ?? current.focusedPaneId;
        if (!target || !canSplit(current.layout, target, "horizontal")) {
          return { handled: false, message: "There isn't room for another pane in this layout." };
        }
        current.show(content, { paneId: target, focus: false });
        current.split(target, "horizontal", browserContent());
        return { handled: true };
      }
      if (command.kind === "open-agent-launcher") {
        if (!providerPanes.enabled) return { handled: false, message: "Coding agents aren't available in this build." };
        const providerId = command.providerId;
        openAgentLauncher(providerId && isPaneProvider(providerId) ? providerId : undefined);
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
      if (command.kind === "open" && command.content.kind === "thread") {
        if (paneById.has(command.content.threadId)) {
          controllerRef.current.show(agentContent(command.content.threadId), { focus: true });
        } else {
          navigate("threads");
          threadsIntent.request("open", command.content.threadId);
        }
        return { handled: true };
      }
      if (command.kind === "arrange-providers") {
        const selected = selectDistinctProviderThreads(
          command.providerIds,
          providerPanes.panes.map((entry) => ({ threadId: entry.thread.id, providerId: entry.thread.providerId })),
        );
        const found = selected.threadIds.map(agentContent);
        if (found.length === 0) {
          return { handled: false, message: "None of those providers has a pane in this workspace yet." };
        }
        const [first, ...rest] = found;
        // `current` is a snapshot: its focus doesn't follow show() or split(). Start from where
        // `first` lands (its existing pane, else the focused one) and put each next provider
        // beside the previous one, so they come out in order.
        let target: string | null = null;
        if (first) {
          target = findContent(current.layout, contentKey(first))?.paneId ?? current.focusedPaneId;
          current.show(first, { focus: true });
        }
        for (const content of rest) {
          if (!target) break;
          target = current.split(target, command.axis, content) ?? target;
        }
        return selected.missing.length > 0
          ? { handled: true, message: `Arranged the available panes. No pane yet for ${selected.missing.join(", ")}.` }
          : { handled: true };
      }
      if (command.kind === "open-provider-panes") {
        const threadIds = [...new Set(command.threadIds.filter((threadId) => threadId.trim().length > 0))];
        if (threadIds.length === 0) return { handled: false, message: "No provider panes were created." };
        const next = arrangeContents(current.layout, threadIds.map(agentContent));
        if (!next) {
          return { handled: false, message: "There isn't room to show every new provider pane." };
        }
        for (const id of threadIds) if (!paneById.has(id)) pendingAgents.current.add(id);
        current.replace(next, `Arranged ${threadIds.length} provider ${threadIds.length === 1 ? "pane" : "panes"}.`);
        const first = findContent(next, contentKey(agentContent(threadIds[0] as string)));
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
          return content
            ? {
                title: titleOf(content),
                aliases: providerPaneAliasesOf(aliases, content),
              }
            : null;
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
    () => ({ describe, render, renderEmpty, addMenu, onCommand, contextMenu }),
    [describe, render, renderEmpty, addMenu, onCommand, contextMenu],
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
    <CanvasSkeleton label="Loading the layout" />
  );

  const applyTaskLayout = useCallback((task: TaskLayout) => {
    const current = controllerRef.current;
    const contents = allContents(current.layout);
    const companions: PaneContent[] = [];
    if (task === "build" || task === "debug")
      companions.push(contents.find((content) => content.kind === "browser") ?? browserContent());
    if (task === "debug" || task === "ship") companions.push({ kind: "widget", widgetId: "activity" });
    current.taskLayout(task, companions);
  }, []);
  const layoutSuggestion = useMemo(
    () =>
      suggestTask(
        controller.layout,
        terminals.some(
          (terminal) => terminal.status === "exited" && terminal.exitCode !== null && terminal.exitCode !== 0,
        ),
      ),
    [controller.layout, terminals],
  );
  const api = useMemo<CodeCanvasApi>(
    () => ({
      controller,
      background,
      providerPanes,
      shells,
      newTerminal,
      openAgentLauncher,
      titleOf,
      applyTaskLayout,
      layoutSuggestion,
      organization,
    }),
    [
      controller,
      background,
      providerPanes,
      shells,
      newTerminal,
      openAgentLauncher,
      titleOf,
      applyTaskLayout,
      layoutSuggestion,
      organization,
    ],
  );

  return (
    <>
      <SmartCloseDialog close={smartClose} />
      <UtilityDockRegistration />
      <CodeContextOperationsRegistration />
      {children(api, canvas)}
      {renaming && (renaming.content.kind === "terminal" || renaming.content.kind === "agent") ? (
        <RenamePaneDialog
          name={renaming.name}
          returnFocus={() => focusMenuObject(renaming.content)}
          kind={renaming.content.kind}
          onClose={() => setRenaming(null)}
          onSave={async (name) => {
            if (renaming.content.kind === "terminal") {
              await client.renameTerminal(renaming.content.terminalId, name);
              await refreshWorkspaces();
            } else if (renaming.content.kind === "agent") {
              providerPanes.updated(await client.renameThread(renaming.content.agentId, name));
            }
          }}
        />
      ) : null}
      {rebinding ? (
        <RebindThreadDialog
          objectKind="agent"
          returnFocus={() => focusMenuObject(agentContent(rebinding.threadId))}
          open
          from={paneById.get(rebinding.threadId)?.thread.accountLabel ?? "Default account"}
          to={accountName(rebinding.account)}
          busy={rebindBusy}
          blocker={(() => {
            const entry = paneById.get(rebinding.threadId);
            return !entry?.info || entry.info.running
              ? "Stop this coding agent before changing its account."
              : rebindBlocker(entry.thread);
          })()}
          signInRequired={false}
          onSignIn={() => {}}
          onCancel={() => setRebinding(null)}
          onConfirm={() => {
            if (rebindSubmitting.current) return;
            rebindSubmitting.current = true;
            setRebindBusy(true);
            runMenuAction(`rebind:${rebinding.threadId}`, "Changing agent account", async () => {
              try {
                providerPanes.updated(await client.rebindThreadAccount(rebinding.threadId, rebinding.account.id));
                setRebinding(null);
              } finally {
                rebindSubmitting.current = false;
                setRebindBusy(false);
              }
            });
          }}
        />
      ) : null}
      {handoffSource ? (
        <HandOffDialog
          open={launcher?.returnToHandoff !== true}
          source={handoffSource}
          preferredTargetId={handoffTargetId}
          onNewAgent={() => {
            clearLaunchError();
            setLauncher({ providerId: "claude-code", paneId: null, returnToHandoff: true });
          }}
          onClose={() => {
            setHandoffSourceId(null);
            setHandoffTargetId(null);
          }}
        />
      ) : null}
      {launcher ? (
        <NewAgentDialog
          workspace={workspace}
          offered={providerPanes.offered}
          initialProvider={launcher.providerId}
          busy={launching || providerPanes.creating}
          error={providerPanes.error}
          fixedCount={launcher.returnToHandoff ? 1 : undefined}
          purpose={launcher.returnToHandoff ? "handoff" : "standard"}
          onLaunch={(spec) => launchAgents(spec, launcher.paneId, launcher.returnToHandoff)}
          onNewTerminal={
            launcher.returnToHandoff
              ? undefined
              : () => {
                  if (launcher.paneId) controllerRef.current.focusPane(launcher.paneId, false);
                  newTerminal(null);
                }
          }
          onOpenBrowser={
            launcher.returnToHandoff
              ? undefined
              : () =>
                  controllerRef.current.show(browserContent(), {
                    ...(launcher.paneId ? { paneId: launcher.paneId } : { placement: "split" as const }),
                    focus: true,
                  })
          }
          onClose={() => setLauncher(null)}
        />
      ) : null}
    </>
  );
}

/**
 * A terminal in a pane: its view, and the restart / ended states (Z1). Memoized: the canvas
 * re-renders on every layout change, a terminal only when its own state changes.
 */
const TerminalPanel = memo(function TerminalPanel({
  terminal,
  label,
  focused,
  focusRequest,
  codeShown,
  visible,
  theme,
  workspace,
  onRestart,
  onClose,
}: {
  terminal: TerminalInfo;
  label: string;
  focused: boolean;
  focusRequest: number;
  codeShown: boolean;
  visible: boolean;
  theme: "light" | "dark";
  workspace: Workspace;
  onRestart: (terminalId: string) => void;
  onClose: (terminalId: string) => void;
}) {
  if (terminal.status === "ended_by_app") {
    return (
      <div className={styles.panelMessage} data-status={terminal.status}>
        <EmptyState
          headingLevel={2}
          framed={false}
          align="center"
          art={<PowerOff />}
          title="This terminal ended when KalCode closed"
          actions={
            <>
              <Button variant="primary" icon={<RotateCcw />} onClick={() => onRestart(terminal.id)}>
                Restart
              </Button>
              <Button variant="ghost" icon={<X />} onClick={() => onClose(terminal.id)}>
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
  const failed = terminal.status === "exited" && terminal.exitCode !== 0 && terminal.exitCode !== null;
  const ended = `${describeTerminalStatus(terminal)}${terminal.exitCode === 0 ? "." : ""}`;
  return (
    <div className={styles.paneTerminal} data-status={terminal.status}>
      <TerminalView
        key={`${terminal.id}:${terminal.startedAt ?? ""}`}
        terminal={terminal}
        label={label}
        visible={visible && codeShown}
        focusRequest={focusRequest}
        theme={theme}
        throttled={!focused || !codeShown}
      />
      {terminal.status === "exited" ? (
        <div className={styles.endedBar} role="status" data-tone={failed ? "failed" : "muted"}>
          <span className={styles.endedDot} aria-hidden="true" />
          <span className={styles.endedText} title={ended}>
            {ended}
          </span>
          <span className={styles.endedActions}>
            <Button size="sm" variant="primary" icon={<RotateCcw />} onClick={() => onRestart(terminal.id)}>
              Restart
            </Button>
            <Button size="sm" variant="ghost" onClick={() => onClose(terminal.id)}>
              Close tab
            </Button>
          </span>
        </div>
      ) : null}
    </div>
  );
});

/** Until a coding agent's terminal connects: a quiet spinner first, Retry only when it's needed. */
function AgentConnecting({ error, onRetry }: { error: string | null; onRetry: () => Promise<void> }) {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setSlow(true), RETRY_AFTER_MS);
    return () => clearTimeout(timer);
  }, []);
  const stuck = error !== null || slow;
  return (
    <PaneNotice
      icon={stuck ? <LayoutPanelLeft /> : <span className={styles.spinner} />}
      title={stuck ? "Connecting to agent terminal" : "Connecting…"}
      actions={
        stuck ? (
          <Button size="sm" icon={<RotateCcw />} onClick={() => void onRetry()}>
            Retry connection
          </Button>
        ) : undefined
      }
    >
      <p>
        {error ??
          (stuck ? "The coding session's terminal is taking longer than usual." : "Starting the agent's terminal.")}
      </p>
    </PaneNotice>
  );
}

/** An empty pane: what can be opened here, the signature action first. */
function EmptyPane({
  shell,
  providerPanes,
  background,
  onTerminal,
  onProviderPane,
  onShow,
}: {
  shell: ShellOption | null;
  providerPanes: ProviderPanes;
  background: BackgroundItem[];
  onTerminal: () => void;
  onProviderPane: () => void;
  onShow: (content: PaneContent) => void;
}) {
  const agents = providerPanes.enabled;
  return (
    <div className={styles.emptyPane}>
      <div className={styles.emptyInner}>
        <span className={styles.emptyPaneArt} aria-hidden="true">
          <LayoutPanelLeft />
        </span>
        <div className={styles.emptyHead}>
          <h2 className={styles.emptyTitle}>Empty pane</h2>
          <p className={styles.emptyText}>
            {agents ? "Start an agent, a terminal or the browser here." : "Start a terminal or the browser here."}
          </p>
        </div>
        <div className={styles.emptyActions}>
          {agents ? (
            <Button variant="primary" size="sm" icon={<Bot />} busy={providerPanes.creating} onClick={onProviderPane}>
              <span className={styles.buttonLabel}>Launch an agent</span>
            </Button>
          ) : null}
          <Button
            variant={agents ? "secondary" : "primary"}
            size="sm"
            icon={<SquareTerminal />}
            onClick={onTerminal}
            disabled={!shell}
          >
            <span className={styles.buttonLabel}>{shell ? `New ${shell.name} terminal` : "No shells found"}</span>
          </Button>
          <Button variant="ghost" size="sm" icon={<Globe />} onClick={() => onShow(browserContent())}>
            <span className={styles.buttonLabel}>Open Browser</span>
          </Button>
        </div>
        {background.length > 0 ? (
          <div className={styles.emptyGroup}>
            <h3 className={styles.emptyLabel}>Running in the background</h3>
            <ul className={styles.emptyList}>
              {background.slice(0, 6).map((item) => (
                <li key={contentKey(item.content)}>
                  <button type="button" className={styles.emptyItem} onClick={() => onShow(item.content)}>
                    <span className={styles.emptyDot} data-tone={item.tone} aria-hidden="true" />
                    <span className={styles.emptyItemTitle}>{item.title}</span>
                    <span className={styles.emptyItemAction}>Show</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        <p className={styles.emptyHint} aria-hidden="true">
          <span>
            <kbd>{PANE_SHORTCUT_LABELS.splitRight}</kbd> split
          </span>
          <span>
            <kbd>{CODE_SHORTCUT_LABELS["new-terminal"]}</kbd> terminal
          </span>
        </p>
      </div>
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
