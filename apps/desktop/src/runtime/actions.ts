/**
 * KalCode's canonical actions. Buttons, menus, the command palette, the Needs You inbox and
 * KalVoice's renderer directives all run the same intent through the same function here, so an
 * action behaves identically however the person asked for it:
 *
 *   intent → resolved target → execution → visible result
 *
 * Each action resolves its target from canonical state (the coding agents, the permission engine,
 * the notification center) and either executes or, when the target is genuinely ambiguous, shows
 * the person the short list to choose from — never a guess. Navigation goes through `uiIntents`
 * (which focuses an agent's real Code terminal) and the pane command bus; nothing here keeps state.
 */
import { agentStateOf, type ThreadSummary } from "@kalcode/protocol";
import { useToast } from "@kalcode/ui/components";
import { useCallback, useMemo } from "react";
import { toKalCodeError } from "../ipc/errors.ts";
import { focusOperationsTarget, type OperationsVoiceTarget } from "../kalvoice/sceneOperations.ts";
import type { AttentionAction, AttentionItem } from "../shell/attention/model.ts";
import { dismissAttention } from "../shell/attention/useAttention.ts";
import { type Destination, useNavigation } from "../shell/navigation.tsx";
import { useOptionalNotifications } from "../shell/notifications/NotificationsProvider.tsx";
import { useStartAgents } from "../surfaces/code/useLaunchAgent.ts";
import { useAgentWorktreeStates, useCodingAgents } from "../surfaces/dashboard/data/DashboardData.tsx";
import { focusChain } from "./chains/focus.ts";
import { allowOverlap } from "./ownership/allowed.ts";
import { useRuntime } from "./RuntimeProvider.tsx";
import { useUiIntents } from "./uiIntents.tsx";

/** What an action did, for the caller to show (KalVoice speaks it; buttons rarely need it). */
export interface ActionResult {
  ok: boolean;
  message: string;
}

export interface KalActions {
  /** Focus an agent's real coding terminal in Code. */
  openAgent: (agent: { agentId: string; workspaceId: string }) => Promise<ActionResult>;
  /** Run a failed agent again (the same command as its card's Retry). */
  retryAgent: (agentId: string) => Promise<ActionResult>;
  /**
   * "Show the one waiting": focuses the agent that needs the person. Several waiting is the one
   * ambiguous case: it shows exactly those agents to choose from.
   */
  showWaiting: () => Promise<ActionResult>;
  /**
   * Start coding agents in the current project: Code's New agent (one click starts the remembered
   * provider, account, exact model and effort; the launcher opens only when a choice is needed).
   */
  newAgent: (options?: { providerId?: string; count?: number }) => ActionResult;
  openApprovals: () => Promise<ActionResult>;
  signIn: (providerId: string) => Promise<ActionResult>;
  /** Open Activity and bring one handoff chain into view (its Chains section reads the focus). */
  openChain: (chainId: string) => ActionResult;
  /** Open the Needs You inbox. */
  openInbox: () => ActionResult;
  open: (destination: Destination) => ActionResult;
  /** Runs one of an attention item's actions. */
  runAttention: (item: AttentionItem, action: AttentionAction) => Promise<ActionResult>;
}

const done = (message: string): ActionResult => ({ ok: true, message });

export type OperationAttentionAction = Extract<AttentionAction, { id: "open-operation" }>;

/** Maps an inbox action to the same exact Operations target used by KalVoice and Favorites. */
export function operationFocusTarget(action: OperationAttentionAction): OperationsVoiceTarget {
  return action.tab === "queue"
    ? {
        kind: "queue",
        tab: "queue",
        runId: action.operationId,
        workspaceId: action.workspaceId,
        label: action.operationName,
      }
    : {
        kind: "run",
        tab: "runs",
        runId: action.operationId,
        workspaceId: action.workspaceId,
        label: action.operationName,
      };
}

/** Navigate first so the view can mount, then focus the exact canonical row/detail. */
export async function focusAttentionOperation(
  action: OperationAttentionAction,
  navigate: (destination: Destination) => void,
  focus: (target: OperationsVoiceTarget) => Promise<boolean> | boolean = focusOperationsTarget,
): Promise<ActionResult> {
  navigate("operations");
  const focused = await focus(operationFocusTarget(action));
  return focused
    ? done(action.tab === "queue" ? "Opened the queued work." : "Opened the run.")
    : { ok: false, message: "Operations opened, but that work is no longer visible." };
}

/** The waiting agents, most recent first. Pure: also used by tests and KalVoice copy. */
export function waitingAgents(agents: readonly ThreadSummary[]): ThreadSummary[] {
  return agents
    .filter((a) => a.archivedAt === null && agentStateOf(a) === "needs_you")
    .sort((a, b) => Date.parse(b.lastActivityAt) - Date.parse(a.lastActivityAt));
}

