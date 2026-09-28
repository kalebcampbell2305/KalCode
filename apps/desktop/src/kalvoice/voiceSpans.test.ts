import { afterEach, describe, expect, it } from "vitest";
import { forgetVoiceText, planVoiceClear, recordVoiceInsertion, resetVoiceSpansForTests } from "./voiceSpans.ts";

const T = "thread-1";

/** Records a voice insert of `inserted` at `start` (replacing `[start, end)`) into `before`. */
function voice(before: string, start: number, inserted: string, end = start): string {
  const after = before.slice(0, start) + inserted + before.slice(end);
  recordVoiceInsertion(T, { before, start, end, inserted, after });
  return after;
}

afterEach(() => resetVoiceSpansForTests());

describe("voice spans", () => {
  it("clears consecutive dictations, including the separating spaces KalVoice added", () => {
    let box = voice("", 0, "first");
    box = voice(box, box.length, " second");
    expect(planVoiceClear(T, box)).toEqual({ kind: "clear", value: "", caret: 0 });
  });

  it("keeps the person's text around dictated spans that it doesn't touch", () => {
    let box = voice("Typed A.", 8, " voice one");
    // The person types elsewhere (not against the dictated words), then dictates again.
    box = `Typed B. ${box}`;
    box = voice(box, 0, "voice two ");
    expect(box).toBe("voice two Typed B. Typed A. voice one");
    expect(planVoiceClear(T, box)).toEqual({ kind: "clear", value: "Typed B. Typed A.", caret: 0 });
  });

  it("refuses when an edit lands inside or against a span", () => {
    const box = voice("Keep ", 5, "fix it");
    expect(planVoiceClear(T, box.replace("fix", "fox"))).toEqual({ kind: "ambiguous" });
    expect(planVoiceClear(T, `${box}.`)).toEqual({ kind: "ambiguous" });
    expect(planVoiceClear(T, box.replace("Keep ", "Keep"))).toEqual({ kind: "ambiguous" });
  });

  it("stays refused once a later dictation replaces part of earlier voice text", () => {
    const box = voice("", 0, "one two three");
    const next = voice(box, 4, "2", 7);
    expect(planVoiceClear(T, next)).toEqual({ kind: "ambiguous" });
  });

  it("has nothing to clear when nothing was dictated, after a send, or when the box is empty", () => {
    expect(planVoiceClear(T, "typed")).toEqual({ kind: "nothing" });
    const box = voice("", 0, "hello");
    expect(planVoiceClear(T, "")).toEqual({ kind: "nothing" });
    voice("", 0, "hello");
    forgetVoiceText(T);
    expect(planVoiceClear(T, `${box} and typed`)).toEqual({ kind: "nothing" });
  });
});
