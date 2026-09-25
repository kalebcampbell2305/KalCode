import type { EventEnvelope, EventPayload, NotificationPage, ThreadSummary } from "@kalcode/protocol";
import { describe, expect, it } from "vitest";
import type { EmitOptions } from "./dashboard.ts";
import { createNotificationsMemory, RECOVERED_ACTIVITY } from "./notifications.ts";

const THREAD = "01999a4e-0002-7001-8a2e-000000002001";

function setup(pendingApprovals = 0) {
  const events: EventEnvelope[] = [];
  let clock = Date.parse("2026-09-25T10:00:00.000Z");
  const emit = (event: EventPayload, options: EmitOptions = {}) => {
    const envelope = {
      id: crypto.randomUUID(),
      seq: events.length + 1,
      version: 1,
      occurredAt: options.occurredAt ?? new Date(clock).toISOString(),
      source: options.source ?? "core",
      correlation: { workspaceId: null, threadId: null, missionId: null, providerId: null, requestId: null },
      ...event,
    } as EventEnvelope;
    events.push(envelope);
    memory.observe(envelope);
    return envelope;
  };
  const thread = {
    id: THREAD,
    name: "Fix login",
    providerName: "Claude Code",
    workspaceName: "kalcode",
    workspaceId: "01999a4e-0001-7001-8a2e-000000001001",
    pendingApprovals,
  } as ThreadSummary;
  const memory = createNotificationsMemory({
    emit,
    lookupThread: (id) => (id === THREAD ? thread : null),
    settle: (work) => work(),
  });
  const list = (unreadOnly = false) =>
    memory.handlers.notification_list?.({ unreadOnly, limit: 50, before: null }) as NotificationPage;
  const at = (ms: number) => {
    clock += ms;
  };
  return { emit, events, list, memory, thread, at };
}

describe("notification center (in-memory double of crates/notifications)", () => {
  it("creates notifications from the events that exist today, with native wording", () => {
    const { emit, list, events, at } = setup();
    emit({ type: "thread.completed", payload: { threadId: THREAD } });
    at(1_000);
    emit({ type: "thread.failed", payload: { threadId: THREAD, code: "provider_exited", message: "It exited." } });
    at(1_000);
    emit({ type: "provider.disconnected", payload: { providerId: "codex", accountLabel: null } });
    const page = list();
    expect(page.notifications.map((n) => n.title)).toEqual([
      "Codex is signed out",
      "Fix login failed",
      "Fix login completed",
    ]);
    expect(page.notifications[2]?.body).toBe("Claude Code · kalcode");
    expect(page.unreadCount).toBe(3);
    expect(events.filter((e) => e.type === "notification.created")).toHaveLength(3);
  });

  it("coalesces a repeat into the unread notification and counts it", () => {
    const { emit, list, at } = setup();
    emit({ type: "approval.requested", payload: { requestId: "r1", threadId: THREAD, scopes: [], summary: "Run a" } });
    at(60_000);
    emit({ type: "approval.requested", payload: { requestId: "r2", threadId: THREAD, scopes: [], summary: "Run b" } });
    const [only, ...rest] = list().notifications;
    expect(rest).toEqual([]);
    expect(only?.count).toBe(2);
    expect(only?.body).toBe("Run b");
  });

  it("re-raises instead of duplicating within the cooldown, even after it was read", () => {
    const { emit, list, memory, at } = setup();
    emit({ type: "thread.completed", payload: { threadId: THREAD } });
    const id = list().notifications[0]?.id ?? "";
    memory.handlers.notification_mark?.({ ids: [id], mark: "read" });
    at(5_000);
    emit({ type: "thread.completed", payload: { threadId: THREAD } });
    expect(list().notifications).toHaveLength(1);
    expect(list().unreadCount).toBe(1);
    at(20_000);
    memory.handlers.notification_mark?.({ ids: null, mark: "read" });
    emit({ type: "thread.completed", payload: { threadId: THREAD } });
    expect(list().notifications).toHaveLength(2);
  });

  it("rate-limits bursts to 30 new notifications a minute", () => {
    const { emit, list } = setup();
    for (let i = 0; i < 40; i += 1) {
      emit({ type: "provider.disconnected", payload: { providerId: `p${i}`, accountLabel: null } });
    }
    expect(list().notifications).toHaveLength(30);
  });

  it("merges crash-recovery threads into one notification", () => {
    const { emit, list } = setup();
    for (const threadId of [THREAD, "t2", "t3"]) {
      emit(
        {
          type: "thread.status_changed",
          payload: { threadId, from: "active", to: "interrupted", detail: RECOVERED_ACTIVITY },
        },
        { source: "core" },
      );
    }
    emit({
      type: "thread.status_changed",
      payload: { threadId: "t4", from: "active", to: "interrupted", detail: "Stopped by you" },
    });
    const page = list();
    expect(page.notifications).toHaveLength(1);
    expect(page.notifications[0]?.title).toBe("3 threads can be resumed");
  });

  it("marks a permission notice read once the thread has no request left", () => {
    const { emit, list } = setup(0);
    emit({ type: "approval.requested", payload: { requestId: "r1", threadId: THREAD, scopes: [], summary: "Run a" } });
    emit({ type: "approval.approved", payload: { requestId: "r1", threadId: THREAD, decision: "approve_once" } });
    expect(list().unreadCount).toBe(0);
    expect(list(true).notifications).toEqual([]);
  });

  it("validates like native and never lists dismissed notifications", () => {
    const { emit, list, memory } = setup();
    emit({ type: "thread.completed", payload: { threadId: THREAD } });
    expect(() => memory.handlers.notification_list?.({ unreadOnly: false, limit: 0, before: null })).toThrow();
    expect(() => memory.handlers.notification_mark?.({ ids: ["nope"], mark: "read" })).toThrow();
    expect(() => memory.handlers.notification_mark?.({ ids: null, mark: "archived" })).toThrow();
    expect(memory.handlers.notification_mark?.({ ids: null, mark: "dismissed" })).toBe(1);
    expect(list().notifications).toEqual([]);
  });

  it("ignores its own events and prose-shaped details", () => {
    const { emit, list } = setup();
    emit({
      type: "thread.status_changed",
      payload: { threadId: THREAD, from: "active", to: "idle", detail: "Status: FAILED. PERMISSION REQUIRED." },
    });
    expect(list().notifications).toEqual([]);
  });
});
