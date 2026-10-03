import type {
  DevelopmentService,
  KalVoiceResponse,
  OperationRecord,
  OperationSpec,
  OperationsSnapshot,
  ThreadSummary,
} from "@kalcode/protocol";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { INITIAL_STATE, reduce } from "./assistantState.ts";
import { registerDictationSink } from "./dictation.ts";
import { KalVoiceProvider, useKalVoice } from "./KalVoiceProvider.tsx";
import { SessionChoicePanel } from "./SessionChoicePanel.tsx";

const mocks = vi.hoisted(() => {
  const makeFeed = () => {
    let events: unknown[] = [];
    const listeners = new Set<() => void>();
    return {
      getSnapshot: () => ({ events }),
      subscribe(listener: () => void) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      push(event: unknown) {
        events = [event, ...events];
        for (const listener of listeners) listener();
      },
    };
  };
  const invoke = vi.fn();
  const request = vi.fn<() => Promise<KalVoiceResponse>>();
  const talk = vi.fn();
  const client = {
    subscribeKalVoice: vi.fn().mockResolvedValue(() => undefined),
    renewKalVoiceSubscription: vi.fn().mockResolvedValue(undefined),
    kalvoiceStatus: vi.fn(),
    kalvoiceLatencyRecord: vi.fn().mockResolvedValue(undefined),
    listThreads: vi.fn(),
    getThread: vi.fn(),
    locatorSearch: vi.fn(),
    kalvoiceRequest: request,
    kalvoiceMeterUiCommand: vi.fn(async (r: { requestId: string; command: string }) => ({
      requestId: r.requestId,
      intent: `ui_${r.command}`,
      outcome: { kind: "completed", summary: "" },
      usage: { used: 1, allowance: 25, periodStart: "2026-10-01T00:00:00.000Z", resetsAt: "2026-11-01T00:00:00.000Z" },
      counted: true,
      directive: null,
    })),
    kalvoiceTalk: talk,
    kalvoiceListenCancel: vi.fn().mockResolvedValue(undefined),
    transport: { invoke },
  };
  const runtime = { client, feed: makeFeed() };
  return {
    navigate: vi.fn(),
    focusIntent: vi.fn().mockResolvedValue(undefined),
    focusOperations: vi.fn(async () => true),
    activateWorkspace: vi.fn().mockResolvedValue(true),
    selectTerminal: vi.fn(),
    invoke,
    request,
    talk,
    client,
    runtime,
    makeFeed,
    signal: null as ((signal: unknown) => void) | null,
    toast: { show: vi.fn() },
  };
});

vi.mock("../runtime/RuntimeProvider.tsx", () => ({
  useRuntime: () => mocks.runtime,
}));
vi.mock("../runtime/WorkspaceProvider.tsx", () => ({
  useWorkspaces: () => ({
    active: { id: "workspace-kalcode" },
    workspaces: [
      {
        id: "workspace-kalcode",
        name: "KalCode",
        rootPath: "C:/redacted",
        displayPath: "~/KalCode",
        createdAt: "2026-10-01T09:00:00.000Z",
        lastOpenedAt: "2026-10-01T10:00:00.000Z",
        activeTerminalId: null,
        available: true,
      },
    ],
    terminals: [],
    running: [],
    activate: mocks.activateWorkspace,
    selectTerminal: mocks.selectTerminal,
  }),
}));
vi.mock("../runtime/uiIntents.tsx", () => ({ useUiIntents: () => ({ focus: mocks.focusIntent }) }));
vi.mock("../shell/navigation.tsx", () => ({
  useNavigation: () => ({ current: "dashboard", navigate: mocks.navigate }),
}));
vi.mock("../shell/rail/search/SearchProvider.tsx", () => ({ useOptionalSearch: () => null }));
vi.mock("../surfaces/permissions/index.ts", () => ({ usePermissions: () => ({}) }));
vi.mock("@kalcode/ui/components", () => ({
  useToast: () => mocks.toast,
  Button: ({ children, onClick }: { children: ReactNode; onClick?: () => void }) => (
    <button type="button" onClick={onClick}>
      {children}
    </button>
  ),
}));
vi.mock("./sceneOperations.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./sceneOperations.ts")>();
  return { ...actual, focusOperationsTarget: mocks.focusOperations };
});

const operationSpec = (name: string): OperationSpec => ({
  name,
  workspaceId: "workspace-kalcode",
  kind: "test",
  command: "pnpm test",
  prompt: null,
  providerId: null,
  providerAccountId: null,
  model: null,
  effort: null,
  dependencies: [],
  priority: 0,
  lane: "next",
  environment: "local",
  urls: [],
  envKeys: [],
});

function operation(
  id: string,
  name: string,
  status: OperationRecord["status"],
  endedAt: string | null,
): OperationRecord {
  return {
    id,
    spec: operationSpec(name),
    source: "operations",
    status,
    workspaceName: "KalCode",
    branch: "main",
    version: null,
    accountLabel: null,
    terminalId: null,
    threadId: null,
    createdAt: "2026-10-01T10:00:00.000Z",
    startedAt: "2026-10-01T10:01:00.000Z",
    endedAt,
    currentAction: status === "running" ? "Running tests" : null,
    outcome: status === "failed" ? "Tests failed" : status === "succeeded" ? "Tests passed" : null,
    position: 0,
    blockers: [],
  };
}

