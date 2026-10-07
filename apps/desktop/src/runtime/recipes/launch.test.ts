import type { PaneContent, ProviderAccount, Workspace } from "@kalcode/protocol";
import { describe, expect, it, vi } from "vitest";
import { executeRecipe, type RecipePorts } from "./launch.ts";
import type { PlannedComponent, RecipePreflight } from "./model.ts";

const account = { id: "acc-1", providerId: "claude-code", authenticationState: "authenticated" } as ProviderAccount;
const workspace = { id: "ws-1", name: "KalCode", available: true } as Workspace;

const agent = (key: string, task: string | null = null): PlannedComponent => ({
  kind: "agent",
  key,
  label: key,
  providerId: "claude-code",
  account,
  model: "opus",
  effort: "high",
  name: null,
  task,
});

function preflight(plan: PlannedComponent[], extra: Partial<RecipePreflight> = {}): RecipePreflight {
  return {
    recipe: {
      id: "r1",
      name: "Release desk",
      schemaVersion: 1,
      workspaceId: "ws-1",
      pinned: false,
      position: 0,
      variables: [],
      components: [],
      layout: null,
      updatedAt: "",
    },
    workspace,
    values: {},
    ask: [],
    blockers: [],
    consequences: [],
    plan,
    skipped: [],
    layout: null,
    ...extra,
  };
}

function ports(overrides: Partial<RecipePorts> = {}) {
  let next = 0;
  const base: RecipePorts = {
    createAgent: vi.fn(async () => ({ threadId: `thread-${++next}` })),
    deliverTask: vi.fn(async () => undefined),
    stopAgent: vi.fn(async () => undefined),
    createTerminal: vi.fn(async () => ({ terminalId: `term-${++next}` })),
    runInTerminal: vi.fn(async () => undefined),
    closeTerminal: vi.fn(async () => undefined),
    runningService: vi.fn(async () => null),
    startService: vi.fn(async () => ({ runId: `run-${++next}` })),
    stopService: vi.fn(async () => undefined),
    launchSquad: vi.fn(async () => ({ launchId: "launch-1", operationIds: ["op-1", "op-2"] })),
    cancelOperations: vi.fn(async () => undefined),
    browserContent: (url) => ({ kind: "browser", browserId: `b-${url}`, url }),
    widgetContent: (widget) => ({ kind: "widget", widgetId: widget }),
    openDesk: vi.fn(async () => ({ handled: true as const })),
    newRequestId: () => "req-1",
    now: () => 0,
  };
  return { ...base, ...overrides } as RecipePorts & Record<keyof RecipePorts, ReturnType<typeof vi.fn>>;
}

