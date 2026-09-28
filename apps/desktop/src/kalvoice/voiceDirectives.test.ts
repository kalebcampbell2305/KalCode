import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type ComposerHandle,
  type ComposerMode,
  type ComposerSubmitOutcome,
  registerComposer,
  resetComposerRegistryForTests,
} from "./composerRegistry.ts";
import {
  type ComposerDirectiveDeps,
  clearComposer,
  composeInThread,
  type DirectiveReport,
  isOpenNewThreadDirective,
  submitComposer,
} from "./voiceDirectives.ts";

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
    clear: vi.fn(() => {
      element.value = "";
    }),
  };
  registerComposer(handle);
  return { element, handle };
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

describe("clear_composer", () => {
  it("empties that composer and never sends", () => {
    const { element, handle } = composer("send");
    element.value = "scratch this";
    const d = deps();
    clearComposer(d, THREAD);
    expect(handle.clear).toHaveBeenCalled();
    expect(handle.submit).not.toHaveBeenCalled();
    expect(element.value).toBe("");
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

describe("open_new_thread guard", () => {
  it("accepts only the documented wire shape", () => {
    expect(
      isOpenNewThreadDirective({
        kind: "open_new_thread",
        providerId: "codex",
        providerAccountId: null,
        workspaceId: null,
      }),
    ).toBe(true);
    expect(
      isOpenNewThreadDirective({
        kind: "open_new_thread",
        providerId: "codex",
        providerAccountId: "a",
        workspaceId: "w",
      }),
    ).toBe(true);
    expect(
      isOpenNewThreadDirective({ kind: "open_new_thread", providerId: "", providerAccountId: null, workspaceId: null }),
    ).toBe(false);
    expect(
      isOpenNewThreadDirective({
        kind: "open_new_thread",
        providerId: "codex",
        providerAccountId: 3,
        workspaceId: null,
      }),
    ).toBe(false);
    expect(isOpenNewThreadDirective({ kind: "open_thread", threadId: "t" })).toBe(false);
    expect(isOpenNewThreadDirective(null)).toBe(false);
  });
});