function service(id: string, name: string): DevelopmentService {
  return {
    id,
    runId: `run-${id}`,
    name,
    status: "running",
    pid: 100,
    processName: name.toLowerCase().replaceAll(" ", "-"),
    uptimeSeconds: 60,
    ports: [3000],
    urls: ["http://localhost:3000"],
    workspaceId: "workspace-kalcode",
    workspaceName: "KalCode",
    terminalId: `terminal-${id}`,
    canStop: true,
    canRestart: true,
    actionReason: null,
  };
}

const SNAPSHOT: OperationsSnapshot = {
  revision: 4,
  paused: false,
  items: [
    operation("run-latest", "Latest tests", "succeeded", "2026-10-01T10:06:00.000Z"),
    operation("run-failed", "Desktop package", "failed", "2026-10-01T10:05:00.000Z"),
  ],
  services: [service("service-api-a", "API"), service("service-api-b", "API Service")],
  environments: [
    {
      workspaceId: "workspace-kalcode",
      kind: "production",
      branch: "main",
      version: "0.1.8",
      urls: ["https://kalcode.com"],
      deploymentStatus: "deployed",
      health: "healthy",
      platform: "Cloudflare",
      lastDeploy: "2026-10-01T10:07:00.000Z",
      runId: "run-release",
      variables: [],
      observedAt: "2026-10-01T10:08:00.000Z",
      notes: [],
    },
  ],
  activity: [],
  observedAt: "2026-10-01T10:08:00.000Z",
  warnings: [],
};

function thread(id: string, name: string, currentActivity: string): ThreadSummary {
  return {
    id,
    name,
    providerId: "claude-code",
    providerName: "Claude Code",
    providerAccountId: "claude-a",
    accountLabel: "Claude A",
    model: "claude-opus-4-1",
    workspaceId: "workspace-kalcode",
    workspaceName: "KalCode",
    status: "active",
    currentActivity,
    filesChanged: 0,
    lastActivityAt: "2026-10-01T10:09:00.000Z",
    archivedAt: null,
    runtimeKind: "interactive_pty",
    terminalId: null,
  } as ThreadSummary;
}

let submit: ((text: string) => Promise<void>) | null = null;

function Probe() {
  const voice = useKalVoice();
  const latest = voice.history[0] as
    | ((typeof voice.history)[number] & { localResult?: { ok: boolean; message: string } | null })
    | undefined;
  const terminalHistoryResult = latest?.localResult
    ? `${latest.localResult.ok ? "completed" : "failed"}:${latest.localResult.message}`
    : latest?.response?.outcome.kind === "completed"
      ? `completed:${latest.response.outcome.summary}`
      : latest?.response
        ? latest.response.outcome.kind
        : "pending";
  submit = voice.submit;
  return (
    <>
      <output data-testid="voice-result" data-voice-replies={String(voice.status?.preferences.voiceReplies === true)}>
        {`${voice.state.phase}:${voice.state.message}`}
      </output>
      <output data-testid="voice-history">{latest ? `${latest.text}:${terminalHistoryResult}` : "empty"}</output>
    </>
  );
}

function providerTree() {
  return (
    <KalVoiceProvider>
      <Probe />
      <SessionChoicePanel />
    </KalVoiceProvider>
  );
}

async function mount() {
  const view = render(providerTree());
  await waitFor(() => expect(submit).not.toBeNull());
  await waitFor(() => expect(mocks.signal).not.toBeNull());
  return view;
}

async function say(text: string) {
  await act(async () => submit?.(text));
}

function lifecycle(
  callbackClass: "completed" | "failed" | "needs_user" | "permission" | "oauth" | "deployment",
  targetKind: "thread" | "operation",
  targetId: string,
  workspaceId = "workspace-kalcode",
) {
  act(() =>
    mocks.signal?.({
      kind: "lifecycle_callback",
      requestId: `callback-${callbackClass}-${targetId}`,
      class: callbackClass,
      targetKind,
      targetId,
      workspaceId,
    }),
  );
}

function fallbackResponse(): KalVoiceResponse {
  return {
    requestId: "native-fallback",
    intent: null,
    outcome: { kind: "completed", summary: "Handled by the native router." },
    usage: { used: 0, allowance: null, periodStart: "2026-10-01", resetsAt: "2026-11-01" },
    counted: false,
    directive: null,
  };
}

function enableVoiceReplies() {
  mocks.client.kalvoiceStatus.mockResolvedValue({
    preferences: { voiceReplies: true, talkEnabled: false },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  submit = null;
  mocks.signal = null;
  mocks.runtime.client = mocks.client;
  mocks.runtime.feed = mocks.makeFeed();
  mocks.client.subscribeKalVoice.mockImplementation(async (listener: (signal: unknown) => void) => {
    mocks.signal = listener;
    return () => {
      if (mocks.signal === listener) mocks.signal = null;
    };
  });
  mocks.invoke.mockImplementation(async (command: string) => {
    if (command === "operations_snapshot") return structuredClone(SNAPSHOT);
    if (command === "operations_history") return { items: [], nextCursor: null };
    if (command === "operations_service_action") return undefined;
    throw new Error(`Unexpected command: ${command}`);
  });
  mocks.request.mockRejectedValue(new Error("Scene commands must not fall through to KalVoice request routing."));
  mocks.client.listThreads.mockResolvedValue([]);
  mocks.client.getThread.mockRejectedValue(new Error("Unknown thread"));
  mocks.client.locatorSearch.mockResolvedValue({ results: { items: [], nextCursor: null } });
  mocks.client.kalvoiceStatus.mockResolvedValue(null);
  mocks.talk.mockResolvedValue({ route: "dictation", response: null, recognizedMs: 1 });
});

/** A focused Claude Code pane that receives dictation, as a provider terminal registers it. */
function providerPane() {
  const element = document.createElement("textarea");
  document.body.append(element);
  const deliver = vi.fn().mockResolvedValue(undefined);
  const unregister = registerDictationSink(element, {
    destination: {
      kind: "provider_pane",
      providerId: "claude-code",
      providerAccountId: "claude-a",
      threadId: "thread-pane",
      instanceId: "thread-pane-instance",
    },
    label: "Claude Code",
    deliver,
    submit: vi.fn().mockResolvedValue(undefined),
  });
  return {
    element,
    deliver,
    dispose: () => {
      unregister();
      element.remove();
    },
  };
}

let pttSession = 0;

/** One push-to-talk utterance with whatever has focus now. */
async function speak(text: string) {
  const sessionId = `ptt-${++pttSession}`;
  act(() => mocks.signal?.({ kind: "listening_started", sessionId, mode: "talk" }));
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
      result: { kind: "transcript", sessionId, mode: "talk", text, durationMs: 500 },
    }),
  );
}

