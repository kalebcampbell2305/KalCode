import type { ThreadStatus } from "@kalcode/protocol";
import { beforeEach, describe, expect, it } from "vitest";
import {
  ACTION_KINDS,
  ATTENTION_THREAD_STATUSES,
  approvalFlood,
  buildApprovalRequest,
  buildEvent,
  buildEventEnvelope,
  buildNormalizedAction,
  buildProviderDetection,
  buildThreadSummary,
  busyWorkspace,
  createClock,
  createFixtures,
  createIdFactory,
  DEFAULT_EPOCH,
  eventStream,
  failures,
  isUuidV7,
  isValidId,
  LIVE_THREAD_STATUSES,
  resetFixtures,
  samplePayloads,
  TERMINAL_THREAD_STATUSES,
  THREAD_STATUSES,
} from "./index.ts";

beforeEach(() => {
  resetFixtures();
});

describe("deterministic ids", () => {
  it("issues canonical, increasing UUIDv7 ids", () => {
    const ids = createIdFactory();
    const issued = Array.from({ length: 500 }, () => ids.next());
    for (const id of issued) {
      expect(isValidId(id)).toBe(true);
      expect(isUuidV7(id)).toBe(true);
      expect(id).toBe(id.toLowerCase());
    }
    expect(new Set(issued).size).toBe(issued.length);
    expect([...issued].sort()).toEqual(issued);
    expect(ids.issued).toBe(500);
  });

  it("encodes the epoch in the UUIDv7 timestamp", () => {
    const id = createIdFactory({ epoch: DEFAULT_EPOCH }).next();
    const ms = Number.parseInt(id.replaceAll("-", "").slice(0, 12), 16);
    expect(new Date(ms).toISOString()).toBe(DEFAULT_EPOCH);
  });

  it("is reproducible per seed and differs across seeds", () => {
    const a = createIdFactory({ seed: 7 });
    const b = createIdFactory({ seed: 7 });
    const c = createIdFactory({ seed: 8 });
    const first = [a.next(), a.next(), a.next()];
    expect([b.next(), b.next(), b.next()]).toEqual(first);
    expect([c.next(), c.next(), c.next()]).not.toEqual(first);
  });

  it("rejects what Rust `is_valid_id` rejects", () => {
    for (const bad of ["", "not-an-id", "0192f3c4000070008000000000000000", "../../etc/passwd", "a".repeat(36)]) {
      expect(isValidId(bad)).toBe(false);
    }
  });
});

describe("fixture clock", () => {
  it("formats like Rust now_rfc3339 and only moves on tick", () => {
    const clock = createClock({ start: "2026-01-02T03:04:05.006Z", stepMs: 500 });
    expect(clock.now()).toBe("2026-01-02T03:04:05.006Z");
    expect(clock.now()).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(clock.tick()).toBe("2026-01-02T03:04:05.506Z");
    expect(clock.offset(-1_000)).toBe("2026-01-02T03:04:04.506Z");
    expect(clock.now()).toBe("2026-01-02T03:04:05.506Z");
  });

  it("rejects an invalid start", () => {
    expect(() => createClock({ start: "yesterday" })).toThrow("Invalid clock start");
  });
});

