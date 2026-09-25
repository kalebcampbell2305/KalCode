import type { KalVoiceResponse, ReservedShortcut } from "@kalcode/protocol";
import { describe, expect, it } from "vitest";
import { announcement, formatBytes, INITIAL_STATE, reduce, STATE_LABELS, usageLine } from "./assistantState.ts";
import { insertTranscript, planInsertion, registerDictationSink, resolveDictationTarget } from "./dictation.ts";
import { nudge, placementAt, placementFor, positionFor, sizeClassFor } from "./panelGeometry.ts";
import { checkReserved, displayKey, isTalkKey, talkKeyFromEvent } from "./shortcutModel.ts";

const RESERVED: ReservedShortcut[] = [
  { accelerator: "F5", owner: "reloading the window" },
  { accelerator: "F12", owner: "developer tools" },
];
const ALLOWED = [...Array.from({ length: 24 }, (_, i) => `F${i + 1}`), "Pause", "ScrollLock", "Insert"];
const key = (code: string, extra: Partial<{ key: string; ctrlKey: boolean; shiftKey: boolean }> = {}) => ({
  code,
  key: extra.key ?? code,
  ctrlKey: extra.ctrlKey ?? false,
  metaKey: false,
  altKey: false,
  shiftKey: extra.shiftKey ?? false,
});

describe("push-to-talk key capture", () => {
  it("accepts one supported key on its own", () => {
    expect(talkKeyFromEvent(key("F8"), ALLOWED)).toEqual({ ok: true, value: "F8" });
    expect(talkKeyFromEvent(key("ScrollLock"), ALLOWED)).toEqual({ ok: true, value: "ScrollLock" });
    expect(talkKeyFromEvent(key("Pause"), ALLOWED)).toEqual({ ok: true, value: "Pause" });
    expect(displayKey("ScrollLock")).toBe("Scroll Lock");
  });

  it("explains keys it can't use", () => {
    expect(talkKeyFromEvent(key("F8", { ctrlKey: true }), ALLOWED)).toMatchObject({ code: "talk_key_single" });
    expect(talkKeyFromEvent(key("Fn", { key: "Fn" }), ALLOWED)).toMatchObject({ code: "talk_key_unsupported" });
    expect(talkKeyFromEvent(key("CapsLock"), ALLOWED)).toMatchObject({ code: "talk_key_unsupported" });
    expect(talkKeyFromEvent(key("ControlRight", { key: "Control" }), ALLOWED)).toMatchObject({
      code: "talk_key_unsupported",
    });
    expect(talkKeyFromEvent(key("KeyK", { key: "k" }), ALLOWED)).toMatchObject({ code: "talk_key_invalid" });
    expect(talkKeyFromEvent(key("Space", { key: " " }), ALLOWED)).toMatchObject({ code: "talk_key_invalid" });
  });

  it("refuses keys KalCode uses and matches key events", () => {
    expect(checkReserved("F5", RESERVED)).toEqual({
      ok: false,
      code: "talk_key_conflict",
      message: "F5 is used for reloading the window in KalCode.",
    });
    expect(checkReserved("F8", RESERVED)).toEqual({ ok: true, value: "F8" });
    expect(isTalkKey(key("F8"), "F8")).toBe(true);
    expect(isTalkKey(key("F8", { shiftKey: true }), "F8")).toBe(false);
    expect(isTalkKey(key("F9"), "F8")).toBe(false);
  });
});