describe("KalVoice scene integration", () => {
  it("keeps a native agent directive bound to Code when session metadata cannot be read", async () => {
    const requestId = "00000000-0000-4000-8000-000000000099";
    vi.spyOn(crypto, "randomUUID").mockReturnValue(requestId);
    mocks.request.mockResolvedValue({
      ...fallbackResponse(),
      requestId,
      directive: { kind: "open_agent", agentId: "agent-native", workspaceId: "workspace-kalcode" },
    });
    mocks.client.getThread.mockRejectedValue(new Error("Session metadata unavailable"));
    await mount();
    await say("open the native agent");
    expect(mocks.focusIntent).toHaveBeenCalledWith({
      kind: "agent",
      agentId: "agent-native",
      workspaceId: "workspace-kalcode",
    });
    expect(mocks.focusIntent).not.toHaveBeenCalledWith(expect.objectContaining({ kind: "thread" }));
    expect(mocks.client.getThread).not.toHaveBeenCalled();
  });

  it("settles a handled local scene command in typed history", async () => {
    await mount();

    await say("show the queue");

    expect(screen.getByTestId("voice-result")).toHaveTextContent("done:Opened Queue.");
    expect(screen.getByTestId("voice-history")).toHaveTextContent("show the queue:completed:Opened Queue.");
    expect(mocks.request).not.toHaveBeenCalled();
  });

  it("prevents an older deferred scene command from focusing or reporting after a newer submit", async () => {
    const stale = thread("thread-stale", "Slow target", "Waiting on stale scene resolution");
    let releaseSearch: ((value: unknown) => void) | null = null;
    mocks.client.locatorSearch.mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseSearch = resolve;
        }),
    );
    mocks.client.getThread.mockResolvedValue(stale);
    await mount();

    let staleSubmit: Promise<void> | undefined;
    act(() => {
      staleSubmit = submit?.("open Slow target");
    });
    await waitFor(() => expect(mocks.client.locatorSearch).toHaveBeenCalledTimes(1));

    await say("show the queue");
    expect(mocks.navigate).toHaveBeenLastCalledWith("operations");
    expect(screen.getByTestId("voice-result")).toHaveTextContent("done:Opened Queue.");

    await act(async () => {
      releaseSearch?.({
        results: {
          items: [
            {
              kind: "thread",
              entityId: stale.id,
              title: stale.name,
              subtitle: stale.currentActivity,
              status: stale.status,
              workspaceId: stale.workspaceId,
              providerId: stale.providerId,
              updatedAt: stale.lastActivityAt,
              snippet: null,
              score: 1,
              semantic: false,
              highlights: [],
            },
          ],
          nextCursor: null,
        },
      });
      await staleSubmit;
    });

    expect(mocks.focusIntent).not.toHaveBeenCalled();
    expect(mocks.navigate).toHaveBeenCalledTimes(1);
    expect(mocks.navigate).toHaveBeenLastCalledWith("operations");
    expect(screen.getByTestId("voice-result")).toHaveTextContent("done:Opened Queue.");
    expect(screen.getByTestId("voice-history")).toHaveTextContent("show the queue:completed:Opened Queue.");
  });

  it("cancels an older deferred typed scene command when push to talk starts", async () => {
    const stale = thread("thread-stale-ptt", "Slow voice target", "Waiting on stale scene resolution");
    let releaseSearch: ((value: unknown) => void) | null = null;
    mocks.client.locatorSearch.mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseSearch = resolve;
        }),
    );
    mocks.client.getThread.mockResolvedValue(stale);
    await mount();

    let staleSubmit: Promise<void> | undefined;
    act(() => {
      staleSubmit = submit?.("open Slow voice target");
    });
    await waitFor(() => expect(mocks.client.locatorSearch).toHaveBeenCalledTimes(1));

    act(() => mocks.signal?.({ kind: "listening_started", sessionId: "new-ptt", mode: "talk" }));
    expect(screen.getByTestId("voice-result")).toHaveTextContent("listening:null");
    expect(screen.getByTestId("voice-history")).toHaveTextContent("open Slow voice target:failed:Cancelled.");

    await act(async () => {
      releaseSearch?.({
        results: {
          items: [
            {
              kind: "thread",
              entityId: stale.id,
              title: stale.name,
              subtitle: stale.currentActivity,
              status: stale.status,
              workspaceId: stale.workspaceId,
              providerId: stale.providerId,
              updatedAt: stale.lastActivityAt,
              snippet: null,
              score: 1,
              semantic: false,
              highlights: [],
            },
          ],
          nextCursor: null,
        },
      });
      await staleSubmit;
    });

    expect(mocks.focusIntent).not.toHaveBeenCalled();
    expect(mocks.navigate).not.toHaveBeenCalled();
    expect(screen.getByTestId("voice-result")).toHaveTextContent("listening:null");
  });

  it("ignores a stale local action result after a newer request owns assistant state", () => {
    const current = reduce(INITIAL_STATE, { type: "submitted", requestId: "new-request" });

    const next = reduce(current, {
      type: "action_result",
      requestId: "old-request",
      ok: true,
      message: "Stale scene result.",
    });

    expect(next).toBe(current);
    expect(next).toMatchObject({ phase: "thinking", requestId: "new-request", message: null });
  });

  it("routes tabs, failed runs, and production through the canonical Operations focus path", async () => {
    await mount();

    await say("show the queue");
    expect(mocks.navigate).toHaveBeenLastCalledWith("operations");
    expect(mocks.focusOperations).toHaveBeenLastCalledWith(
      { kind: "tab", tab: "queue" },
      expect.objectContaining({ signal: expect.objectContaining({ aborted: false }) }),
    );

    await say("open the last failed run");
    expect(mocks.focusOperations).toHaveBeenLastCalledWith(
      expect.objectContaining({ kind: "run", runId: "run-failed" }),
      expect.any(Object),
    );

    await say("show production");
    expect(mocks.focusOperations).toHaveBeenLastCalledWith(
      expect.objectContaining({ kind: "environment", environment: "production" }),
      expect.any(Object),
    );
    expect(mocks.request).not.toHaveBeenCalled();
  });

  it("keeps the last status target for a natural follow-up", async () => {
    await mount();

    await say("what just finished");
    expect(screen.getByTestId("voice-result")).toHaveTextContent("Latest tests finished: Tests passed.");
    expect(mocks.navigate).not.toHaveBeenCalled();
    expect(mocks.focusOperations).not.toHaveBeenCalled();

    await say("open it");
    expect(mocks.navigate).toHaveBeenCalledWith("operations");
    expect(mocks.focusOperations).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "run", runId: "run-latest" }),
      expect.any(Object),
    );
    expect(mocks.request).not.toHaveBeenCalled();
  });

  it("shows a concise chooser and revalidates the selected service before restart", async () => {
    await mount();

    await say("restart API service");
    const chooser = screen.getByText("Which API service?").closest("section");
    expect(chooser).not.toBeNull();
    expect(chooser).toHaveTextContent("1. API — KalCode");
    expect(chooser).toHaveTextContent("2. API Service — KalCode");
    expect(mocks.invoke).not.toHaveBeenCalledWith("operations_service_action", expect.anything());

    fireEvent.click(screen.getByRole("button", { name: "2. API Service — KalCode" }));
    await waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith("operations_service_action", {
        id: "service-api-b",
        action: "restart",
      }),
    );
    expect(mocks.focusOperations).toHaveBeenLastCalledWith(
      expect.objectContaining({ kind: "service", serviceId: "service-api-b" }),
      expect.any(Object),
    );
    expect(mocks.request).not.toHaveBeenCalled();
  });

  it("keeps an account launch retry payload out of visible history", async () => {
    const chooserRequestId = "00000000-0000-4000-8000-000000000001";
    const retryRequestId = "00000000-0000-4000-8000-000000000002";
    const retryText =
      "retry launch groups 5b7b22636f756e74223a362c2270726f76696465725f6964223a22636c617564652d636f6465222c226163636f756e745f7175657279223a2237356536626162352d353138312d343762642d613961332d303263623630366537363330227d5d";
    const chooserResponse: KalVoiceResponse = {
      ...fallbackResponse(),
      requestId: chooserRequestId,
      outcome: { kind: "completed", summary: "Choose a Claude account." },
      directive: {
        kind: "choose_launch_account",
        question: "Which Claude account?",
        workspaceId: "workspace-release",
        choices: [
          { accountId: "claude-a", label: "Claude A", retryText },
          { accountId: "claude-b", label: "Claude B", retryText: `${retryText}62` },
        ],
      },
    };
    const launchedResponse: KalVoiceResponse = {
      ...fallbackResponse(),
      requestId: retryRequestId,
      outcome: { kind: "completed", summary: "Opened six Claude Code agents." },
    };
    const uuid = vi
      .spyOn(crypto, "randomUUID")
      .mockReturnValueOnce(chooserRequestId)
      .mockReturnValueOnce(retryRequestId);
    mocks.request.mockResolvedValueOnce(chooserResponse).mockResolvedValueOnce(launchedResponse);

    try {
      await mount();
      await say("Launch six Claude Code agents");

      fireEvent.click(screen.getByRole("button", { name: "1. Claude A" }));
      await waitFor(() => expect(mocks.request).toHaveBeenCalledTimes(2));

      expect(mocks.request).toHaveBeenNthCalledWith(2, {
        requestId: retryRequestId,
        text: retryText,
        input: "text",
        workspaceId: "workspace-release",
        threadId: null,
      });
      await waitFor(() =>
        expect(screen.getByTestId("voice-history")).toHaveTextContent(
          "Claude A:completed:Opened six Claude Code agents.",
        ),
      );
      expect(screen.getByTestId("voice-history")).not.toHaveTextContent(retryText);
    } finally {
      uuid.mockRestore();
    }
  });

  it("finds and focuses a live agent, then resolves 'open it' to the same scene target", async () => {
    const updater = thread("thread-updater", "Updater", "Working on the website updater");
    mocks.client.listThreads.mockResolvedValue([updater]);
    mocks.client.getThread.mockResolvedValue(updater);
    await mount();
    await waitFor(() => expect(mocks.client.listThreads).toHaveBeenCalled());
    await act(async () => {
      await Promise.resolve();
    });

    await say("find Claude working on the website updater");
    expect(mocks.focusIntent).toHaveBeenLastCalledWith({
      kind: "agent",
      agentId: "thread-updater",
      workspaceId: "workspace-kalcode",
    });
    expect(screen.getByTestId("voice-result")).toHaveTextContent("Updater opened.");

    mocks.focusIntent.mockClear();
    await say("open it");
    expect(mocks.focusIntent).toHaveBeenCalledTimes(1);
    expect(mocks.focusIntent).toHaveBeenCalledWith({
      kind: "agent",
      agentId: "thread-updater",
      workspaceId: "workspace-kalcode",
    });
    expect(mocks.request).not.toHaveBeenCalled();
  });

  it("asks which live agent and accepts a spoken ordinal without guessing", async () => {
    const frontend = thread("thread-frontend", "Frontend", "Working on navigation");
    const backend = thread("thread-backend", "Backend", "Working on the API");
    mocks.client.listThreads.mockResolvedValue([frontend, backend]);
    mocks.client.getThread.mockImplementation(async (id: string) => {
      if (id === frontend.id) return frontend;
      if (id === backend.id) return backend;
      throw new Error("Unknown thread");
    });
    await mount();
    await waitFor(() => expect(mocks.client.listThreads).toHaveBeenCalled());
    await act(async () => {
      await Promise.resolve();
    });

    await say("open Claude agent");
    expect(screen.getByText("Which one?").closest("section")).toHaveTextContent("1. Frontend");
    expect(screen.getByText("Which one?").closest("section")).toHaveTextContent("2. Backend");
    expect(mocks.focusIntent).not.toHaveBeenCalled();

    await say("two");
    await waitFor(() =>
      expect(mocks.focusIntent).toHaveBeenCalledWith({
        kind: "agent",
        agentId: "thread-backend",
        workspaceId: "workspace-kalcode",
      }),
    );
    expect(screen.queryByText("Which one?")).not.toBeInTheDocument();
    expect(mocks.request).not.toHaveBeenCalled();
  });

  it.each(["cancelled", "nothing heard"] as const)(
    "keeps a valid scene chooser actionable after push to talk ends with %s",
    async (ending) => {
      const frontend = thread("thread-choice-frontend", "Frontend", "Working on navigation");
      const backend = thread("thread-choice-backend", "Backend", "Working on the API");
      mocks.client.listThreads.mockResolvedValue([frontend, backend]);
      mocks.client.getThread.mockImplementation(async (id: string) => {
        if (id === frontend.id) return frontend;
        if (id === backend.id) return backend;
        throw new Error("Unknown thread");
      });
      await mount();
      await waitFor(() => expect(mocks.client.listThreads).toHaveBeenCalled());
      await act(async () => {
        await Promise.resolve();
      });

      await say("open Claude agent");
      expect(screen.getByRole("button", { name: /^2\. Backend/ })).toBeVisible();

      act(() => mocks.signal?.({ kind: "listening_started", sessionId: "chooser-ptt", mode: "talk" }));
      act(() => {
        if (ending === "cancelled") {
          mocks.signal?.({ kind: "cancelled", sessionId: "chooser-ptt", mode: "talk" });
          return;
        }
        mocks.signal?.({
          kind: "result",
          result: { kind: "nothing_heard", sessionId: "chooser-ptt", mode: "talk" },
          timings: {
            keyDownToMic: null,
            speechToPartial: null,
            keyUpToFinal: null,
            finalToRecognized: null,
            recognizedToAction: null,
            finalSource: null,
          },
        });
      });

      fireEvent.click(screen.getByRole("button", { name: /^2\. Backend/ }));

      await waitFor(() =>
        expect(mocks.focusIntent).toHaveBeenCalledWith({
          kind: "agent",
          agentId: backend.id,
          workspaceId: "workspace-kalcode",
        }),
      );
      expect(screen.queryByText("Which one?")).not.toBeInTheDocument();
      expect(screen.getByTestId("voice-result")).toHaveTextContent("done:Backend opened.");
      expect(screen.getByTestId("voice-history")).toHaveTextContent("open Claude agent:completed:Backend opened.");
      expect(mocks.request).not.toHaveBeenCalled();
    },
  );

  it("adds provider, account, and workspace context when scene choices share a title", async () => {
    const website = {
      ...thread("thread-website-release", "Release", "Preparing website release"),
      workspaceName: "Website",
    } as ThreadSummary;
    const api = {
      ...thread("thread-api-release", "Release", "Preparing API release"),
      providerId: "codex",
      providerName: "Codex",
      providerAccountId: "codex-b",
      accountLabel: "Codex B",
      workspaceId: "workspace-api",
      workspaceName: "API",
    } as ThreadSummary;
    mocks.client.listThreads.mockResolvedValue([website, api]);
    mocks.client.getThread.mockImplementation(async (id: string) => {
      if (id === website.id) return website;
      if (id === api.id) return api;
      throw new Error("Unknown thread");
    });
    await mount();
    await waitFor(() => expect(mocks.client.listThreads).toHaveBeenCalled());
    await act(async () => {
      await Promise.resolve();
    });

    await say("open Release");
    const chooser = screen.getByText("Which one?").closest("section");
    expect(chooser).toHaveTextContent("Release — Website · Claude Code · Claude A");
    expect(chooser).toHaveTextContent("Release — API · Codex · Codex B");

    await say("two");
    await waitFor(() =>
      expect(mocks.focusIntent).toHaveBeenCalledWith({
        kind: "agent",
        agentId: api.id,
        workspaceId: "workspace-api",
      }),
    );
    expect(mocks.request).not.toHaveBeenCalled();
  });

  it("opens the coding agent whose turn just finished, though its pane is idle again", async () => {
    // An agent in a Code pane goes back to idle when its turn completes; the completion event,
    // not a "completed" status, is what makes it "the agent that just finished".
    const earlier = { ...thread("agent-earlier", "Earlier agent", "Ready"), status: "idle" as const };
    const finished = { ...thread("agent-finished", "Finished agent", "Ready"), status: "idle" as const };
    const chat = { ...thread("chat-later", "Chat later", "Done"), runtimeKind: "headless" as const };
    mocks.client.listThreads.mockResolvedValue([earlier, finished, chat]);
    mocks.client.getThread.mockImplementation(async (id: string) => {
      const found = [earlier, finished, chat].find((t) => t.id === id);
      if (!found) throw new Error("Unknown thread");
      return found;
    });
    await mount();
    const complete = (seq: number, type: string, threadId: string) =>
      act(() => {
        mocks.runtime.feed.push({
          id: `event-${seq}`,
          seq,
          version: 1,
          occurredAt: new Date(Date.now() + seq).toISOString(),
          source: { kind: "provider" },
          correlation: { correlationId: `turn-${seq}`, causationId: null },
          type,
          payload: type === "agent.turn_completed" ? { threadId, ok: true, interrupted: false } : { threadId },
        });
      });
    complete(1, "agent.turn_completed", earlier.id);
    complete(2, "agent.turn_completed", finished.id);
    complete(3, "thread.completed", chat.id);

    await say("open the agent that just finished");

    expect(mocks.focusIntent).toHaveBeenCalledExactlyOnceWith({
      kind: "agent",
      agentId: finished.id,
      workspaceId: "workspace-kalcode",
    });
    expect(mocks.request).not.toHaveBeenCalled();
  });

  it("never answers an agent completion question with a chat callback", async () => {
    const chat = { ...thread("chat-finished", "Chat result", "Finished chatting"), runtimeKind: "headless" as const };
    mocks.client.getThread.mockResolvedValue(chat);
    mocks.request.mockResolvedValue(fallbackResponse());
    await mount();
    lifecycle("completed", "thread", chat.id);
    await say("which agent just finished");
    expect(mocks.request).toHaveBeenCalledTimes(1);
    expect(mocks.focusIntent).not.toHaveBeenCalled();
    expect(screen.getByTestId("voice-result")).not.toHaveTextContent("Chat result finished its task");
  });

  it("drops a completed-agent follow-up when the runtime client and feed are replaced", async () => {
    const finished = thread("thread-finished", "Finished agent", "Completed updater tests");
    mocks.client.getThread.mockResolvedValue(finished);
    const view = await mount();
    act(() => {
      mocks.runtime.feed.push({
        id: "event-complete",
        seq: 1,
        version: 1,
        occurredAt: new Date(Date.now() + 1).toISOString(),
        source: { kind: "core" },
        correlation: { correlationId: "completion", causationId: null },
        type: "thread.completed",
        payload: { threadId: finished.id },
      });
    });

    const replacement = {
      ...mocks.client,
      getThread: vi.fn().mockResolvedValue(finished),
    };
    await act(async () => {
      mocks.runtime.client = replacement;
      mocks.runtime.feed = mocks.makeFeed();
      view.rerender(providerTree());
    });
    mocks.request.mockClear();
    mocks.request.mockResolvedValue(fallbackResponse());

    await say("which agent just finished");

    expect(replacement.getThread).not.toHaveBeenCalled();
    expect(mocks.request).toHaveBeenCalledTimes(1);
  });

  it("does not reopen an older scene target after a newer target fails to focus", async () => {
    const updater = thread("thread-updater", "Updater", "Working on the website updater");
    const release = thread("thread-release", "Release", "Preparing production");
    mocks.client.listThreads.mockResolvedValue([updater, release]);
    mocks.client.getThread.mockImplementation(async (id: string) => {
      if (id === updater.id) return updater;
      if (id === release.id) return release;
      throw new Error("Unknown thread");
    });
    mocks.focusIntent.mockImplementation(async (target: { kind: string; agentId?: string }) => {
      if (target.agentId === release.id) throw new Error("Agent closed before focus");
    });
    await mount();
    await waitFor(() => expect(mocks.client.listThreads).toHaveBeenCalled());
    await act(async () => {
      await Promise.resolve();
    });

    await say("open Updater");
    expect(mocks.focusIntent).toHaveBeenCalledWith({
      kind: "agent",
      agentId: updater.id,
      workspaceId: "workspace-kalcode",
    });

    await say("open Release");
    expect(screen.getByTestId("voice-result")).toHaveTextContent("I couldn't open Release");
    mocks.request.mockClear();
    mocks.request.mockResolvedValue(fallbackResponse());

    await say("open it");

    expect(
      mocks.focusIntent.mock.calls.filter((call) => call[0]?.kind === "agent" && call[0]?.agentId === updater.id),
    ).toHaveLength(1);
    expect(mocks.request).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["completed", "completed", "what did it do"],
    ["failed", "failed", "what did it do"],
    ["needs_user", "waiting_for_user", "open it"],
    ["oauth", "waiting_for_user", "open it"],
    ["permission", "waiting_for_permission", "open it"],
  ] as const)("keeps a %s callback bound to its canonical thread", async (callbackClass, status, followup) => {
    enableVoiceReplies();
    const target = {
      ...thread(`thread-${callbackClass}`, "Claude A", "Waiting on canonical thread state"),
      status,
    } as ThreadSummary;
    mocks.client.listThreads.mockResolvedValue([target]);
    mocks.client.getThread.mockResolvedValue(target);
    await mount();
    await waitFor(() => expect(screen.getByTestId("voice-result")).toHaveAttribute("data-voice-replies", "true"));

    lifecycle(callbackClass, "thread", target.id);
    await say(followup);

    expect(mocks.client.getThread).toHaveBeenCalledWith(target.id);
    if (followup === "open it") {
      expect(mocks.focusIntent).toHaveBeenCalledWith({
        kind: "agent",
        agentId: target.id,
        workspaceId: "workspace-kalcode",
      });
      expect(screen.getByTestId("voice-result")).toHaveTextContent("Claude A opened.");
    } else {
      expect(screen.getByTestId("voice-result")).toHaveTextContent(`Claude A is ${status.replaceAll("_", " ")}.`);
    }
    expect(mocks.request).not.toHaveBeenCalled();
  });

  it.each([
    ["failed", "run-failed", "Desktop package", "failed"],
    ["deployment", "run-deploy", "Production deploy", "succeeded"],
  ] as const)(
    "loads canonical Operations detail for a %s callback and opens that exact run",
    async (callbackClass, runId, name, status) => {
      const callbackRun = {
        ...operation(runId, name, status, "2026-10-01T10:12:00.000Z"),
        spec: { ...operationSpec(name), kind: callbackClass === "deployment" ? "deploy" : "test" },
      };
      mocks.invoke.mockImplementation(async (command: string) => {
        if (command === "operations_detail") return { run: callbackRun };
        if (command === "operations_snapshot") return structuredClone(SNAPSHOT);
        if (command === "operations_history") return { items: [], nextCursor: null };
        throw new Error(`Unexpected command: ${command}`);
      });
      await mount();

      lifecycle(callbackClass, "operation", runId);
      await say("what happened");
      expect(mocks.invoke).toHaveBeenCalledWith("operations_detail", { id: runId });
      expect(screen.getByTestId("voice-result")).toHaveTextContent(`${name}: ${status}.`);

      await say("open it");
      expect(mocks.navigate).toHaveBeenLastCalledWith("operations");
      expect(mocks.focusOperations).toHaveBeenLastCalledWith(
        expect.objectContaining({ kind: "run", runId }),
        expect.any(Object),
      );
      expect(mocks.request).not.toHaveBeenCalled();
    },
  );

  it("does not infer a lifecycle target from a generic speaking signal", async () => {
    const target = thread("thread-unspoken", "Unspoken", "Private task detail");
    mocks.client.getThread.mockResolvedValue(target);
    await mount();
    act(() => mocks.signal?.({ kind: "speaking", requestId: "ordinary-reply", active: true }));
    mocks.request.mockResolvedValue(fallbackResponse());

    await say("what happened");

    expect(mocks.client.getThread).not.toHaveBeenCalled();
    expect(mocks.invoke).not.toHaveBeenCalledWith("operations_detail", expect.anything());
    expect(mocks.request).toHaveBeenCalledTimes(1);
  });

  it("keeps callback delivery private and speaks only the canonical target name on open", async () => {
    enableVoiceReplies();
    const target = thread("thread-private", "Claude A", "token=private-provider-output");
    mocks.client.listThreads.mockResolvedValue([target]);
    mocks.client.getThread.mockResolvedValue(target);
    await mount();
    await waitFor(() => expect(screen.getByTestId("voice-result")).toHaveAttribute("data-voice-replies", "true"));

    lifecycle("oauth", "thread", target.id);
    expect(screen.getByTestId("voice-result")).not.toHaveTextContent("private-provider-output");
    await say("open it");

    expect(screen.getByTestId("voice-result")).toHaveTextContent("Claude A opened.");
    expect(screen.getByTestId("voice-result")).not.toHaveTextContent("private-provider-output");
  });

  it("clears a callback whose thread was deleted before the follow-up", async () => {
    enableVoiceReplies();
    mocks.client.getThread.mockRejectedValue(new Error("token=private deleted thread detail"));
    await mount();
    await waitFor(() => expect(screen.getByTestId("voice-result")).toHaveAttribute("data-voice-replies", "true"));
    lifecycle("needs_user", "thread", "thread-deleted");

    await say("open it");
    expect(screen.getByTestId("voice-result")).toHaveTextContent("That agent is no longer available.");
    expect(screen.getByTestId("voice-result")).not.toHaveTextContent("private deleted thread detail");

    mocks.client.getThread.mockClear();
    mocks.request.mockClear();
    mocks.request.mockResolvedValue(fallbackResponse());
    await say("open it");
    expect(mocks.client.getThread).not.toHaveBeenCalled();
    expect(mocks.request).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["a different thread", { id: "thread-object-swap" }],
    ["an archived thread", { archivedAt: "2026-10-01T10:15:00.000Z" }],
  ] as const)("refuses %s returned for a lifecycle callback", async (_case, patch) => {
    enableVoiceReplies();
    const stale = {
      ...thread("thread-callback", "Stale callback", "Private stale detail"),
      ...patch,
    } as ThreadSummary;
    mocks.client.listThreads.mockResolvedValue([stale]);
    mocks.client.getThread.mockResolvedValue(stale);
    await mount();
    await waitFor(() => expect(screen.getByTestId("voice-result")).toHaveAttribute("data-voice-replies", "true"));
    lifecycle("needs_user", "thread", "thread-callback");

    await say("open it");

    expect(screen.getByTestId("voice-result")).toHaveTextContent(/That (?:completed )?agent is no longer available\./);
    expect(mocks.focusIntent).not.toHaveBeenCalled();
    expect(screen.getByTestId("voice-result")).not.toHaveTextContent("Private stale detail");

    mocks.client.getThread.mockClear();
    mocks.request.mockClear();
    mocks.request.mockResolvedValue(fallbackResponse());
    await say("open it");
    expect(mocks.client.getThread).not.toHaveBeenCalled();
    expect(mocks.request).toHaveBeenCalledTimes(1);
  });

  it("clears a callback whose Operations run was deleted before the follow-up", async () => {
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === "operations_detail") throw new Error("token=private deleted run detail");
      if (command === "operations_snapshot") return structuredClone(SNAPSHOT);
      if (command === "operations_history") return { items: [], nextCursor: null };
      throw new Error(`Unexpected command: ${command}`);
    });
    await mount();
    lifecycle("failed", "operation", "run-deleted");

    await say("open it");
    expect(screen.getByTestId("voice-result")).toHaveTextContent("That run is no longer available.");
    expect(screen.getByTestId("voice-result")).not.toHaveTextContent("private deleted run detail");

    mocks.invoke.mockClear();
    mocks.request.mockClear();
    mocks.request.mockResolvedValue(fallbackResponse());
    await say("open it");
    expect(mocks.invoke).not.toHaveBeenCalledWith("operations_detail", expect.anything());
    expect(mocks.request).toHaveBeenCalledTimes(1);
  });

  it("refuses a different Operations run returned for a lifecycle callback", async () => {
    const swapped = operation("run-object-swap", "Private wrong run", "failed", "2026-10-01T10:12:00.000Z");
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === "operations_detail") return { run: swapped };
      if (command === "operations_snapshot") return structuredClone(SNAPSHOT);
      if (command === "operations_history") return { items: [], nextCursor: null };
      throw new Error(`Unexpected command: ${command}`);
    });
    await mount();
    lifecycle("failed", "operation", "run-callback");

    await say("open it");

    expect(screen.getByTestId("voice-result")).toHaveTextContent("That run is no longer available.");
    expect(screen.getByTestId("voice-result")).not.toHaveTextContent("Private wrong run");
    expect(mocks.navigate).not.toHaveBeenCalled();
    expect(mocks.focusOperations).not.toHaveBeenCalled();
  });

  it("drops a lifecycle callback when the runtime client is replaced", async () => {
    const oldTarget = thread("thread-old-callback", "Old callback", "Finished old work");
    mocks.client.getThread.mockResolvedValue(oldTarget);
    const view = await mount();
    lifecycle("completed", "thread", oldTarget.id);

    const replacement = {
      ...mocks.client,
      getThread: vi.fn().mockResolvedValue(oldTarget),
    };
    await act(async () => {
      mocks.runtime.client = replacement;
      mocks.runtime.feed = mocks.makeFeed();
      view.rerender(providerTree());
    });
    mocks.request.mockClear();
    mocks.request.mockResolvedValue(fallbackResponse());

    await say("what did it do");

    expect(replacement.getThread).not.toHaveBeenCalled();
    expect(mocks.request).toHaveBeenCalledTimes(1);
  });

  describe("while a dictation target has focus", () => {
    it.each([
      "restart the dev server",
      "restart the API",
      "what's running",
      "what happened",
      "open runs",
      "show activity",
      "find the login bug",
    ])("lets native routing dictate %j to the focused pane instead of running a scene command", async (text) => {
      // A live agent and its fresh completion callback, so every phrase has a scene to act on.
      const login = thread("thread-login", "Login bug", "Fixed the login redirect");
      mocks.client.listThreads.mockResolvedValue([login]);
      mocks.client.getThread.mockResolvedValue(login);
      const pane = providerPane();
      try {
        await mount();
        await waitFor(() => expect(mocks.client.listThreads).toHaveBeenCalled());
        lifecycle("completed", "thread", login.id);
        act(() => pane.element.focus());

        await speak(text);

        await waitFor(() => expect(pane.deliver).toHaveBeenCalledWith(text, expect.any(Object)));
        expect(mocks.talk).toHaveBeenCalledOnce();
        expect(mocks.talk).toHaveBeenCalledWith(expect.objectContaining({ text, target: "provider_pane" }));
        expect(mocks.invoke).not.toHaveBeenCalled();
        expect(mocks.navigate).not.toHaveBeenCalled();
        expect(mocks.focusOperations).not.toHaveBeenCalled();
        expect(mocks.focusIntent).not.toHaveBeenCalled();
        expect(mocks.client.getThread).not.toHaveBeenCalled();
      } finally {
        pane.dispose();
      }
    });

    it("still answers a pending scene chooser by voice", async () => {
      const pane = providerPane();
      try {
        await mount();
        await say("restart API service");
        expect(screen.getByText("Which API service?")).toBeInTheDocument();
        act(() => pane.element.focus());

        await speak("two");

        await waitFor(() =>
          expect(mocks.invoke).toHaveBeenCalledWith("operations_service_action", {
            id: "service-api-b",
            action: "restart",
          }),
        );
        expect(mocks.talk).not.toHaveBeenCalled();
        expect(pane.deliver).not.toHaveBeenCalled();
      } finally {
        pane.dispose();
      }
    });

    it("keeps spoken scene routing when nothing dictatable has focus", async () => {
      await mount();

      await speak("open runs");

      expect(mocks.navigate).toHaveBeenLastCalledWith("operations");
      expect(mocks.focusOperations).toHaveBeenLastCalledWith({ kind: "tab", tab: "runs" }, expect.any(Object));
      expect(mocks.talk).not.toHaveBeenCalled();
    });
  });
});
