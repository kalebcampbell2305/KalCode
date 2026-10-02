import type { LocatorResult } from "@kalcode/protocol";
import { describe, expect, it } from "vitest";
import {
  resolveVoiceSceneTarget,
  sceneChoiceLabel,
  sceneTargetFromLocator,
  type VoiceSceneTarget,
} from "./sceneTargets.ts";

const target = (
  partial: Partial<VoiceSceneTarget> & Pick<VoiceSceneTarget, "entityId" | "title">,
): VoiceSceneTarget => ({
  kind: "thread",
  ...partial,
});

describe("KalVoice scene target resolution", () => {
  it("matches a provider and task naturally, but never chooses equal best matches", () => {
    const choices = [
      target({ entityId: "website", title: "Website refresh", aliases: ["Claude 1"], providerId: "claude-code" }),
      target({ entityId: "api", title: "API hardening", aliases: ["Claude 2"], providerId: "claude-code" }),
    ];

    expect(
      resolveVoiceSceneTarget({ kind: "named", query: "Claude working on the website" }, { targets: choices }),
    ).toEqual({
      kind: "resolved",
      target: choices[0],
    });
    expect(resolveVoiceSceneTarget({ kind: "named", query: "Claude" }, { targets: choices })).toEqual({
      kind: "ambiguous",
      choices,
    });
  });

  it("keeps current, last-target and other references distinct", () => {
    const current = target({ entityId: "codex-a", title: "Updater", aliases: ["Codex A"], focused: true });
    const other = target({ entityId: "codex-b", title: "Tests", aliases: ["Codex B"] });
    const targets = [current, other];

    expect(resolveVoiceSceneTarget({ kind: "current" }, { targets })).toEqual({ kind: "resolved", target: current });
    expect(resolveVoiceSceneTarget({ kind: "last_target" }, { targets, lastTarget: other })).toEqual({
      kind: "resolved",
      target: other,
    });
    expect(
      resolveVoiceSceneTarget(
        { kind: "last_target" },
        { targets: [{ ...other, status: "completed" }], lastTarget: other },
      ),
    ).toEqual({ kind: "resolved", target: { ...other, status: "completed" } });
    expect(resolveVoiceSceneTarget({ kind: "other", query: "Codex" }, { targets })).toEqual({
      kind: "resolved",
      target: other,
    });
  });

  it("resolves the horizontally adjacent visible pane and reports a geometric tie", () => {
    const current = target({
      entityId: "current",
      title: "Current",
      focused: true,
      visible: true,
      rect: { x: 100, y: 0, width: 100, height: 100 },
    });
    const left = target({
      entityId: "left",
      title: "Left",
      visible: true,
      rect: { x: 0, y: 0, width: 100, height: 100 },
    });
    const right = target({
      entityId: "right",
      title: "Right",
      visible: true,
      rect: { x: 200, y: 0, width: 100, height: 100 },
    });

    expect(resolveVoiceSceneTarget({ kind: "beside_current" }, { targets: [current, left, right] })).toEqual({
      kind: "ambiguous",
      choices: [left, right],
    });
    expect(resolveVoiceSceneTarget({ kind: "beside_current" }, { targets: [current, right] })).toEqual({
      kind: "resolved",
      target: right,
    });
  });

  it("uses status and timestamp for just-finished and last-failed references", () => {
    const oldDone = target({ entityId: "old", title: "Old", status: "done", updatedAt: "2026-01-01T00:00:00Z" });
    const latestDone = target({
      entityId: "latest",
      title: "Latest",
      status: "completed",
      updatedAt: "2026-01-02T00:00:00Z",
    });
    const failed = target({ entityId: "failed", title: "Failed", status: "failed", updatedAt: "2026-01-03T00:00:00Z" });
    const targets = [oldDone, latestDone, failed];

    expect(resolveVoiceSceneTarget({ kind: "latest_completed" }, { targets })).toEqual({
      kind: "resolved",
      target: latestDone,
    });
    expect(resolveVoiceSceneTarget({ kind: "latest_failed" }, { targets })).toEqual({
      kind: "resolved",
      target: failed,
    });
  });

  it("filters kinds and workspace before resolving", () => {
    const raw = target({ kind: "terminal", entityId: "raw", title: "Release", workspaceId: "kalcode" });
    const thread = target({ entityId: "thread", title: "Release", workspaceId: "website" });
    expect(
      resolveVoiceSceneTarget(
        { kind: "named", query: "Release terminal" },
        { targets: [raw, thread], kinds: ["terminal"], workspaceId: "kalcode" },
      ),
    ).toEqual({ kind: "resolved", target: raw });
  });

  it("applies a spoken kind hint before matching a same-named surface", () => {
    const providerThread = target({ entityId: "claude-browser", title: "Browser work", aliases: ["Browser"] });
    const browserPane = target({ kind: "browser", entityId: "browser", title: "Browser" });
    expect(
      resolveVoiceSceneTarget(
        { kind: "named", query: "terminal working on Browser", kinds: ["terminal", "thread"] },
        { targets: [browserPane, providerThread] },
      ),
    ).toEqual({ kind: "resolved", target: providerThread });
  });

  it("matches only at word boundaries while retaining useful spoken prefixes", () => {
    const rapid = target({ entityId: "rapid", title: "Rapid" });
    const api = target({ entityId: "api", title: "API service" });
    const authentication = target({ entityId: "auth", title: "Authentication" });

    expect(resolveVoiceSceneTarget({ kind: "named", query: "API" }, { targets: [rapid] })).toEqual({
      kind: "not_found",
    });
    expect(resolveVoiceSceneTarget({ kind: "named", query: "API" }, { targets: [rapid, api] })).toEqual({
      kind: "resolved",
      target: api,
    });
    expect(resolveVoiceSceneTarget({ kind: "named", query: "auth" }, { targets: [authentication] })).toEqual({
      kind: "resolved",
      target: authentication,
    });
  });

  it("labels duplicate chooser rows with readable workspace, provider and account context", () => {
    const frontend = target({
      entityId: "frontend",
      title: "Release",
      workspaceName: "Website",
      providerId: "claude-code",
      accountLabel: "Claude A",
    });
    const backend = target({
      entityId: "backend",
      title: "Release",
      workspaceName: "API",
      providerName: "Codex",
      accountLabel: "Codex B",
    });

    expect(sceneChoiceLabel(frontend)).toBe("Release — Website · Claude Code · Claude A");
    expect(sceneChoiceLabel(backend)).toBe("Release — API · Codex · Codex B");
    expect(sceneChoiceLabel(frontend)).not.toBe(sceneChoiceLabel(backend));
  });

  it("adapts locator results without carrying snippets or match metadata", () => {
    const result: LocatorResult = {
      kind: "terminal",
      entityId: "terminal",
      title: "Release",
      subtitle: "Terminal · KalCode · running",
      status: "running",
      workspaceId: "workspace",
      providerId: null,
      updatedAt: "2026-01-01T00:00:00Z",
      snippet: "redacted locator context",
      score: 9,
      semantic: false,
      highlights: [],
    };
    expect(sceneTargetFromLocator(result)).toEqual({
      kind: "terminal",
      entityId: "terminal",
      title: "Release",
      subtitle: "Terminal · KalCode · running",
      status: "running",
      workspaceId: "workspace",
      providerId: null,
      updatedAt: "2026-01-01T00:00:00Z",
    });
  });
});
