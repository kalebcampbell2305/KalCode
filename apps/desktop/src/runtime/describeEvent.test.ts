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
    correlation: {
      workspaceId: null,
      threadId: null,
      missionId: null,
      providerId: null,
      requestId: null,
      agentId: null,
      taskId: null,
      automationId: null,
      causationId: null,
    },
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

  it("names providers by their display names", () => {
    const found = envelope({
      type: "provider.detected",
      payload: { providerId: "claude-code", installed: true, version: "2.1.282" },
    });
    expect(describeEvent(found)).toEqual({
      title: "Provider detected",
      detail: "Claude Code 2.1.282",
      tone: "success",
    });
    const missing = envelope({
      type: "provider.detected",
      payload: { providerId: "gemini-cli", installed: false, version: null },
    });
    expect(describeEvent(missing)).toEqual({ title: "Provider not installed", detail: "Gemini CLI", tone: "idle" });
    const failed = envelope({
      type: "provider.error",
      payload: { providerId: "codex", code: "version_timeout", message: "The version check didn't finish in time." },
    });
    expect(describeEvent(failed)).toEqual({
      title: "Codex couldn't be checked",
      detail: "The version check didn't finish in time.",
      tone: "danger",
    });
  });

  it("describes provider health and capacity transitions in plain words", () => {
    const degraded = envelope({
      type: "provider.health_changed",
      payload: { providerId: "codex", from: "healthy", to: "degraded", reason: "recent_failures" },
    });
    expect(describeEvent(degraded)).toEqual({
      title: "Codex health: healthy → degraded (recent failures)",
      detail: null,
      tone: "waiting",
    });
    const healthy = envelope({
      type: "provider.health_changed",
      payload: { providerId: "claude-code", from: "unknown", to: "healthy", reason: "healthy" },
    });
    expect(describeEvent(healthy).title).toBe("Claude Code health: unknown → healthy");
    const signedOut = envelope({
      type: "provider.health_changed",
      payload: { providerId: "gemini-cli", from: "healthy", to: "unavailable", reason: "signed_out" },
    });
    expect(describeEvent(signedOut)).toMatchObject({
      title: "Gemini CLI health: healthy → unavailable (signed out)",
      tone: "danger",
    });
    const backingOff = envelope({
      type: "provider.capacity_changed",
      payload: { providerId: "codex", state: "backing_off", activeSessions: 1, limit: null, retryAt: null },
    });
    expect(describeEvent(backingOff)).toEqual({
      title: "Codex is backing off",
      detail: "Codex reported a rate limit or quota error.",
      tone: "waiting",
    });
    const available = envelope({
      type: "provider.capacity_changed",
      payload: { providerId: "claude-code", state: "available", activeSessions: 2, limit: null, retryAt: null },
    });
    expect(describeEvent(available)).toEqual({
      title: "Claude Code can take new work",
      detail: "2 active sessions",
      tone: "idle",
    });
    expect(
      describeEvent(
        envelope({
          type: "provider.capacity_changed",
          payload: { providerId: "codex", state: "saturated", activeSessions: 4, limit: null, retryAt: null },
        }),
      ).detail,
    ).toBeNull();
  });

  it("handles events from newer builds", () => {
    const d = describeEvent(
      envelope({ type: "unrecognized", payload: { originalType: "thread.created", originalVersion: 2 } }),
    );
    expect(d.title).toBe("Event from a newer KalCode");
  });

  it("distinguishes successful, failed and interrupted agent turns", () => {
    const turn = (ok: boolean, interrupted: boolean) =>
      describeEvent(
        envelope({
          type: "agent.turn_completed",
          payload: { threadId: "thread-1", ok, interrupted },
        }),
      );
    expect(turn(true, false)).toEqual({ title: "Agent turn completed", detail: null, tone: "success" });
    expect(turn(false, false)).toEqual({ title: "Agent turn failed", detail: null, tone: "danger" });
    expect(turn(false, true)).toEqual({ title: "Agent turn interrupted", detail: null, tone: "waiting" });
  });

  it("describes Git, context and resource events without content", () => {
    expect(
      describeEvent(
        envelope({
          type: "git.commit_created",
          payload: {
            workspaceId: "w",
            worktreeId: null,
            oid: "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
            byKalCode: true,
          },
        }),
      ),
    ).toEqual({ title: "Commit created by KalCode", detail: "4b825dc", tone: "success" });
    expect(
      describeEvent(
        envelope({
          type: "context.shared",
          payload: { packageId: "p", threadId: null, providerId: "codex", items: 1, bytes: 10, redactions: 0 },
        }),
      ).detail,
    ).toBe("1 item with Codex");
    const pressure = describeEvent(
      envelope({
        type: "resource.pressure_changed",
        payload: {
          resource: "memory",
          from: "high",
          to: "critical",
          mode: "balanced",
          signal: { signal: "memory_used_percent" },
          value: 97,
          threshold: 95,
        },
      }),
    );
    expect(pressure).toEqual({ title: "Memory pressure critical", detail: "Was high", tone: "danger" });
    expect(
      describeEvent(
        envelope({ type: "resource.task_released", payload: { taskId: "t", heldMs: 90_000, cause: "override" } }),
      ).detail,
    ).toBe("Waited 2 min");
  });

  it("says where a push-to-talk utterance went, never what was said", () => {
    const routed = (outcome: "command" | "dictation" | "request") =>
      describeEvent(envelope({ type: "kalvoice.talk_routed", payload: { requestId: "r", outcome } }));
    expect(routed("command")).toEqual({ title: "KalVoice heard a command", detail: null, tone: "idle" });
    expect(routed("dictation").title).toBe("KalVoice heard dictation for the focused box");
    expect(routed("request").title).toBe("KalVoice heard a request");
  });

  it("describes Doctor lifecycle events without finding or environment contents", () => {
    expect(describeEvent(envelope({ type: "doctor.run_started", payload: { runId: "run-1", checks: 12 } }))).toEqual({
      title: "Environment check started",
      detail: "12 checks",
      tone: "live",
    });
    expect(
      describeEvent(
        envelope({
          type: "doctor.run_completed",
          payload: {
            runId: "run-1",
            checks: 12,
            critical: 1,
            warning: 2,
            info: 3,
            couldNotCheck: 1,
            ignored: 0,
            cancelled: false,
          },
        }),
      ),
    ).toEqual({
      title: "Environment check completed",
      detail: "1 critical finding, 2 warnings, 1 check unavailable",
      tone: "danger",
    });
    expect(
      describeEvent(
        envelope({
          type: "doctor.fix_failed",
          payload: { runId: "run-1", findingCode: "file.env", fixCode: "file.gitignore_env", code: "stale" },
        }),
      ),
    ).toEqual({ title: "Environment fix failed", detail: "file.gitignore_env · stale", tone: "danger" });
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
