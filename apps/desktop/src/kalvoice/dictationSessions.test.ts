import { describe, expect, it } from "vitest";
import { DictationSessions } from "./dictationSessions.ts";

describe("DictationSessions", () => {
  it("keeps the captured target immutable when focus changes", () => {
    const sessions = new DictationSessions<string>();
    sessions.setFocusedTarget("first field");
    const capture = sessions.captureFocusedTarget();

    sessions.setFocusedTarget("second field");
    sessions.open("session-1", capture);

    expect(sessions.claim("session-1")?.target).toBe("first field");
  });

  it("exposes the frozen pane target when focus changes before native listening starts", () => {
    const sessions = new DictationSessions<{ paneId: string; destination: string }>();
    sessions.setFocusedTarget({ paneId: "pane-codex-personal", destination: "thread-personal" });
    const capture = sessions.captureFocusedTarget();

    // The native start is asynchronous. A click during that gap must not retarget either
    // delivery or the listening indicator to the newly focused pane.
    sessions.setFocusedTarget({ paneId: "pane-codex-work", destination: "thread-work" });
    const opened = sessions.open("native-session-1", capture);

    expect(opened?.target).toEqual({ paneId: "pane-codex-personal", destination: "thread-personal" });
    expect(sessions.claim("native-session-1")?.target).toEqual({
      paneId: "pane-codex-personal",
      destination: "thread-personal",
    });
  });

  it("keeps an explicit no-target capture instead of falling back to later focus", () => {
    const sessions = new DictationSessions<string>();
    sessions.setFocusedTarget(null);
    const capture = sessions.captureFocusedTarget();
    sessions.setFocusedTarget("later field");

    sessions.open("session-1", capture);

    expect(sessions.claim("session-1")?.target).toBeNull();
  });

  it("uses the already tracked keyboard target when native listening starts", () => {
    const sessions = new DictationSessions<string>();
    sessions.setFocusedTarget("keyboard field");

    sessions.open("session-1");
    sessions.setFocusedTarget("later field");

    expect(sessions.claim("session-1")?.target).toBe("keyboard field");
  });

  it("accepts a result exactly once and ignores stale sessions", () => {
    const sessions = new DictationSessions<string>();
    sessions.setFocusedTarget("field");
    sessions.open("session-1");

    expect(sessions.claim("session-1")).not.toBeNull();
    expect(sessions.claim("session-1")).toBeNull();
    expect(sessions.claim("unknown")).toBeNull();
  });

  it("aborts an in-flight delivery and removes the session on cancellation", () => {
    const sessions = new DictationSessions<string>();
    sessions.open("session-1");
    const claimed = sessions.claim("session-1");
    expect(claimed?.signal.aborted).toBe(false);
    expect(sessions.has("session-1")).toBe(true);

    expect(sessions.cancel("session-1")).toBe(true);

    expect(claimed?.signal.aborted).toBe(true);
    expect(sessions.has("session-1")).toBe(false);
    expect(sessions.claim("session-1")).toBeNull();
    expect(sessions.size).toBe(0);
  });

  it("opening a newer native session aborts and removes stale work", () => {
    const sessions = new DictationSessions<string>();
    sessions.open("session-1");
    const first = sessions.claim("session-1");
    sessions.open("session-2");

    expect(first?.signal.aborted).toBe(true);
    expect(sessions.claim("session-1")).toBeNull();
    expect(sessions.size).toBe(1);
  });

  it("abandons a failed explicit capture without changing the focused target", () => {
    const sessions = new DictationSessions<string>();
    sessions.setFocusedTarget("field");
    const capture = sessions.captureFocusedTarget();
    sessions.abandonCapture(capture);

    sessions.open("keyboard-session");

    expect(sessions.claim("keyboard-session")?.target).toBe("field");
  });
});