describe("dictation insertion", () => {
  it("inserts at the caret with a separating space", () => {
    expect(planInsertion("fix the", 7, 7, " parser bug ")).toEqual({
      value: "fix the parser bug",
      caret: 18,
      inserted: " parser bug",
    });
    expect(planInsertion("", 0, 0, "hello")).toMatchObject({ value: "hello", caret: 5 });
    expect(planInsertion("say (", 5, 5, "hi")).toMatchObject({ value: "say (hi" });
    expect(planInsertion("done", 4, 4, ". Next")).toMatchObject({ value: "done. Next" });
    // Replaces a selection.
    expect(planInsertion("one two three", 4, 7, "2")).toMatchObject({ value: "one 2 three", caret: 5 });
  });

  it("targets focused text fields, not buttons or read-only fields", () => {
    const input = document.createElement("input");
    const readOnly = document.createElement("textarea");
    readOnly.readOnly = true;
    const password = document.createElement("input");
    password.type = "password";
    const button = document.createElement("button");
    document.body.append(input, readOnly, password, button);
    expect(resolveDictationTarget(input)?.kind).toBe("field");
    expect(resolveDictationTarget(readOnly)).toBeNull();
    expect(resolveDictationTarget(password)).toBeNull();
    expect(resolveDictationTarget(button)).toBeNull();
    expect(resolveDictationTarget(document.body)).toBeNull();
    document.body.replaceChildren();
  });

  it("inserts into a field and notifies React-style listeners", () => {
    const area = document.createElement("textarea");
    area.value = "Add";
    document.body.append(area);
    area.setSelectionRange(3, 3);
    let seen = "";
    area.addEventListener("input", () => {
      seen = area.value;
    });
    const target = resolveDictationTarget(area);
    if (!target) throw new Error("no target");
    expect(insertTranscript(target, "a unit test")).toBe(12);
    expect(seen).toBe("Add a unit test");
    expect(area.selectionStart).toBe(15);
    document.body.replaceChildren();
  });

  it("routes registered surfaces (terminals) to their sink", () => {
    const terminal = document.createElement("div");
    const hidden = document.createElement("textarea");
    terminal.append(hidden);
    document.body.append(terminal);
    const written: string[] = [];
    const unregister = registerDictationSink(terminal, { label: "Terminal", insert: (t) => written.push(t) });
    const target = resolveDictationTarget(hidden);
    expect(target?.kind).toBe("sink");
    if (target) insertTranscript(target, "npm test");
    expect(written).toEqual(["npm test"]);
    unregister();
    expect(resolveDictationTarget(hidden)?.kind).toBe("field");
    document.body.replaceChildren();
  });
});

describe("panel geometry", () => {
  const viewport = { width: 1440, height: 900 };
  const panel = { width: 300, height: 200 };

  it("classifies window sizes", () => {
    expect(sizeClassFor(1024)).toBe("narrow");
    expect(sizeClassFor(1280)).toBe("regular");
    expect(sizeClassFor(1440)).toBe("regular");
    expect(sizeClassFor(1920)).toBe("wide");
  });

  it("positions docked panels inside the margins", () => {
    expect(positionFor({ anchor: "bottom_right", x: 0, y: 0 }, viewport, panel)).toEqual({ left: 1124, top: 684 });
    expect(positionFor({ anchor: "top_left", x: 999, y: 999 }, viewport, panel)).toEqual({ left: 16, top: 16 });
    expect(positionFor({ anchor: "right", x: 0, y: 500 }, viewport, panel)).toEqual({ left: 1124, top: 350 });
    expect(positionFor({ anchor: "free", x: 500, y: 500 }, viewport, panel)).toEqual({ left: 570, top: 350 });
  });

  it("clamps to the viewport even when the window is smaller than the panel", () => {
    const tiny = { width: 200, height: 100 };
    expect(positionFor({ anchor: "bottom_right", x: 0, y: 0 }, tiny, panel)).toEqual({ left: 16, top: 16 });
  });

  it("docks drops near edges and corners, else stays free", () => {
    expect(placementAt({ left: 1120, top: 690 }, viewport, panel).anchor).toBe("bottom_right");
    expect(placementAt({ left: 20, top: 20 }, viewport, panel).anchor).toBe("top_left");
    expect(placementAt({ left: 5000, top: -40 }, viewport, panel).anchor).toBe("top_right");
    const edge = placementAt({ left: 20, top: 400 }, viewport, panel);
    expect(edge.anchor).toBe("left");
    expect(positionFor(edge, viewport, panel).top).toBe(400);
    const free = placementAt({ left: 600, top: 300 }, viewport, panel);
    expect(free.anchor).toBe("free");
    expect(positionFor(free, viewport, panel)).toEqual({ left: 600, top: 300 });
  });

  it("keeps proportions when the window resizes", () => {
    const free = placementAt({ left: 570, top: 350 }, viewport, panel);
    expect(positionFor(free, { width: 1024, height: 700 }, panel)).toEqual({ left: 362, top: 250 });
  });

  it("moves with the keyboard and re-docks", () => {
    const start = { anchor: "bottom_right" as const, x: 1000, y: 1000 };
    const moved = nudge(start, -200, 0, viewport, panel);
    expect(moved.anchor).toBe("bottom");
    const at = positionFor(moved, viewport, panel);
    // Stored in thousandths of the free space, so within a pixel.
    expect(Math.abs(at.left - 924)).toBeLessThanOrEqual(1);
    expect(at.top).toBe(684);
    const back = nudge(moved, 400, 0, viewport, panel);
    expect(back.anchor).toBe("bottom_right");
  });

  it("falls back to the default anchor per size class", () => {
    const saved = [{ sizeClass: "wide" as const, anchor: "top_left" as const, x: 0, y: 0, view: "orb" as const }];
    expect(placementFor(saved, "wide", "bottom_right").anchor).toBe("top_left");
    expect(placementFor(saved, "narrow", "bottom_right")).toMatchObject({ anchor: "bottom_right", view: "compact" });
  });
});