describe("executeRecipe", () => {
  it("starts every part and opens the desk in Recipe order", async () => {
    const p = ports();
    const summary = await executeRecipe(
      preflight(
        [
          agent("a1"),
          { kind: "terminal", key: "t1", label: "Dev", name: "Dev", command: "pnpm dev" },
          { kind: "browser", key: "b1", label: "localhost", url: "http://localhost:5173/" },
          { kind: "widget", key: "w1", label: "Approvals", widget: "approvals" },
        ],
        { layout: "four" },
      ),
      p,
    );
    expect(summary.failed).toEqual([]);
    expect(summary.started.map((part) => part.key)).toEqual(["a1", "t1", "b1", "w1"]);
    expect(p.runInTerminal).toHaveBeenCalledWith(expect.stringMatching(/^term-/), "pnpm dev");
    const [, contents, preset] = (p.openDesk as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      PaneContent[],
      string,
    ];
    expect(contents.map((content) => content.kind)).toEqual(["agent", "terminal", "browser", "widget"]);
    expect(preset).toBe("four");
  });

  it("keeps independent parts when one fails and reports the reason", async () => {
    const p = ports({
      createAgent: vi.fn(async (part) => {
        if (part.key === "bad") throw new Error("Claude Code needs to reconnect.");
        return { threadId: "thread-ok" };
      }),
    });
    const summary = await executeRecipe(preflight([agent("ok"), agent("bad")]), p);
    expect(summary.started.map((part) => part.key)).toEqual(["ok"]);
    expect(summary.failed).toEqual([
      { key: "bad", kind: "agent", label: "bad", reason: "Claude Code needs to reconnect." },
    ]);
    expect(p.stopAgent).not.toHaveBeenCalled();
  });

  it("closes a terminal whose startup command could not be written (no zombie shell)", async () => {
    const p = ports({ runInTerminal: vi.fn(async () => Promise.reject(new Error("terminal ended"))) });
    const summary = await executeRecipe(
      preflight([{ kind: "terminal", key: "t1", label: "Dev", name: null, command: "pnpm dev" }]),
      p,
    );
    expect(summary.failed[0]?.reason).toBe("terminal ended");
    expect(p.closeTerminal).toHaveBeenCalledTimes(1);
    expect(p.openDesk).not.toHaveBeenCalled();
  });

  it("keeps an agent whose first task wasn't delivered and says so", async () => {
    const p = ports({ deliverTask: vi.fn(async () => Promise.reject(new Error("not ready"))) });
    const summary = await executeRecipe(preflight([agent("a1", "Fix the build")]), p);
    expect(summary.failed).toEqual([]);
    expect(summary.started[0]?.note).toContain("not ready");
    expect(p.stopAgent).not.toHaveBeenCalled();
  });

  it("reuses a running Service instead of starting a duplicate", async () => {
    const p = ports({ runningService: vi.fn(async () => ({ runId: "run-existing" })) });
    const summary = await executeRecipe(
      preflight([{ kind: "service", key: "s1", label: "API", name: "API", command: "pnpm api" }]),
      p,
    );
    expect(p.startService).not.toHaveBeenCalled();
    expect(summary.started[0]).toMatchObject({ reused: true, link: { kind: "service", runId: "run-existing" } });
  });

  it("stops everything it started when cancelled mid-launch", async () => {
    const abort = new AbortController();
    const p = ports({
      createTerminal: vi.fn(async () => {
        abort.abort();
        return { terminalId: "term-x" };
      }),
    });
    const summary = await executeRecipe(
      preflight([
        agent("a1"),
        { kind: "service", key: "s1", label: "API", name: "API", command: "pnpm api" },
        { kind: "terminal", key: "t1", label: "Dev", name: null, command: null },
      ]),
      p,
      { signal: abort.signal, concurrency: 1 },
    );
    expect(summary.started).toEqual([]);
    expect(summary.notice).toMatch(/cancelled/i);
    expect(p.stopAgent).toHaveBeenCalledWith("thread-1");
    expect(p.stopService).toHaveBeenCalledTimes(1);
    expect(p.closeTerminal).toHaveBeenCalledWith("term-x");
    expect(p.openDesk).not.toHaveBeenCalled();
  });

  it("never runs more than the concurrency limit at once", async () => {
    let inFlight = 0;
    let peak = 0;
    const p = ports({
      createAgent: vi.fn(async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight -= 1;
        return { threadId: crypto.randomUUID() };
      }),
    });
    const progress: number[] = [];
    await executeRecipe(preflight(Array.from({ length: 10 }, (_, i) => agent(`a${i}`))), p, {
      concurrency: 4,
      onProgress: (done) => progress.push(done),
    });
    expect(peak).toBe(4);
    expect(progress.at(-1)).toBe(10);
  });

  it("starts nothing when a whole-launch blocker remains", async () => {
    const p = ports();
    const summary = await executeRecipe(
      preflight([agent("a1")], {
        blockers: [
          {
            componentKey: null,
            title: "No project",
            detail: "Open a project first.",
            repair: { kind: "edit" },
            skippable: false,
          },
        ],
      }),
      p,
    );
    expect(p.createAgent).not.toHaveBeenCalled();
    expect(summary.notice).toBe("Open a project first.");
  });

  it("explains when the canvas can't show the desk but keeps the sessions", async () => {
    const p = ports({ openDesk: vi.fn(async () => ({ handled: false as const, message: "No room." })) });
    const summary = await executeRecipe(preflight([agent("a1")]), p);
    expect(summary.started).toHaveLength(1);
    expect(summary.notice).toContain("No room.");
    expect(p.stopAgent).not.toHaveBeenCalled();
  });

  it("cancel undoes a Squad launch and lists whatever couldn't be stopped", async () => {
    const abort = new AbortController();
    const p = ports({
      launchSquad: vi.fn(async () => ({ launchId: "l1", operationIds: ["op-1"] })),
      createTerminal: vi.fn(async () => {
        abort.abort();
        return { terminalId: "term-x" };
      }),
      closeTerminal: vi.fn(async () => Promise.reject(new Error("busy"))),
    });
    const summary = await executeRecipe(
      preflight([
        { kind: "squad", key: "q1", label: "Squad", squadId: "s1", goal: null },
        { kind: "terminal", key: "t1", label: "Dev", name: null, command: null },
      ]),
      p,
      { signal: abort.signal, concurrency: 1 },
    );
    expect(p.cancelOperations).toHaveBeenCalledWith(["op-1"]);
    expect(summary.started.map((part) => part.key)).toEqual(["t1"]);
    expect(summary.started[0]?.note).toMatch(/still running/i);
    expect(summary.notice).toBe("Launch cancelled. 1 of 2 couldn't be stopped and are still running.");
  });
});