export function useKalActions(): KalActions {
  const intents = useUiIntents();
  const { navigate } = useNavigation();
  const { client } = useRuntime();
  const toast = useToast();
  const notifications = useOptionalNotifications();
  const closeInbox = useCallback(() => notifications?.setPanelOpen(false), [notifications]);
  const startAgents = useStartAgents();
  const { state: agentState, reload: reloadAgents } = useCodingAgents();
  const agents = agentState.status === "ready" ? agentState.data : null;
  const { reload: reloadOwnership } = useAgentWorktreeStates();

  const openAgent = useCallback(
    async ({ agentId, workspaceId }: { agentId: string; workspaceId: string }) => {
      await intents.focus({ kind: "agent", agentId, workspaceId });
      return done("Opened the agent.");
    },
    [intents],
  );

  const retryAgent = useCallback(
    async (agentId: string) => {
      try {
        await client.resumeThread(agentId);
        return done("Retrying.");
      } catch (raw) {
        const error = toKalCodeError(raw);
        toast.show({ tone: "danger", title: "Couldn't retry the agent", description: error.message });
        return { ok: false, message: error.message };
      }
    },
    [client, toast],
  );

  const showWaiting = useCallback(async () => {
    const waiting = waitingAgents(agents ?? []);
    const [only] = waiting;
    if (waiting.length === 1 && only) {
      await intents.focus({ kind: "agent", agentId: only.id, workspaceId: only.workspaceId });
      return done(`Opened ${only.name}.`);
    }
    if (waiting.length === 0) return done("No agent is waiting for you.");
    intents.filterAgents("needs_you");
    return done(`${waiting.length} agents are waiting. Pick one.`);
  }, [agents, intents]);

  const newAgent = useCallback(
    (options?: { providerId?: string; count?: number }) => {
      startAgents(options);
      const count = options?.count ?? 1;
      return done(count === 1 ? "Starting a new agent." : `Starting ${count} agents.`);
    },
    [startAgents],
  );

  const openApprovals = useCallback(async () => {
    await intents.focus({ kind: "approvals" });
    return done("Opened approvals.");
  }, [intents]);

  const signIn = useCallback(
    async (providerId: string) => {
      await intents.focus({ kind: "provider", providerId });
      return done("Opened the provider's sign-in.");
    },
    [intents],
  );

  const openInbox = useCallback(() => {
    if (!notifications) return { ok: false, message: "Needs you isn't available here." };
    notifications.setPanelOpen(true);
    return done("Opened Needs you.");
  }, [notifications]);

  const open = useCallback(
    (destination: Destination) => {
      navigate(destination);
      return done("Opened.");
    },
    [navigate],
  );

  const openChain = useCallback(
    (chainId: string) => {
      navigate("dashboard");
      focusChain(chainId);
      return done("Opened the chain.");
    },
    [navigate],
  );

  const openOperation = useCallback(
    async (action: OperationAttentionAction) => {
      const result = await focusAttentionOperation(action, navigate);
      if (!result.ok) {
        toast.show({ tone: "danger", title: "Couldn't focus that work", description: result.message });
      }
      return result;
    },
    [navigate, toast],
  );

  const runAttention = useCallback(
    async (item: AttentionItem, action: AttentionAction): Promise<ActionResult> => {
      switch (action.id) {
        case "open-agent":
          closeInbox();
          return openAgent(action);
        case "retry-agent":
          return retryAgent(action.agentId);
        case "open-operation":
          closeInbox();
          return openOperation(action);
        case "open-chain":
          closeInbox();
          return openChain(action.chainId);
        case "open-operations":
          closeInbox();
          return open("operations");
        case "retry-agents":
          reloadAgents();
          return done("Checking agents again.");
        case "retry-ownership":
          reloadOwnership();
          return done("Checking file ownership again.");
        case "allow-overlap":
          allowOverlap(action.overlapKey, action.files, action.risk);
          return done("Allowed. Both agents can keep editing; you'll be warned if it grows.");
        case "open-approvals":
          closeInbox();
          return openApprovals();
        case "sign-in":
          closeInbox();
          return signIn(action.providerId);
        case "dismiss":
          dismissAttention(item.key);
          return done("Dismissed.");
      }
    },
    [
      closeInbox,
      openAgent,
      retryAgent,
      openOperation,
      openChain,
      reloadAgents,
      reloadOwnership,
      openApprovals,
      signIn,
      open,
    ],
  );

  return useMemo(
    () => ({
      openAgent,
      retryAgent,
      showWaiting,
      newAgent,
      openApprovals,
      signIn,
      openChain,
      openInbox,
      open,
      runAttention,
    }),
    [openAgent, retryAgent, showWaiting, newAgent, openApprovals, signIn, openChain, openInbox, open, runAttention],
  );
}