describe("assistant state", () => {
  const response = (outcome: KalVoiceResponse["outcome"], requestId = "r1"): KalVoiceResponse => ({
    requestId,
    intent: "navigate",
    outcome,
    usage: { used: 3, allowance: 250, periodStart: "2026-09-01T00:00:00.000Z", resetsAt: "2026-10-01T00:00:00.000Z" },
    counted: true,
    directive: null,
  });

  it("follows a spoken command through every stage", () => {
    let s = reduce(INITIAL_STATE, {
      type: "signal",
      signal: { kind: "listening_started", sessionId: "s1", mode: "command" },
    });
    expect(STATE_LABELS[s.phase]).toBe("Listening");
    s = reduce(s, { type: "signal", signal: { kind: "partial", sessionId: "s1", text: "open four" } });
    expect(s.partial).toBe("open four");
    s = reduce(s, { type: "signal", signal: { kind: "transcribing", sessionId: "s1", mode: "command" } });
    expect(STATE_LABELS[s.phase]).toBe("Processing");
    s = reduce(s, { type: "submitted", requestId: "r1" });
    expect(STATE_LABELS[s.phase]).toBe("Processing");
    s = reduce(s, { type: "signal", signal: { kind: "request_stage", requestId: "r1", stage: "executing" } });
    expect(STATE_LABELS[s.phase]).toBe("Executing");
    s = reduce(s, {
      type: "talked",
      talk: { requestId: "r1", text: "go to settings", route: "command", hadTarget: true },
    });
    s = reduce(s, { type: "response", response: response({ kind: "completed", summary: "Opened Settings." }) });
    expect(STATE_LABELS[s.phase]).toBe("Done");
    expect(s.lastTalk?.hadTarget).toBe(true);
    expect(announcement(s)).toBe("KalVoice: Done. Opened Settings.");
    s = reduce(s, { type: "typed_instead", message: "Typed instead." });
    expect(s.lastTalk).toBeNull();
    s = reduce(s, { type: "settle" });
    expect(STATE_LABELS[s.phase]).toBe("Ready");
  });

  it("maps outcomes to permission and error states", () => {
    const submitted = reduce(INITIAL_STATE, { type: "submitted", requestId: "r1" });
    const waiting = reduce(submitted, {
      type: "response",
      response: response({ kind: "permission_required", approvalRequestId: "a" }),
    });
    expect(STATE_LABELS[waiting.phase]).toBe("Needs Approval");
    expect(waiting.approvalRequestId).toBe("a");
    const needs = reduce(submitted, {
      type: "response",
      response: response({ kind: "needs_provider", message: "Connect a supported AI provider." }),
    });
    expect(needs).toMatchObject({ phase: "error", code: "needs_provider" });
    const limit = reduce(submitted, {
      type: "response",
      response: response({ kind: "limit_reached", resetsAt: "2026-10-01T00:00:00.000Z" }),
    });
    expect(limit.message).toContain("reset Oct 1");
  });

  it("ignores stale signals and responses", () => {
    const submitted = reduce(INITIAL_STATE, { type: "submitted", requestId: "r2" });
    expect(reduce(submitted, { type: "response", response: response({ kind: "completed", summary: "x" }, "r1") })).toBe(
      submitted,
    );
    expect(
      reduce(submitted, { type: "signal", signal: { kind: "request_stage", requestId: "r1", stage: "executing" } }),
    ).toBe(submitted);
  });

  it("formats usage and sizes", () => {
    expect(usageLine({ used: 412, allowance: 2500, periodStart: "", resetsAt: "2026-10-01T00:00:00.000Z" })).toBe(
      "Used 412 of 2,500 · resets Oct 1",
    );
    expect(usageLine({ used: 9, allowance: null, periodStart: "", resetsAt: "" })).toContain("unlimited");
    expect(formatBytes(147_964_211)).toBe("148 MB");
    expect(formatBytes(1_533_763_059)).toBe("1.5 GB");
  });
});
