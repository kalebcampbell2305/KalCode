import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type ComposerHandle,
  type ComposerMode,
  type ComposerSubmitOutcome,
  composerForThread,
  registerComposer,
  resetComposerRegistryForTests,
} from "./composerRegistry.ts";
import { insertTranscript } from "./dictation.ts";
import {
  type ComposerDirectiveDeps,
  clearComposer,
  composeInThread,
  type DirectiveReport,
  followUpChoice,
  submitComposer,
} from "./voiceDirectives.ts";
import { forgetVoiceText, resetVoiceSpansForTests } from "./voiceSpans.ts";

const THREAD = "0192f3c4-0000-7000-8000-00000000d001";

function composer(mode: ComposerMode, outcome: ComposerSubmitOutcome = "sent") {
  const element = document.createElement("textarea");
  element.id = "thread-composer";
  document.body.append(element);
  const handle: ComposerHandle = {
    threadId: THREAD,
    identity: () => ({
      threadId: THREAD,
      threadName: "Authentication",
      providerId: "claude-code",
      providerName: "Claude Code",
      accountLabel: null,
    }),
    element: () => element,
    mode: () => mode,
    blockedReason: () => (mode === "blocked" ? "Messages can be sent once the permission decision is made." : null),
    hasText: () => element.value.trim() !== "",
    submit: vi.fn(async () => outcome),
  };
  const registration = registerComposer(handle) && composerForThread(THREAD);
  if (!registration) throw new Error("not registered");
  /** Dictates at the caret exactly as push to talk does (recording what KalVoice typed). */
  const dictate = (text: string) =>
    insertTranscript({ kind: "composer", element, composer: registration, paneId: null }, text);
  /** The person types at the caret (not KalVoice). */
  const type = (text: string, at = element.value.length) => {
    element.value = element.value.slice(0, at) + text + element.value.slice(at);
  };
  return { element, handle, dictate, type };
}

function deps(): ComposerDirectiveDeps & { reports: DirectiveReport[]; opened: string[] } {
  const reports: DirectiveReport[] = [];
  const opened: string[] = [];
  return {
    reports,
    opened,
    openThread: (id) => opened.push(id),
    report: (result) => reports.push(result),
    waitMs: 50,
  };
}

afterEach(() => {
  resetComposerRegistryForTests();
  resetVoiceSpansForTests();
  document.body.replaceChildren();
});

