import type { ProviderAccount, TerminalInfo, ThreadSummary, Workspace } from "@kalcode/protocol";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveVoiceSceneTarget } from "./sceneTargets.ts";
import {
  createBaseVoiceSceneTargets,
  focusKnownVoiceSceneTarget,
  focusVoicePaneSceneTarget,
  mergeVoiceSceneTargets,
  registerVoicePaneScene,
  replayVoiceFocusTrace,
  useVoiceSceneThreads,
  type VoiceSceneEventFeed,
  type VoiceSceneThreadClient,
  voicePaneSceneSnapshot,
  voiceTerminalStatus,
  voiceThreadEffort,
} from "./useVoiceScene.ts";

const workspace: Workspace = {
  id: "workspace",
  name: "KalCode",
  rootPath: "C:/redacted",
  displayPath: "~/KalCode",
  createdAt: "2026-01-01T00:00:00Z",
  lastOpenedAt: "2026-01-03T00:00:00Z",
  activeTerminalId: "terminal",
  available: true,
};

const terminal: TerminalInfo = {
  id: "terminal",
  workspaceId: workspace.id,
  shellId: "powershell",
  title: "PowerShell",
  position: 1,
  status: "running",
  startedAt: "2026-01-02T00:00:00Z",
  endedAt: null,
  exitCode: null,
};

const thread = {
  id: "thread",
  name: "Updater",
  providerId: "codex",
  providerName: "Codex",
  providerAccountId: "account",
  accountLabel: "Codex B",
  model: "gpt-6",
  workspaceId: workspace.id,
  workspaceName: workspace.name,
  status: "testing",
  currentActivity: "Running updater tests",
  lastActivityAt: "2026-01-04T00:00:00Z",
  archivedAt: null,
  branch: "feature/updater",
  effort: "high",
} as ThreadSummary & { effort: string };

let dispose: (() => void) | null = null;

