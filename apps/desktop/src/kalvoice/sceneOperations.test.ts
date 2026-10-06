import type {
  DevelopmentService,
  OperationActivity,
  OperationEnvironment,
  OperationRecord,
  OperationSpec,
  OperationsSnapshot,
} from "@kalcode/protocol";
import { describe, expect, it, vi } from "vitest";
import type { OperationsApi } from "../ipc/operations.ts";
import {
  executeOperationsVoiceChoice,
  handleOperationsVoice,
  isOperationsVoiceText,
  type OperationsVoiceDependencies,
  resolveOperationsVoice,
} from "./sceneOperations.ts";

const spec = (name: string, workspaceId = "workspace-kalcode"): OperationSpec => ({
  name,
  workspaceId,
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

function run(id: string, name: string, status: OperationRecord["status"], endedAt: string | null): OperationRecord {
  return {
    id,
    spec: spec(name),
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
    blockers: status === "blocked" ? ["run-dependency"] : [],
  };
}

function service(id: string, name: string): DevelopmentService {
  return {
    id,
    runId: null,
    name,
    status: "running",
    pid: 100,
    processName: name.toLowerCase().replaceAll(" ", "-"),
    uptimeSeconds: 60,
    ports: [3000],
    urls: ["http://localhost:3000"],
    workspaceId: "workspace-kalcode",
    workspaceName: "KalCode",
    terminalId: "terminal-api",
    canStop: true,
    canRestart: true,
    actionReason: null,
  };
}

const production: OperationEnvironment = {
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
};

const finishedActivity: OperationActivity = {
  id: "activity-finished",
  at: "2026-10-01T10:06:00.000Z",
  kind: "test",
  name: "Tests passed",
  area: "Tests",
  workspaceId: "workspace-kalcode",
  runId: "run-passed",
};

function snapshot(overrides: Partial<OperationsSnapshot> = {}): OperationsSnapshot {
  return {
    revision: 4,
    paused: false,
    items: [
      run("run-old-failed", "Old failure", "failed", "2026-10-01T10:03:00.000Z"),
      run("run-running", "API checks", "running", null),
      run("run-blocked", "Blocked release", "blocked", null),
      run("run-passed", "Latest tests", "succeeded", "2026-10-01T10:06:00.000Z"),
      run("run-new-failed", "Newest failure", "failed", "2026-10-01T10:05:00.000Z"),
    ],
    services: [service("service-api", "API")],
    environments: [production],
    activity: [finishedActivity],
    observedAt: "2026-10-01T10:08:00.000Z",
    warnings: [],
    ...overrides,
  };
}

describe("Operations voice scene resolver", () => {
  it.each([
    ["take me to Operations", "runs"],
    ["open runs", "runs"],
    ["show the queue", "queue"],
    ["show squads", "squads"],
    ["open teams", "squads"],
    ["open services", "services"],
    ["show environments", "environments"],
    ["open activity", "activity"],
  ] as const)("routes %s to the canonical Operations tab", (spoken, tab) => {
    expect(resolveOperationsVoice(spoken, snapshot())).toMatchObject({
      kind: "action",
      target: { kind: "tab", tab },
    });
  });

  it("selects the newest failed run by real timestamps", () => {
    expect(resolveOperationsVoice("open the last failed run", snapshot())).toMatchObject({
      kind: "action",
      target: { kind: "run", tab: "runs", runId: "run-new-failed" },
    });
  });

  it("targets the observed production environment without claiming it is live", () => {
    expect(resolveOperationsVoice("show production", snapshot())).toMatchObject({
      kind: "action",
      target: {
        kind: "environment",
        tab: "environments",
        workspaceId: "workspace-kalcode",
        environment: "production",
      },
    });
  });

  it("asks which workspace instead of guessing between production environments", () => {
    const otherProduction = { ...production, workspaceId: "workspace-other", version: "other" };
    const otherRun = run("other-run", "Other release", "succeeded", "2026-10-01T10:09:00.000Z");
    otherRun.spec = spec("Other release", "workspace-other");
    otherRun.workspaceName = "Other";
    const decision = resolveOperationsVoice("show production", {
      ...snapshot(),
      environments: [production, otherProduction],
      items: [...snapshot().items, otherRun],
    });
    expect(decision).toMatchObject({
      kind: "ambiguous",
      question: "Which workspace's Production environment?",
      choices: [
        { id: "environment:production:workspace-kalcode", label: "Production — KalCode" },
        {
          id: "environment:production:workspace-other",
          label: "Production — Other",
          target: { kind: "environment", workspaceId: "workspace-other", environment: "production" },
        },
      ],
    });
  });

  it("answers completion, running, and blocked status from the current snapshot", () => {
    expect(resolveOperationsVoice("what just finished", snapshot())).toMatchObject({
      kind: "query",
      message: "Latest tests finished: Tests passed.",
      target: { kind: "run", runId: "run-passed" },
    });
    expect(resolveOperationsVoice("what is running", snapshot())).toMatchObject({
      kind: "query",
      message: "API checks is running: Running tests.",
      target: { kind: "run", runId: "run-running" },
    });
    expect(resolveOperationsVoice("what is blocked", snapshot())).toMatchObject({
      kind: "query",
      message: "Blocked release is blocked by 1 dependency.",
      target: { kind: "queue", runId: "run-blocked" },
    });
  });

  it("requires a concise chooser instead of guessing between service aliases", () => {
    const decision = resolveOperationsVoice("restart api service", {
      ...snapshot(),
      services: [service("service-api-a", "API"), service("service-api-b", "API Service")],
    });
    expect(decision).toMatchObject({
      kind: "ambiguous",
      question: "Which API service?",
      choices: [
        { id: "service-api-a", label: "API — KalCode" },
        { id: "service-api-b", label: "API Service — KalCode" },
      ],
    });
  });

  it("does not claim unrelated speech", () => {
    expect(isOperationsVoiceText("refactor the API and run tests")).toBe(false);
    expect(resolveOperationsVoice("refactor the API and run tests", snapshot())).toEqual({ kind: "unhandled" });
  });
});

describe("Operations voice scene dispatcher", () => {
  function dependencies(current = snapshot()): OperationsVoiceDependencies {
    const client = {
      snapshot: vi.fn(async () => current),
      history: vi.fn(async () => ({ items: [], nextCursor: null })),
      serviceAction: vi.fn(async () => undefined),
    } as unknown as OperationsApi;
    const navigate = vi.fn();
    const focus = vi.fn(async () => true);
    return { client, navigate, focus };
  }

  it("navigates and focuses a resolved canonical target", async () => {
    const deps = dependencies();
    const result = await handleOperationsVoice("open the last failed run", deps);
    expect(deps.navigate).toHaveBeenCalledOnce();
    expect(deps.focus).toHaveBeenCalledWith(expect.objectContaining({ kind: "run", runId: "run-new-failed" }));
    expect(result).toMatchObject({ handled: true, status: "completed", target: { runId: "run-new-failed" } });
  });

  it("opens a deterministic tab without waiting for snapshot I/O", async () => {
    const deps = dependencies();
    const result = await handleOperationsVoice("open services", deps);
    expect(deps.client.snapshot).not.toHaveBeenCalled();
    expect(deps.focus).toHaveBeenCalledWith({ kind: "tab", tab: "services" });
    expect(result).toMatchObject({ handled: true, status: "completed", message: "Opened Services." });
  });

  it("routes restart through Operations native authority and preserves its confirmation", async () => {
    const deps = dependencies();
    const result = await handleOperationsVoice("restart the API service", deps);
    expect(deps.client.serviceAction).toHaveBeenCalledWith("service-api", "restart");
    expect(result).toMatchObject({
      handled: true,
      status: "completed",
      message: "API restart started.",
      target: { kind: "service", serviceId: "service-api" },
    });
  });

  it("returns typed choices and performs no effect when the service is ambiguous", async () => {
    const deps = dependencies({
      ...snapshot(),
      services: [service("service-api-a", "API"), service("service-api-b", "API Service")],
    });
    const result = await handleOperationsVoice("restart API service", deps);
    expect(deps.client.serviceAction).not.toHaveBeenCalled();
    expect(deps.navigate).not.toHaveBeenCalled();
    expect(result).toMatchObject({ handled: true, status: "needs_choice", message: "Which API service?" });
  });

  it("loads canonical history when the current snapshot has no failed run", async () => {
    const deps = dependencies({ ...snapshot(), items: [run("run-running", "API checks", "running", null)] });
    vi.mocked(deps.client.history).mockResolvedValue({
      items: [run("historical-failure", "Historical failure", "failed", "2026-09-30T12:00:00.000Z")],
      nextCursor: null,
    });
    const result = await handleOperationsVoice("open last failed run", deps);
    expect(deps.client.history).toHaveBeenCalledWith(null);
    expect(result).toMatchObject({ target: { kind: "run", runId: "historical-failure" } });
  });

  it("reports native cancellation or refusal without claiming restart success", async () => {
    const deps = dependencies();
    vi.mocked(deps.client.serviceAction).mockRejectedValue(
      Object.assign(new Error("Nothing was authorized."), { code: "confirmation_declined" }),
    );
    await expect(handleOperationsVoice("restart API service", deps)).resolves.toMatchObject({
      handled: true,
      status: "failed",
      message: "Nothing was authorized.",
    });
  });

  it("does no snapshot I/O for unrelated terminal dictation", async () => {
    const deps = dependencies();
    await expect(handleOperationsVoice("refactor the API and run tests", deps)).resolves.toEqual({ handled: false });
    expect(deps.client.snapshot).not.toHaveBeenCalled();
  });

  it("revalidates a chosen service by stable id before executing its bound action", async () => {
    const current = {
      ...snapshot(),
      services: [service("service-api-a", "API"), service("service-api-b", "API Service")],
    };
    const deps = dependencies(current);
    const decision = resolveOperationsVoice("restart api service", current);
    if (decision.kind !== "ambiguous") throw new Error("expected ambiguity");
    const choice = decision.choices[1];
    if (!choice) throw new Error("expected second choice");
    const result = await executeOperationsVoiceChoice(choice, deps);
    expect(deps.client.snapshot).toHaveBeenCalledOnce();
    expect(deps.client.serviceAction).toHaveBeenCalledWith("service-api-b", "restart");
    expect(result).toMatchObject({ handled: true, status: "completed", target: { serviceId: "service-api-b" } });
  });

  it("revalidates and focuses a navigation-only chooser target without a side effect", async () => {
    const current = {
      ...snapshot(),
      environments: [production, { ...production, workspaceId: "workspace-other", version: "other" }],
    };
    const deps = dependencies(current);
    const decision = resolveOperationsVoice("show production", current);
    if (decision.kind !== "ambiguous") throw new Error("expected ambiguity");
    const choice = decision.choices[1];
    if (!choice) throw new Error("expected second choice");
    const result = await executeOperationsVoiceChoice(choice, deps);
    expect(deps.client.snapshot).toHaveBeenCalledOnce();
    expect(deps.focus).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "environment", workspaceId: "workspace-other", environment: "production" }),
    );
    expect(deps.client.serviceAction).not.toHaveBeenCalled();
    expect(result).toMatchObject({ handled: true, status: "completed" });
  });

  it("does not restart after cancellation while focus is pending", async () => {
    const controller = new AbortController();
    const deps = dependencies();
    let releaseFocus!: (focused: boolean) => void;
    deps.focus = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          releaseFocus = resolve;
        }),
    );
    deps.signal = controller.signal;
    const pending = handleOperationsVoice("restart API service", deps);
    await vi.waitFor(() => expect(deps.focus).toHaveBeenCalledOnce());
    controller.abort();
    releaseFocus(true);
    await expect(pending).resolves.toMatchObject({
      handled: true,
      status: "failed",
      message: "Voice request cancelled.",
    });
    expect(deps.client.serviceAction).not.toHaveBeenCalled();
  });

  it("reports cancellation when a focus handoff is aborted before it can resolve", async () => {
    const controller = new AbortController();
    const deps = dependencies();
    deps.signal = controller.signal;
    deps.focus = vi.fn(async () => {
      controller.abort();
      return false;
    });
    await expect(handleOperationsVoice("open services", deps)).resolves.toMatchObject({
      handled: true,
      status: "failed",
      message: "Voice request cancelled.",
    });
  });
});