describe("submit_composer", () => {
  it("presses the composer's own Send", async () => {
    const { element, handle } = composer("send");
    element.value = "review the login failure";
    const d = deps();
    await submitComposer(d, THREAD);
    expect(handle.submit).toHaveBeenCalledTimes(1);
    expect(d.reports).toEqual([{ ok: true, message: "Sent to “Authentication”." }]);
  });

  it("stops at the warning dialog and says so", async () => {
    const { element } = composer("send", "confirm");
    element.value = "password: hunter2";
    const d = deps();
    await submitComposer(d, THREAD);
    expect(d.reports[0]?.message).toMatch(/Nothing is sent until you confirm it/);
  });

  it("never resumes a stopped thread, never sends while a permission is pending, never sends nothing", async () => {
    for (const [mode, text, expected] of [
      ["resume", "go on", /isn't running\. Press Resume and send/],
      ["blocked", "go on", /^Messages can be sent once the permission decision is made\.$/],
      ["send", "   ", /has no message to send/],
    ] as const) {
      const { element, handle } = composer(mode);
      element.value = text;
      const d = deps();
      await submitComposer(d, THREAD);
      expect(handle.submit).not.toHaveBeenCalled();
      expect(d.reports[0]).toMatchObject({ ok: false, message: expect.stringMatching(expected) });
      resetComposerRegistryForTests();
    }
  });

  it("refuses when the thread's composer isn't on screen", async () => {
    const d = deps();
    await submitComposer(d, THREAD);
    expect(d.reports).toEqual([{ ok: false, message: "That thread's message box isn't open. Nothing was sent." }]);
  });
});

describe("clear_composer (only what KalVoice typed)", () => {
  it("clears text that KalVoice alone typed, and never sends", async () => {
    const { element, handle, dictate } = composer("send");
    await dictate("scratch this");
    await dictate("and this too");
    const d = deps();
    clearComposer(d, THREAD);
    expect(element.value).toBe("");
    expect(handle.submit).not.toHaveBeenCalled();
    expect(d.reports).toEqual([{ ok: true, message: "Cleared what KalVoice typed. Nothing was sent." }]);
  });

  it("removes only the dictated span from typed + voice text", async () => {
    const { element, dictate, type } = composer("send");
    type("Keep this:");
    await dictate("review the login failure");
    // The person types more, away from the dictated words.
    type("NOTE ", 0);
    const d = deps();
    clearComposer(d, THREAD);
    expect(element.value).toBe("NOTE Keep this:");
    expect(d.reports[0]).toEqual({ ok: true, message: "Cleared what KalVoice typed. Nothing was sent." });
  });

  it("refuses and changes nothing when the person edited in or right next to the dictated text", async () => {
    for (const edit of [
      (e: HTMLTextAreaElement) => {
        e.value = e.value.replace("login", "logout");
      },
      (e: HTMLTextAreaElement) => {
        e.value = `${e.value}!!`;
      },
    ]) {
      const { element, dictate, type } = composer("send");
      type("Keep this:");
      await dictate("review the login failure");
      edit(element);
      const before = element.value;
      const d = deps();
      clearComposer(d, THREAD);
      expect(element.value).toBe(before);
      expect(d.reports).toEqual([{ ok: false, message: "I couldn't tell which text I typed — clear it yourself." }]);
      resetComposerRegistryForTests();
      resetVoiceSpansForTests();
      document.body.replaceChildren();
    }
  });

  it("after a send there is nothing to clear, and the person's new text is kept", async () => {
    const { element, dictate, type } = composer("send");
    await dictate("send me");
    // The composer's own Send empties the box and forgets what KalVoice typed.
    element.value = "";
    forgetVoiceText(THREAD);
    type("my own words");
    const d = deps();
    clearComposer(d, THREAD);
    expect(element.value).toBe("my own words");
    expect(d.reports).toEqual([{ ok: true, message: "Nothing to clear." }]);
  });
});

describe("compose_in_thread", () => {
  it("opens the thread, inserts the text and sends through the composer", async () => {
    const { element, handle } = composer("send");
    const d = deps();
    await composeInThread(d, { threadId: THREAD, text: "Review the latest login failure.", submit: true });
    expect(d.opened).toEqual([THREAD]);
    expect(element.value).toBe("Review the latest login failure.");
    expect(handle.submit).toHaveBeenCalledTimes(1);
  });

  it("inserts only when submit is false", async () => {
    const { element, handle } = composer("send");
    const d = deps();
    await composeInThread(d, { threadId: THREAD, text: "draft", submit: false });
    expect(element.value).toBe("draft");
    expect(handle.submit).not.toHaveBeenCalled();
  });

  it("refuses a thread waiting for permission without inserting", async () => {
    const { element, handle } = composer("blocked");
    const d = deps();
    await composeInThread(d, { threadId: THREAD, text: "go ahead", submit: true });
    expect(element.value).toBe("");
    expect(handle.submit).not.toHaveBeenCalled();
    expect(d.reports).toEqual([{ ok: false, message: "Messages can be sent once the permission decision is made." }]);
  });

  it("keeps the text for a stopped thread and never resumes it by voice", async () => {
    const { element, handle } = composer("resume");
    const d = deps();
    await composeInThread(d, { threadId: THREAD, text: "continue", submit: true });
    expect(element.value).toBe("continue");
    expect(handle.submit).not.toHaveBeenCalled();
    expect(d.reports[0]?.message).toMatch(/press Resume and send/);
  });

  it("never sends an unsent draft along without the person seeing it", async () => {
    const { element, handle } = composer("send");
    element.value = "half-written";
    const d = deps();
    await composeInThread(d, { threadId: THREAD, text: "and this", submit: true });
    expect(element.value).toBe("half-written and this");
    expect(handle.submit).not.toHaveBeenCalled();
    expect(d.reports[0]?.message).toMatch(/already had an unsent message/);
  });

  it("refuses when the thread's composer never appears", async () => {
    const d = deps();
    await composeInThread(d, { threadId: THREAD, text: "hello", submit: true });
    expect(d.reports[0]).toMatchObject({ ok: false });
  });
});

describe("clarification follow-up", () => {
  const choice = {
    threadId: THREAD,
    name: "Authentication",
    providerId: "claude-code" as const,
    providerName: "Claude Code",
    accountLabel: "Work",
    workspaceId: "w",
    workspaceName: "kalcode",
    status: "idle" as const,
    label: "Authentication · Claude Code · Work",
  };

  it("echoes “Sending to Name · Provider · Account” before sending through the composer", async () => {
    const { handle } = composer("send");
    const d = deps();
    const order: string[] = [];
    const report = d.report;
    d.report = (result) => {
      order.push(`report:${result.message}`);
      report(result);
    };
    (handle.submit as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      order.push("submit");
      return "sent";
    });
    await followUpChoice({ ...d, focusThread: () => undefined }, choice, {
      kind: "compose",
      text: "run the linter",
      submit: true,
    });
    expect(order).toEqual([
      "report:Sending to Authentication · Claude Code · Work.",
      "submit",
      "report:Sent to “Authentication”.",
    ]);
  });

  it("no echo when the follow-up only fills the box", async () => {
    composer("send");
    const d = deps();
    await followUpChoice({ ...d, focusThread: () => undefined }, choice, {
      kind: "compose",
      text: "draft",
      submit: false,
    });
    expect(d.reports.map((r) => r.message)).toEqual(["Added to “Authentication”. Nothing was sent."]);
  });
});