it("coding sessions publish agent identities and focus only their validated Code terminal", async () => {
  const agent = { ...thread, runtimeKind: "interactive_pty" as const };
  const targets = createBaseVoiceSceneTargets({ workspaces: [workspace], terminals: [], threads: [agent] });
  expect(targets.find((candidate) => candidate.entityId === agent.id)).toMatchObject({
    kind: "agent",
    codingAgent: true,
  });
  const actions = {
    workspaces: [workspace],
    activeWorkspaceId: workspace.id,
    terminals: [],
    getThread: vi.fn().mockResolvedValue(agent),
    listTerminals: vi.fn().mockResolvedValue([]),
    activateWorkspace: vi.fn().mockResolvedValue(true),
    selectTerminal: vi.fn(),
    focusIntent: vi.fn().mockResolvedValue(undefined),
    navigateToCode: vi.fn(),
  };
  const target = { kind: "agent" as const, entityId: agent.id, title: agent.name };
  await expect(focusKnownVoiceSceneTarget(target, actions)).resolves.toBe(true);
  expect(actions.focusIntent).toHaveBeenCalledWith({ kind: "agent", agentId: agent.id, workspaceId: workspace.id });
  actions.focusIntent.mockClear();
  actions.getThread.mockResolvedValue({ ...agent, runtimeKind: "headless" });
  await expect(focusKnownVoiceSceneTarget(target, actions)).resolves.toBe(false);
  expect(actions.focusIntent).not.toHaveBeenCalled();
});
afterEach(() => {
  dispose?.();
  dispose = null;
  vi.restoreAllMocks();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

class TestFeed implements VoiceSceneEventFeed {
  private listeners = new Set<() => void>();
  private events: { seq: number; type: string }[] = [];

  getSnapshot = () => ({ events: this.events });
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  merge(events: { seq: number; type: string }[]) {
    this.events = [...events, ...this.events].sort((a, b) => b.seq - a.seq);
    for (const listener of this.listeners) listener();
  }
}

describe("live KalVoice scene", () => {
  it("builds workspace, terminal and structured thread metadata without filesystem or prompt text", () => {
    const targets = createBaseVoiceSceneTargets({ workspaces: [workspace], terminals: [terminal], threads: [thread] });
    expect(targets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "workspace", entityId: workspace.id, title: "KalCode" }),
        expect.objectContaining({
          kind: "terminal",
          entityId: terminal.id,
          aliases: expect.arrayContaining(["Terminal 2", "KalCode terminal 2"]),
        }),
        expect.objectContaining({
          kind: "thread",
          entityId: thread.id,
          aliases: expect.arrayContaining(["Codex B", "KalCode", "KalCode workspace", "gpt-6", "high"]),
          subtitle: "Running updater tests",
          providerAccountId: "account",
          model: "gpt-6",
          effort: "high",
          branch: "feature/updater",
        }),
      ]),
    );
    expect(JSON.stringify(targets)).not.toContain(workspace.rootPath);
    expect(voiceTerminalStatus({ ...terminal, status: "exited", exitCode: 1 })).toBe("failed");
    expect(voiceThreadEffort(thread)).toBe("high");
    const threadTarget = targets.find((target) => target.kind === "thread") as NonNullable<(typeof targets)[number]>;
    expect(
      resolveVoiceSceneTarget({ kind: "named", query: "Codex working on KalCode" }, { targets: [threadTarget] }),
    ).toEqual({ kind: "resolved", target: threadTarget });
  });

  it("publishes current account identity and provider-reported model and effort with provenance", () => {
    const live = {
      ...thread,
      accountLabel: "Old nickname",
      activeModel: "provider/model-v2",
      activeEffort: "ultra",
    } as ThreadSummary & { activeModel: string; activeEffort: string };
    const account = {
      id: "account",
      providerId: "codex",
      displayName: "Current nickname",
      authenticationState: "authenticated",
      archivedAt: null,
    } as ProviderAccount;

    const target = createBaseVoiceSceneTargets({
      workspaces: [workspace],
      terminals: [],
      threads: [live],
      accounts: [account],
    }).find((candidate) => candidate.entityId === live.id);

    expect(target).toMatchObject({
      title: "Updater",
      accountLabel: "Current nickname",
      model: "provider/model-v2",
      modelSource: "provider",
      effort: "ultra",
      effortSource: "provider",
      aliases: expect.arrayContaining(["Current nickname", "provider/model-v2", "ultra"]),
    });
    expect(target?.aliases).not.toContain("Old nickname");
  });

  it("marks configured selectors as selected when the provider has not reported active values", () => {
    const target = createBaseVoiceSceneTargets({ workspaces: [workspace], terminals: [], threads: [thread] }).find(
      (candidate) => candidate.entityId === thread.id,
    );

    expect(target).toMatchObject({
      model: "gpt-6",
      modelSource: "configured",
      effort: "high",
      effortSource: "configured",
    });
  });

  it("merges live geometry and focus without dropping structured activity", () => {
    const base = createBaseVoiceSceneTargets({ workspaces: [workspace], terminals: [], threads: [thread] });
    const [merged] = mergeVoiceSceneTargets(
      base.filter((target) => target.kind === "thread"),
      [
        {
          kind: "thread",
          entityId: thread.id,
          title: "Updater · Codex B",
          workspaceId: workspace.id,
          paneId: "pane",
          focused: true,
          visible: true,
          rect: { x: 10, y: 20, width: 300, height: 200 },
        },
      ],
    );
    expect(merged).toMatchObject({
      title: "Updater · Codex B",
      subtitle: "Running updater tests",
      providerAccountId: "account",
      paneId: "pane",
      focused: true,
    });
  });

  it("keeps registration cleanup generation-safe and focuses only the matching workspace", () => {
    const oldFocus = vi.fn(() => true);
    const currentFocus = vi.fn(() => true);
    const stopOld = registerVoicePaneScene({
      workspaceId: "old",
      snapshot: () => [{ kind: "browser", entityId: "old-browser", title: "Browser" }],
      focus: oldFocus,
    });
    dispose = registerVoicePaneScene({
      workspaceId: workspace.id,
      snapshot: () => [{ kind: "browser", entityId: "browser", title: "Browser", workspaceId: workspace.id }],
      focus: currentFocus,
    });
    stopOld();

    expect(voicePaneSceneSnapshot()).toEqual([
      { kind: "browser", entityId: "browser", title: "Browser", workspaceId: workspace.id },
    ]);
    expect(
      focusVoicePaneSceneTarget({
        kind: "browser",
        entityId: "browser",
        title: "Browser",
        workspaceId: workspace.id,
      }),
    ).toBe(true);
    expect(
      focusVoicePaneSceneTarget({ kind: "browser", entityId: "browser", title: "Browser", workspaceId: "other" }),
    ).toBe(false);
    expect(oldFocus).not.toHaveBeenCalled();
    expect(currentFocus).toHaveBeenCalledTimes(1);
  });

  it("focuses known terminals and threads without depending on the gated locator", async () => {
    const activateWorkspace = vi.fn().mockResolvedValue(true);
    const selectTerminal = vi.fn();
    const focusIntent = vi.fn().mockResolvedValue(undefined);
    const actions = {
      workspaces: [workspace],
      activeWorkspaceId: null,
      terminals: [terminal],
      getThread: vi.fn().mockResolvedValue(thread),
      listTerminals: vi.fn().mockResolvedValue([terminal]),
      activateWorkspace,
      selectTerminal,
      focusIntent,
      navigateToCode: vi.fn(),
    };

    await expect(
      focusKnownVoiceSceneTarget({ kind: "terminal", entityId: terminal.id, title: terminal.title }, actions),
    ).resolves.toBe(true);
    expect(activateWorkspace).toHaveBeenCalledWith(workspace.id);
    expect(actions.listTerminals).toHaveBeenCalledTimes(2);
    expect(selectTerminal).toHaveBeenCalledWith(terminal.id, true, workspace.id);

    await expect(
      focusKnownVoiceSceneTarget({ kind: "thread", entityId: thread.id, title: thread.name }, actions),
    ).resolves.toBe(true);
    expect(actions.getThread).toHaveBeenCalledWith(thread.id);
    expect(focusIntent).toHaveBeenCalledWith({ kind: "thread", threadId: thread.id, workspaceId: workspace.id });
  });

  it("refuses stale known targets instead of falling through to another object", async () => {
    const actions = {
      workspaces: [workspace],
      activeWorkspaceId: null,
      terminals: [terminal],
      getThread: vi.fn().mockRejectedValue(new Error("gone")),
      listTerminals: vi.fn().mockResolvedValue([]),
      activateWorkspace: vi.fn().mockResolvedValue(true),
      selectTerminal: vi.fn(),
      focusIntent: vi.fn().mockResolvedValue(undefined),
      navigateToCode: vi.fn(),
    };
    await expect(
      focusKnownVoiceSceneTarget({ kind: "thread", entityId: "gone", title: "Gone" }, actions),
    ).resolves.toBe(false);
    await expect(
      focusKnownVoiceSceneTarget({ kind: "terminal", entityId: "gone", title: "Gone" }, actions),
    ).resolves.toBe(false);
    expect(actions.focusIntent).not.toHaveBeenCalled();
  });

  it("revalidates a terminal after activation and refuses one removed during the switch", async () => {
    const actions = {
      workspaces: [workspace],
      activeWorkspaceId: null,
      terminals: [terminal],
      getThread: vi.fn().mockResolvedValue(thread),
      listTerminals: vi.fn().mockResolvedValueOnce([terminal]).mockResolvedValueOnce([]),
      activateWorkspace: vi.fn().mockResolvedValue(true),
      selectTerminal: vi.fn(),
      focusIntent: vi.fn().mockResolvedValue(undefined),
      navigateToCode: vi.fn(),
    };
    await expect(
      focusKnownVoiceSceneTarget(
        { kind: "terminal", entityId: terminal.id, title: terminal.title, workspaceId: workspace.id },
        actions,
      ),
    ).resolves.toBe(false);
    expect(actions.selectTerminal).not.toHaveBeenCalled();
    expect(actions.navigateToCode).not.toHaveBeenCalled();
  });

  it("does not focus a terminal when cancellation wins a deferred canonical lookup", async () => {
    const listed = deferred<readonly TerminalInfo[]>();
    const actions = {
      workspaces: [workspace],
      activeWorkspaceId: workspace.id,
      terminals: [terminal],
      getThread: vi.fn().mockResolvedValue(thread),
      listTerminals: vi.fn().mockReturnValue(listed.promise),
      activateWorkspace: vi.fn().mockResolvedValue(true),
      selectTerminal: vi.fn(),
      focusIntent: vi.fn().mockResolvedValue(undefined),
      navigateToCode: vi.fn(),
    };
    const abort = new AbortController();
    const focusing = focusKnownVoiceSceneTarget(
      { kind: "terminal", entityId: terminal.id, title: terminal.title, workspaceId: workspace.id },
      actions,
      abort.signal,
    );

    abort.abort();
    listed.resolve([terminal]);
    await expect(focusing).resolves.toBe(false);
    expect(actions.activateWorkspace).not.toHaveBeenCalled();
    expect(actions.navigateToCode).not.toHaveBeenCalled();
    expect(actions.selectTerminal).not.toHaveBeenCalled();
    expect(actions.focusIntent).not.toHaveBeenCalled();
  });

  it("masks old-owner threads synchronously and ignores its late refresh", async () => {
    const stale = deferred<ThreadSummary[]>();
    const current = deferred<ThreadSummary[]>();
    const oldClient = {
      listThreads: vi.fn().mockResolvedValueOnce([thread]).mockReturnValueOnce(stale.promise),
    } satisfies VoiceSceneThreadClient;
    const newClient = { listThreads: vi.fn().mockReturnValue(current.promise) } satisfies VoiceSceneThreadClient;
    const feed = new TestFeed();
    const view = renderHook(({ client }: { client: VoiceSceneThreadClient }) => useVoiceSceneThreads(client, feed), {
      initialProps: { client: oldClient },
    });
    await waitFor(() => expect(view.result.current.threads).toEqual([thread]));

    let staleRefresh!: Promise<void>;
    act(() => {
      staleRefresh = view.result.current.refresh();
    });
    view.rerender({ client: newClient });
    expect(view.result.current).toMatchObject({ threads: [], loaded: false });

    stale.resolve([{ ...thread, name: "Wrong owner" }]);
    await act(async () => staleRefresh);
    expect(view.result.current).toMatchObject({ threads: [], loaded: false });

    const currentThread = { ...thread, id: "current-thread", name: "Current owner" };
    current.resolve([currentThread]);
    await waitFor(() => expect(view.result.current.threads).toEqual([currentThread]));
  });

  it("clears a loaded snapshot when its next canonical refresh fails", async () => {
    const client = {
      listThreads: vi.fn().mockResolvedValueOnce([thread]).mockRejectedValueOnce(new Error("account unavailable")),
    } satisfies VoiceSceneThreadClient;
    const view = renderHook(() => useVoiceSceneThreads(client, null));
    await waitFor(() => expect(view.result.current.threads).toEqual([thread]));

    await act(async () => view.result.current.refresh());
    expect(view.result.current).toMatchObject({ threads: [], loaded: true });
  });

  it("refreshes when any event after the watermark is scene-relevant", async () => {
    const feed = new TestFeed();
    feed.merge([{ seq: 10, type: "unrelated.initial" }]);
    const changed = { ...thread, status: "completed", currentActivity: "Finished" };
    const client = {
      listThreads: vi.fn().mockResolvedValueOnce([thread]).mockResolvedValueOnce([changed]),
    } satisfies VoiceSceneThreadClient;
    const view = renderHook(() => useVoiceSceneThreads(client, feed));
    await waitFor(() => expect(view.result.current.threads).toEqual([thread]));

    act(() => {
      feed.merge([
        { seq: 12, type: "unrelated.newest" },
        { seq: 11, type: "thread.updated" },
      ]);
    });
    await waitFor(() => expect(view.result.current.threads).toEqual([changed]));
    expect(client.listThreads).toHaveBeenCalledTimes(2);
  });

  it("replays the trace only on an already-focused pane", () => {
    const pane = document.createElement("div");
    expect(replayVoiceFocusTrace(pane)).toBe(false);
    pane.setAttribute("data-focused", "true");
    expect(replayVoiceFocusTrace(pane)).toBe(true);
    expect(pane.getAttribute("data-focused")).toBe("true");
  });
});
