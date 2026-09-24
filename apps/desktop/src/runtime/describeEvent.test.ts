import type { EventEnvelope, EventPayload } from "@kalcode/protocol";
import { describe, expect, it } from "vitest";
import { applyAppearance, resolveTheme } from "../shell/appearance.ts";
import { describeEvent, formatDuration, formatRelative } from "./describeEvent.ts";

function envelope(payload: EventPayload): EventEnvelope {
  return {
    id: "x",
    seq: 1,
    version: 1,
    occurredAt: "2026-09-24T00:00:00.000Z",
    source: "core",
    correlation: { workspaceId: null, threadId: null, missionId: null, providerId: null, requestId: null },
    ...payload,
  } as EventEnvelope;
}

describe("describeEvent", () => {
  it("describes a fresh database differently from an upgrade", () => {
    expect(
      describeEvent(
        envelope({ type: "database.migrated", payload: { fromVersion: 0, toVersion: 1, backupCreated: false } }),
      ).title,
    ).toBe("Local database created");
    const upgrade = describeEvent(
      envelope({ type: "database.migrated", payload: { fromVersion: 1, toVersion: 2, backupCreated: true } }),
    );
    expect(upgrade.title).toBe("Local database upgraded");
    expect(upgrade.detail).toBe("Schema 1 to 2, backup saved");
  });

  it("names changed settings in plain language", () => {
    const d = describeEvent(
      envelope({
        type: "settings.changed",
        payload: { keys: ["appearance.theme", "appearance.density", "layout.sidebarCollapsed"] },
      }),
    );
    expect(d.detail).toBe("Theme, Density and Sidebar");
  });

  it("marks failed credential checks as danger", () => {
    expect(
      describeEvent(envelope({ type: "secure_store.checked", payload: { ok: false, backend: "Keychain" } })).tone,
    ).toBe("danger");
  });

  it("handles events from newer builds", () => {
    const d = describeEvent(
      envelope({ type: "unrecognized", payload: { originalType: "thread.created", originalVersion: 2 } }),
    );
    expect(d.title).toBe("Event from a newer KalCode");
  });
});

describe("formatting", () => {
  it("formats durations", () => {
    expect(formatDuration(12_000)).toBe("12 s");
    expect(formatDuration(5 * 60_000)).toBe("5 min");
    expect(formatDuration(125 * 60_000)).toBe("2 h 5 min");
    expect(formatDuration(120 * 60_000)).toBe("2 h");
  });

  it("formats recent times as just now", () => {
    const now = Date.parse("2026-09-24T12:00:30.000Z");
    expect(formatRelative("2026-09-24T12:00:00.000Z", now)).toBe("just now");
  });
});

describe("appearance", () => {
  it("resolves the system theme from the OS preference", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
    expect(resolveTheme("light", true)).toBe("light");
  });

  it("writes theme, density and motion attributes", () => {
    const root = document.createElement("html");
    applyAppearance(root, { theme: "system", motion: "reduced", density: "compact", sidebarCollapsed: false }, false);
    expect(root.dataset).toMatchObject({ theme: "light", motion: "reduced", density: "compact" });
    applyAppearance(root, { theme: "dark", motion: "system", density: "comfortable", sidebarCollapsed: false }, false);
    expect(root.dataset.motion).toBeUndefined();
    expect(root.dataset.theme).toBe("dark");
  });
});