describe("builders", () => {
  it("produces identical data for the same seed", () => {
    const build = () => {
      const fx = createFixtures({ seed: 42 });
      return [fx.buildThreadSummary(), fx.buildApprovalRequest(), fx.buildEvent("thread.started", { threadId: "t" })];
    };
    expect(build()).toEqual(build());
  });

  it("derives consistent thread state from the status", () => {
    const failed = buildThreadSummary({ status: "failed" });
    expect(failed.error?.message).toBeTruthy();
    const waiting = buildThreadSummary({ status: "waiting_for_permission" });
    expect(waiting.pendingApprovals).toBe(1);
    expect(waiting.currentActivity).toBeTruthy();
    const idle = buildThreadSummary();
    expect(idle).toMatchObject({ status: "idle", error: null, pendingApprovals: 0, providerName: "Claude Code" });
  });

  it("lets overrides win, `undefined` keep the default, and `null` clear a field", () => {
    const thread = buildThreadSummary({ status: "failed", name: "Custom", error: undefined, branch: null });
    expect(thread.name).toBe("Custom");
    expect(thread.error).not.toBeNull();
    expect(buildThreadSummary({ status: "failed", error: null }).error).toBeNull();
  });

  it("puts threads and actions in one default workspace", () => {
    const a = buildThreadSummary();
    const b = buildThreadSummary();
    const action = buildNormalizedAction({ threadId: a.id });
    expect(a.workspaceId).toBe(b.workspaceId);
    expect(action.workspaceId).toBe(a.workspaceId);
    expect(isValidId(a.workspaceId)).toBe(true);
  });

  it("summarizes actions and derives scopes for approvals", () => {
    const fx = createFixtures();
    const install = fx.buildNormalizedAction({
      action: fx.buildActionKind("package_install", { packages: ["zod"] }),
    });
    expect(install.summary).toBe("Install zod with npm");
    const push = fx.buildApprovalRequest({ action: fx.buildNormalizedAction({ action: fx.buildActionKind("git") }) });
    expect(push.decision.scopes).toEqual(["git.push"]);
    expect(push).toMatchObject({ status: "pending", resolvedDecision: null, resolvedAt: null });
  });

  it("resolves approvals consistently with their status", () => {
    expect(buildApprovalRequest({ status: "approved" })).toMatchObject({ resolvedDecision: "approve_once" });
    expect(buildApprovalRequest({ status: "denied" })).toMatchObject({ resolvedDecision: "deny" });
    const expired = buildApprovalRequest({ status: "expired" });
    expect(expired.resolvedDecision).toBeNull();
    expect(expired.resolvedAt).not.toBeNull();
  });

  it("wraps payloads in envelopes with increasing seq and derived correlation", () => {
    const first = buildEvent("approval.requested", {
      requestId: "r1",
      threadId: "t1",
      scopes: ["terminal.execute"],
      summary: "Run npm test",
    });
    const second = buildEventEnvelope({ type: "settings.changed", payload: { keys: ["theme"] } });
    expect(first.seq).toBe(1);
    expect(second.seq).toBe(2);
    expect(first.correlation).toEqual({
      workspaceId: null,
      threadId: "t1",
      missionId: null,
      providerId: null,
      requestId: "r1",
      agentId: null,
      taskId: null,
      automationId: null,
      causationId: null,
    });
    expect(first).toMatchObject({ type: "approval.requested", version: 1, source: "core" });
    expect(second.source).toBe("ui");
    expect(buildEvent("unrecognized", { originalType: "x.y", originalVersion: 3 }).version).toBe(3);
  });

  it("serializes to the wire shape (flattened type/payload)", () => {
    const event = buildEvent("thread.started", { threadId: "t1" });
    const wire = JSON.parse(JSON.stringify(event)) as Record<string, unknown>;
    expect(Object.keys(wire).sort()).toEqual(
      ["correlation", "id", "occurredAt", "payload", "seq", "source", "type", "version"].sort(),
    );
  });

  it("builds provider detections for every state", () => {
    expect(buildProviderDetection()).toMatchObject({ state: "installed", auth: "authenticated", message: null });
    expect(buildProviderDetection({ state: "not_installed" })).toMatchObject({ version: null, displayPath: null });
    expect(buildProviderDetection({ state: "outdated" }).message).toMatch(/older/);
    expect(buildProviderDetection({ providerId: "codex" }).displayName).toBe("Codex");
  });
});

