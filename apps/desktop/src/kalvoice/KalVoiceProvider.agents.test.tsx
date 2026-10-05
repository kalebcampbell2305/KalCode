import type { KalVoiceSignal, ThreadStatus, ThreadSummary, UiDirective } from "@kalcode/protocol";
import { act, render, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { KalVoiceProvider, useKalVoice } from "./KalVoiceProvider.tsx";

/**
 * Agent status by voice (owner directive 2026-10-04): native KalVoice answers with the shared
 * agent filter and KalTidy's idle-agent close, and the window applies them for every provider.
 */
const mocks = vi.hoisted(() => {
  const talk = vi.fn();
  const client = {
    subscribeKalVoice: vi.fn(),
    renewKalVoiceSubscription: vi.fn().mockResolvedValue(undefined),
    kalvoiceStatus: vi.fn().mockResolvedValue(null),
    kalvoiceLatencyRecord: vi.fn().mockResolvedValue(undefined),
    kalvoiceListenCancel: vi.fn().mockResolvedValue(undefined),
    kalvoiceTalk: talk,
    kalvoiceRequest: vi.fn(),
    kalvoiceMeterUiCommand: vi.fn(),
    listThreads: vi.fn(),
    archiveThread: vi.fn(),
    stopThread: vi.fn(),
  };
  return {
    signal: null as ((signal: KalVoiceSignal) => void) | null,
    talk,
    client,
    intents: { focus: vi.fn(), filterAgents: vi.fn() },
    navigate: vi.fn(),
    toast: { show: vi.fn() },
  };
});
vi.mock("../runtime/RuntimeProvider.tsx", () => ({ useRuntime: () => ({ client: mocks.client }) }));
vi.mock("../runtime/WorkspaceProvider.tsx", () => ({ useWorkspaces: () => ({ active: { id: "workspace" } }) }));
vi.mock("../runtime/uiIntents.tsx", () => ({ useUiIntents: () => mocks.intents }));
vi.mock("../shell/navigation.tsx", () => ({ useNavigation: () => ({ current: "code", navigate: mocks.navigate }) }));
vi.mock("../shell/rail/search/SearchProvider.tsx", () => ({ useOptionalSearch: () => null }));
vi.mock("../surfaces/permissions/index.ts", () => ({ usePermissions: () => ({}) }));
vi.mock("@kalcode/ui/components", () => ({ useToast: () => mocks.toast }));

function Probe() {
  const voice = useKalVoice();
  return (
    <output data-testid="kalvoice-state">
      {voice.state.phase}: {voice.state.message}
    </output>
  );
}

let n = 0;
function agent(providerId: string, status: ThreadStatus, overrides: Partial<ThreadSummary> = {}): ThreadSummary {
  n += 1;
  return {
    id: `01999a4e-0002-7${String(n).padStart(3, "0")}-8a2e-${String(n).padStart(12, "0")}`,
    name: `Agent ${n}`,
    providerId,
    providerName: providerId,
    model: null,
    effort: null,
    providerAccountId: null,
    accountLabel: null,
    workspaceId: "workspace",
    workspaceName: "kalcode",
    permissionMode: "approve",
    status,
    currentActivity: null,
    createdAt: "2026-10-04T08:00:00.000Z",
    lastActivityAt: "2026-10-04T09:00:00.000Z",
    pendingApprovals: 0,
    unreadMessages: 0,
    filesChanged: null,
    branch: null,
    error: null,
    archivedAt: null,
    resumable: false,
    permissionProfileId: null,
    runtimeKind: "interactive_pty",
    terminalId: null,
    worktreeId: null,
    ...overrides,
  };
}

function answers(summary: string, directive: UiDirective) {
  mocks.talk.mockImplementation(async (request: { requestId: string }) => ({
    route: "command",
    recognizedMs: 1,
    response: {
      requestId: request.requestId,
      intent: directive.kind,
      outcome: { kind: "completed", summary },
      usage: { used: 1, allowance: null, periodStart: "", resetsAt: "" },
      counted: true,
      directive,
    },
  }));
}

async function start() {
  const view = render(
    <KalVoiceProvider>
      <Probe />
    </KalVoiceProvider>,
  );
  await waitFor(() => expect(mocks.signal).not.toBeNull());
  return view;
}

async function say(text: string) {
  act(() => mocks.signal?.({ kind: "listening_started", sessionId: "capture", mode: "talk" }));
  await act(async () =>
    mocks.signal?.({
      kind: "result",
      timings: {
        keyDownToMic: null,
        speechToPartial: null,
        keyUpToFinal: null,
        finalToRecognized: null,
        recognizedToAction: null,
        finalSource: null,
      },
      result: { kind: "transcript", sessionId: "capture", mode: "talk", text, durationMs: 500 },
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.signal = null;
  mocks.client.subscribeKalVoice.mockImplementation(async (signal) => {
    mocks.signal = signal;
    return () => undefined;
  });
  mocks.client.archiveThread.mockImplementation(async (id: string) => ({ id }));
  mocks.client.listThreads.mockResolvedValue([]);
});

it("shows the Agents tab filtered by the shared status, and by a provider only when one was named", async () => {
  await start();
  answers("2 agents need you.", { kind: "filter_agents", filter: "needs_you", providerId: null });
  await say("show me all agents that need me");
  await waitFor(() => expect(mocks.intents.filterAgents).toHaveBeenLastCalledWith("needs_you", null));

  answers("1 Codex agent needs you.", { kind: "filter_agents", filter: "needs_you", providerId: "codex" });
  await say("show my codex agents that need me");
  await waitFor(() => expect(mocks.intents.filterAgents).toHaveBeenLastCalledWith("needs_you", "codex"));

  answers("Showing 1 failed agent.", { kind: "filter_agents", filter: "failed", providerId: null });
  await say("which agent failed");
  await waitFor(() => expect(mocks.intents.filterAgents).toHaveBeenLastCalledWith("failed", null));
});

it("closes only idle agents of every provider through KalTidy's canonical removal", async () => {
  const claudeWorking = agent("claude-code", "running_command");
  const codexIdle = agent("codex", "idle");
  const cursorReady = agent("cursor", "idle", { currentActivity: "Ready for a task" });
  const geminiNeedsYou = agent("gemini-cli", "waiting_for_user");
  const cursorLastTurnFailed = agent("cursor", "idle", { currentActivity: "Last turn failed" });
  const geminiPaused = agent("gemini-cli", "paused");
  const chatIdle = agent("codex", "idle", { runtimeKind: "headless" });
  mocks.client.listThreads.mockResolvedValue([
    claudeWorking,
    codexIdle,
    cursorReady,
    geminiNeedsYou,
    cursorLastTurnFailed,
    geminiPaused,
    chatIdle,
  ]);
  const view = await start();
  answers("Closing 2 idle agents with KalTidy.", { kind: "close_idle_agents", providerId: null });
  await say("stop all idle agents");
  await waitFor(() => expect(view.getByTestId("kalvoice-state")).toHaveTextContent("Closed 2 idle agents."));
  expect(mocks.client.archiveThread.mock.calls.map(([id]) => id).sort()).toEqual([codexIdle.id, cursorReady.id].sort());
  // Nothing was stopped: a working, waiting or paused agent of any provider keeps running.
  expect(mocks.client.stopThread).not.toHaveBeenCalled();
});

it("closes the named provider's idle agents only", async () => {
  const codexIdle = agent("codex", "idle");
  const cursorIdle = agent("cursor", "idle");
  mocks.client.listThreads.mockResolvedValue([codexIdle, cursorIdle]);
  const view = await start();
  answers("Closing 1 idle Cursor agent with KalTidy.", { kind: "close_idle_agents", providerId: "cursor" });
  await say("close all idle cursor agents");
  await waitFor(() => expect(view.getByTestId("kalvoice-state")).toHaveTextContent("Closed 1 idle agent."));
  expect(mocks.client.archiveThread).toHaveBeenCalledOnce();
  expect(mocks.client.archiveThread).toHaveBeenCalledWith(cursorIdle.id);
});
