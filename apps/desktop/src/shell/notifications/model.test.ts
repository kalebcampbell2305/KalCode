import type { Notification } from "@kalcode/protocol";
import { describe, expect, it } from "vitest";
import { dayGroupOf, KIND_META, targetOf, withDayHeadings } from "./model.ts";

function notification(overrides: Partial<Notification>): Notification {
  return {
    id: "01999a4e-0009-7001-8a2e-000000009001",
    kind: "thread_completed",
    severity: "info",
    title: "Fix login completed",
    body: "Claude Code · kalcode",
    entityKind: "thread",
    entityId: "01999a4e-0002-7001-8a2e-000000002001",
    workspaceId: "01999a4e-0001-7001-8a2e-000000001001",
    createdAt: "2026-09-25T09:00:00.000Z",
    updatedAt: "2026-09-25T09:00:00.000Z",
    readAt: null,
    count: 1,
    ...overrides,
  };
}

describe("notification targets", () => {
  it("focuses the entity each notification is about", () => {
    expect(targetOf(notification({}))).toEqual({
      kind: "thread",
      threadId: "01999a4e-0002-7001-8a2e-000000002001",
      workspaceId: "01999a4e-0001-7001-8a2e-000000001001",
    });
    expect(
      targetOf(notification({ kind: "provider_disconnected", entityKind: "provider", entityId: "codex" })),
    ).toEqual({ kind: "provider", providerId: "codex" });
    expect(targetOf(notification({ kind: "recovery_available", entityKind: null, entityId: null }))).toEqual({
      kind: "dashboard",
      chip: "idle",
    });
    expect(targetOf(notification({ entityKind: "approval" }))).toEqual({ kind: "approvals" });
  });

  it("gives every kind a glyph and a tone, never amber", () => {
    for (const meta of Object.values(KIND_META)) {
      expect(meta.icon).toBeTruthy();
      expect(meta.tone).not.toBe("paused");
    }
  });
});

describe("day headings", () => {
  it("groups today, yesterday and earlier", () => {
    const now = Date.parse("2026-09-25T15:00:00");
    expect(dayGroupOf("2026-09-25T01:00:00", now)).toBe("Today");
    expect(dayGroupOf("2026-09-24T23:00:00", now)).toBe("Yesterday");
    expect(dayGroupOf("2026-09-20T12:00:00", now)).toBe("Earlier");
    const rows = withDayHeadings(
      [
        notification({ id: "a", updatedAt: "2026-09-25T10:00:00" }),
        notification({ id: "b", updatedAt: "2026-09-25T09:00:00" }),
        notification({ id: "c", updatedAt: "2026-09-23T09:00:00" }),
      ],
      now,
    );
    expect(rows.map((r) => (r.kind === "day" ? r.label : r.key))).toEqual(["Today", "a", "b", "Earlier", "c"]);
  });
});