describe("status sets", () => {
  it("covers all 18 thread states without duplicates", () => {
    expect(THREAD_STATUSES).toHaveLength(18);
    expect(new Set(THREAD_STATUSES).size).toBe(18);
  });

  it("keeps the Rust helper subsets inside the full set", () => {
    const all = new Set<ThreadStatus>(THREAD_STATUSES);
    for (const subset of [LIVE_THREAD_STATUSES, ATTENTION_THREAD_STATUSES, TERMINAL_THREAD_STATUSES]) {
      for (const status of subset) expect(all.has(status)).toBe(true);
    }
  });
});

describe("scenarios", () => {
  it("busy workspace: one thread per status, coherent approvals and events", () => {
    const scenario = busyWorkspace();
    expect(scenario.threads.map((t) => t.status)).toEqual([...THREAD_STATUSES]);
    const threadIds = new Set(scenario.threads.map((t) => t.id));
    expect(threadIds.size).toBe(18);
    for (const thread of scenario.threads) expect(thread.workspaceId).toBe(scenario.workspace.id);

    const waiting = scenario.threads.filter((t) => t.status === "waiting_for_permission");
    expect(scenario.approvals).toHaveLength(waiting.length);
    for (const approval of scenario.approvals) expect(threadIds.has(approval.action.threadId)).toBe(true);

    const seqs = scenario.events.map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(scenario.events.map((e) => e.id)).size).toBe(scenario.events.length);
    expect(scenario.events.filter((e) => e.type === "thread.created")).toHaveLength(18);
    expect(new Set(scenario.threads.map((t) => t.providerId)).size).toBe(3);
  });

  it("approval flood: pending counts match the approvals per thread", () => {
    const count = ACTION_KINDS.length + 3;
    const scenario = approvalFlood({ count, threads: 4 });
    expect(scenario.approvals).toHaveLength(count);
    for (const thread of scenario.threads) {
      const mine = scenario.approvals.filter((a) => a.action.threadId === thread.id);
      expect(thread.pendingApprovals).toBe(mine.length);
      expect(thread.status).toBe("waiting_for_permission");
    }
    expect(new Set(scenario.approvals.map((a) => a.action.action.kind))).toEqual(new Set(ACTION_KINDS));
    expect(scenario.events.filter((e) => e.type === "approval.requested")).toHaveLength(count);
  });

  it("approval flood clamps the thread count", () => {
    expect(approvalFlood({ count: 2, threads: 10 }).threads).toHaveLength(2);
    expect(approvalFlood({ count: 0 }).approvals).toHaveLength(0);
  });

  it("failures: errors on failed threads and every broken provider state", () => {
    const scenario = failures();
    for (const thread of scenario.threads.filter((t) => t.status === "failed")) {
      expect(thread.error).not.toBeNull();
    }
    expect(scenario.providers.map((p) => p.state).sort()).toEqual(["error", "installed", "not_installed", "outdated"]);
    expect(scenario.approvals.map((a) => a.status).sort()).toEqual(["denied", "expired"]);
    const types = new Set(scenario.events.map((e) => e.type));
    for (const type of ["thread.failed", "tool.failed", "provider.error", "app.previous_session_interrupted"]) {
      expect(types.has(type as never)).toBe(true);
    }
  });

  it("sample payloads cover every event type exactly once", () => {
    const samples = samplePayloads();
    for (const [type, sample] of Object.entries(samples)) expect(sample.type).toBe(type);
  });

  it("event stream cycles through every type with increasing seq", () => {
    const events = eventStream(100);
    expect(events).toHaveLength(100);
    expect(events.map((e) => e.seq)).toEqual(Array.from({ length: 100 }, (_, i) => i + 1));
    expect(new Set(events.map((e) => e.type)).size).toBe(Object.keys(samplePayloads()).length);
  });

  it("scenarios are deterministic", () => {
    expect(busyWorkspace(createFixtures({ seed: 3 }))).toEqual(busyWorkspace(createFixtures({ seed: 3 })));
  });
});
