import type { KalVoiceStatus, SurfaceFlag, TalkResponse, UiDirective } from "@kalcode/protocol";
import { ToastProvider, TooltipProvider } from "@kalcode/ui/components";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccountProvider } from "../account/AccountProvider.tsx";
import { AccountClient } from "../ipc/account.ts";
import { KalCodeClient } from "../ipc/client.ts";
import { createMemoryTransport, type MemoryTransport } from "../ipc/memoryTransport.ts";
import type { CommandName } from "../ipc/transport.ts";
import { resetFocusHistoryForTests } from "../runtime/focusHistory.ts";
import { RuntimeProvider } from "../runtime/RuntimeProvider.tsx";
import nativeStableSurfaces from "../shell/fixtures/stable-native-surfaces.json";
import { Shell } from "../shell/Shell.tsx";
import { resetAccountIntentForTests } from "../surfaces/threads/accountIntent.ts";
import { composerForThread, resetComposerRegistryForTests } from "./composerRegistry.ts";
import { resetVoiceSpansForTests } from "./voiceSpans.ts";

// TK-2 on the Stable channel, end to end through the real Shell, KalVoice provider and the
// in-memory runtime (its fake recognizer "hears" what each test sets): a focused thread composer
// is a fixed voice target, and every voice send goes through that composer's own Send.
vi.mock("@xterm/xterm", () => ({ Terminal: class {} }));

const PARSER = "Write Unit Tests for Parser Module";
const OAUTH = "Fix OAuth Callback Race";
const DARK_MODE = "Add Dark Mode Toggle";

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  resetComposerRegistryForTests();
  resetVoiceSpansForTests();
  resetAccountIntentForTests();
  resetFocusHistoryForTests();
});

interface Harness {
  transport: MemoryTransport;
  client: KalCodeClient;
  calls: { command: CommandName; args: Record<string, unknown> | undefined }[];
  /** The next push-to-talk answer is this command directive instead of the double's own. */
  injectDirective: (directive: UiDirective) => void;
  user: ReturnType<typeof userEvent.setup>;
}

async function mountStable(): Promise<Harness> {
  const transport = createMemoryTransport("threads", { detectDelayMs: 0 });
  const calls: Harness["calls"] = [];
  let injected: UiDirective | null = null;
  const invoke = transport.invoke.bind(transport);
  transport.invoke = (async <T,>(command: CommandName, args?: Record<string, unknown>): Promise<T> => {
    calls.push({ command, args });
    if (command === "kalvoice_talk" && injected) {
      const directive = injected;
      injected = null;
      const status = await invoke<KalVoiceStatus>("kalvoice_status", {});
      return {
        route: "command",
        recognizedMs: 1,
        response: {
          requestId: String((args?.request as { requestId?: string } | undefined)?.requestId),
          intent: directive.kind,
          outcome: { kind: "completed", summary: "Done." },
          usage: status.usage,
          counted: true,
          directive,
        },
      } satisfies TalkResponse as T;
    }
    return invoke<T>(command, args);
  }) as typeof transport.invoke;
  const client = new KalCodeClient(transport);
  const boot = await client.boot();
  boot.info.channel = "stable";
  boot.info.flags.surfaces = (nativeStableSurfaces as SurfaceFlag[]).map((flag) => ({ ...flag }));
  boot.info.flags.features = boot.info.flags.features.map((flag) => ({ ...flag, visible: flag.state === "available" }));
  render(
    <ToastProvider>
      <TooltipProvider>
        <AccountProvider client={new AccountClient(transport)}>
          <RuntimeProvider client={client} info={boot.info} initialSettings={await client.getSettings()}>
            <Shell />
          </RuntimeProvider>
        </AccountProvider>
      </TooltipProvider>
    </ToastProvider>,
  );
  await screen.findByRole("region", { name: "KalVoice widget" });
  return {
    transport,
    client,
    calls,
    injectDirective: (directive) => {
      injected = directive;
    },
    user: userEvent.setup(),
  };
}

const widget = () => screen.getByRole("region", { name: "KalVoice widget" });
const detail = () => screen.getByRole("region", { name: "Thread" });
const composer = () => within(detail()).getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement;
const sent = (h: Harness, command: "thread_send" | "thread_resume" = "thread_send") =>
  h.calls.filter((c) => c.command === command);

async function openThread(h: Harness, name: string) {
  const primary = within(screen.getByRole("navigation", { name: "Primary" }));
  if (!screen.queryByRole("heading", { level: 1, name: "Threads" })) {
    await h.user.click(primary.getByRole("button", { name: "Threads" }));
  }
  const list = await screen.findByRole("list", { name: "Threads" });
  // The row itself, never its "Pin globally: <name>" favorite action (#235).
  const row = new RegExp(`^(?!(?:Pin|Unpin) globally: |(?:Add|Remove) Favorite: ).*${name}`);
  await h.user.click(await within(list).findByRole("button", { name: row }));
  await waitFor(() => expect(within(detail()).getByRole("heading", { name })).toBeInTheDocument());
  await waitFor(() => expect(composerForThread(threadIdOf(name))).not.toBeNull());
}

let threadIds = new Map<string, string>();
function threadIdOf(name: string): string {
  const id = threadIds.get(name);
  if (!id) throw new Error(`unknown thread ${name}`);
  return id;
}

async function learnThreads(h: Harness) {
  threadIds = new Map((await h.client.listThreads({ includeArchived: false })).map((t) => [t.name, t.id]));
}

/** Holds the talk key, checks what the widget shows while listening, then releases it. */
async function talk(h: Harness, text: string, whileListening?: () => void | Promise<void>) {
  h.transport.kalvoice.setTranscript(text);
  fireEvent.keyDown(window, { code: "F8", key: "F8" });
  await within(widget()).findByText("Listening", { exact: true });
  await whileListening?.();
  fireEvent.keyUp(window, { code: "F8", key: "F8" });
  await waitFor(() => expect(within(widget()).queryByText(/^(Done|Error)$/)).not.toBeNull(), { timeout: 4000 });
}

/** A widget message (shown and announced, so it may appear twice). */
async function findInWidget(text: string) {
  await waitFor(() => expect(within(widget()).getAllByText(text).length).toBeGreaterThan(0));
}

/** The non-modal "Which one?" card (the widget repeats the question as its result line). */
async function choicePanel(): Promise<HTMLElement> {
  const list = await screen.findByRole("list", { name: "Sessions" });
  return list.closest("section") as HTMLElement;
}

async function focusComposer() {
  act(() => composer().focus());
  await waitFor(() => expect(document.activeElement).toBe(composer()));
}

describe("KalVoice composer target (Stable, TK-2)", () => {
  it("dictates into the focused thread only, shows the target while listening, and never sends", async () => {
    const h = await mountStable();
    await learnThreads(h);
    await openThread(h, PARSER);
    await focusComposer();

    await talk(h, "cover the empty input case", () => {
      const hint = within(detail()).getByText(`KALVOICE TARGET · ${PARSER} · Claude Code · Personal`);
      expect(hint).toHaveAttribute("aria-live", "polite");
    });

    await waitFor(() => expect(composer()).toHaveValue("cover the empty input case"));
    // The hint is gone once the key is released; nothing was sent.
    expect(within(detail()).queryByText(/KALVOICE TARGET/)).toBeNull();
    expect(sent(h)).toHaveLength(0);
    const talked = h.calls.find((c) => c.command === "kalvoice_talk");
    expect(talked?.args?.request).toMatchObject({ target: "field", threadId: threadIdOf(PARSER) });

    // Thread B's composer is untouched.
    await openThread(h, OAUTH);
    expect(composer()).toHaveValue("");
  });

  it("“send that” presses that composer's own Send (prompt review first) and “clear that” empties it", async () => {
    const h = await mountStable();
    await learnThreads(h);
    await openThread(h, PARSER);
    await focusComposer();
    await talk(h, "add a fuzz test for nested lists");
    await waitFor(() => expect(composer()).toHaveValue("add a fuzz test for nested lists"));

    await talk(h, "send that");
    await waitFor(() => expect(sent(h)).toHaveLength(1));
    expect(sent(h)[0]?.args).toMatchObject({ threadId: threadIdOf(PARSER), text: "add a fuzz test for nested lists" });
    const review = h.calls.findIndex((c) => c.command === "thread_review_prompt");
    expect(review).toBeGreaterThan(-1);
    expect(review).toBeLessThan(h.calls.findIndex((c) => c.command === "thread_send"));
    await waitFor(() => expect(composer()).toHaveValue(""));
    expect(within(widget()).getAllByText(`Sent to “${PARSER}”.`).length).toBeGreaterThan(0);

    await focusComposer();
    await talk(h, "and one for escapes");
    await waitFor(() => expect(composer()).toHaveValue("and one for escapes"));
    await talk(h, "clear that");
    await waitFor(() => expect(composer()).toHaveValue(""));
    expect(sent(h)).toHaveLength(1);
  });

  it("“clear that” removes only what KalVoice typed; typed text stays; after a send nothing is cleared", async () => {
    const h = await mountStable();
    await learnThreads(h);
    await openThread(h, PARSER);
    await focusComposer();
    await h.user.type(composer(), "Keep this: ");
    await talk(h, "review the login failure");
    await waitFor(() => expect(composer()).toHaveValue("Keep this: review the login failure"));

    await talk(h, "clear that");
    await waitFor(() => expect(composer()).toHaveValue("Keep this: "));
    await findInWidget("Cleared what KalVoice typed. Nothing was sent.");

    // Edited next to the dictated words: KalVoice can't tell exactly what it typed and refuses.
    await focusComposer();
    await talk(h, "and the logout path");
    await h.user.type(composer(), "!!");
    const edited = composer().value;
    await talk(h, "clear that");
    await findInWidget("I couldn't tell which text I typed — clear it yourself.");
    expect(composer()).toHaveValue(edited);

    // After a send there is nothing KalVoice typed left to clear; new typed text is kept.
    await talk(h, "send that");
    await waitFor(() => expect(sent(h)).toHaveLength(1));
    await waitFor(() => expect(composer()).toHaveValue(""));
    await h.user.type(composer(), "my own words");
    await talk(h, "clear that");
    await findInWidget("Nothing to clear.");
    expect(composer()).toHaveValue("my own words");
    expect(sent(h)).toHaveLength(1);
  }, 15_000);

  it("a warned prompt stops at the warning dialog: voice never confirms it", async () => {
    const h = await mountStable();
    await learnThreads(h);
    await openThread(h, PARSER);
    await focusComposer();
    await talk(h, "the password: hunter2 is in the fixture");
    await waitFor(() => expect(composer()).toHaveValue("the password: hunter2 is in the fixture"));

    await talk(h, "send that");
    expect(await screen.findByRole("alertdialog")).toBeInTheDocument();
    expect(sent(h)).toHaveLength(0);
    expect(within(widget()).getAllByText(/Nothing is sent until you confirm it/).length).toBeGreaterThan(0);
  });

  it("“tell <name> to …” opens that thread, fills its composer and sends through it", async () => {
    const h = await mountStable();
    await learnThreads(h);
    await openThread(h, OAUTH);
    act(() => (document.activeElement as HTMLElement | null)?.blur());

    await talk(h, "tell parser module to Add a test for tabs.");
    await waitFor(() => expect(sent(h)).toHaveLength(1));
    expect(sent(h)[0]?.args).toMatchObject({ threadId: threadIdOf(PARSER), text: "Add a test for tabs." });
    expect(within(detail()).getByRole("heading", { name: PARSER })).toBeInTheDocument();
  });

  it("refuses a thread waiting for a permission decision with the composer's own message", async () => {
    const h = await mountStable();
    await learnThreads(h);
    await openThread(h, PARSER);
    act(() => (document.activeElement as HTMLElement | null)?.blur());

    await talk(h, "tell dark mode toggle to go ahead");
    await findInWidget("Messages can be sent once the permission decision is made.");
    expect(within(detail()).getByRole("heading", { name: DARK_MODE })).toBeInTheDocument();
    expect(composer()).toHaveValue("");
    expect(sent(h)).toHaveLength(0);
  });

  it("asks which one when a name is ambiguous; a click or the spoken name follows up", async () => {
    const h = await mountStable();
    await learnThreads(h);
    await openThread(h, OAUTH);
    act(() => (document.activeElement as HTMLElement | null)?.blur());

    await talk(h, "tell claude to run the linter");
    const choices = within(await choicePanel());
    expect(choices.getByRole("button", { name: `${PARSER} · Claude Code · Personal` })).toBeInTheDocument();
    expect(choices.getByRole("button", { name: `${OAUTH} · Claude Code · Personal` })).toBeInTheDocument();
    expect(sent(h)).toHaveLength(0);

    // Saying the name answers it (no second KalVoice request).
    const talks = h.calls.filter((c) => c.command === "kalvoice_talk").length;
    await talk(h, "the parser one");
    await waitFor(() => expect(sent(h)).toHaveLength(1));
    expect(sent(h)[0]?.args).toMatchObject({ threadId: threadIdOf(PARSER), text: "run the linter" });
    expect(h.calls.filter((c) => c.command === "kalvoice_talk")).toHaveLength(talks);
    expect(screen.queryByRole("list", { name: "Sessions" })).toBeNull();

    // A click works the same way. (The follow-up focused Parser's box; with a box focused the
    // same words would be dictated, so leave it first.)
    act(() => (document.activeElement as HTMLElement | null)?.blur());
    await talk(h, "tell claude to update the changelog");
    const again = within(await choicePanel());
    await h.user.click(again.getByRole("button", { name: `${OAUTH} · Claude Code · Personal` }));
    await waitFor(() => expect(sent(h)).toHaveLength(2));
    expect(sent(h)[1]?.args).toMatchObject({ threadId: threadIdOf(OAUTH), text: "update the changelog" });
  });

  it("a long utterance during “Which one?” is a new request and drops the question", async () => {
    const h = await mountStable();
    await learnThreads(h);
    await openThread(h, OAUTH);
    act(() => (document.activeElement as HTMLElement | null)?.blur());
    await talk(h, "tell claude to run the linter");
    await choicePanel();

    const talks = h.calls.filter((c) => c.command === "kalvoice_talk").length;
    await talk(h, "tell parser module to add a test for tabs");
    // Went to native as a normal command, not as an answer; the pending question is gone.
    expect(h.calls.filter((c) => c.command === "kalvoice_talk")).toHaveLength(talks + 1);
    await waitFor(() => expect(sent(h)).toHaveLength(1));
    expect(sent(h)[0]?.args).toMatchObject({ threadId: threadIdOf(PARSER), text: "add a test for tabs" });
    expect(screen.queryByRole("list", { name: "Sessions" })).toBeNull();
  });

  it("“number two” answers “Which one?” by position", async () => {
    const h = await mountStable();
    await learnThreads(h);
    await openThread(h, OAUTH);
    act(() => (document.activeElement as HTMLElement | null)?.blur());
    await talk(h, "tell claude to run the linter");
    const second = within(await choicePanel()).getAllByRole("button")[1]?.textContent ?? "";
    await talk(h, "number two");
    await waitFor(() => expect(sent(h)).toHaveLength(1));
    const name = second.split(" · ")[0] ?? "";
    expect(sent(h)[0]?.args).toMatchObject({ threadId: threadIdOf(name), text: "run the linter" });
  });

  it("“Type it instead” lands in the thread that was focused, never the one on screen now", async () => {
    const h = await mountStable();
    await learnThreads(h);
    await openThread(h, PARSER);
    await focusComposer();
    // A High-confidence command wins over dictation and navigates away.
    await talk(h, "open dashboard");
    await screen.findByRole("heading", { level: 1, name: "Dashboard" });

    // Meanwhile the person opens another thread; its composer has the same DOM id.
    await openThread(h, OAUTH);
    await h.user.click(within(widget()).getByRole("button", { name: "Type it instead" }));

    await waitFor(() => expect(within(detail()).getByRole("heading", { name: PARSER })).toBeInTheDocument());
    await waitFor(() => expect(composer()).toHaveValue("open dashboard"));
    await openThread(h, OAUTH);
    expect(composer()).toHaveValue("");
  });

  it("leaving Threads (a workspace switch) empties the target registry; a later send is refused", async () => {
    const h = await mountStable();
    await learnThreads(h);
    await openThread(h, PARSER);
    expect(composerForThread(threadIdOf(PARSER))).not.toBeNull();

    h.transport.workspaces.queueFolders("elsewhere");
    await act(async () => {
      await h.client.openWorkspaceDialog();
    });
    await h.user.click(
      within(screen.getByRole("navigation", { name: "Primary" })).getByRole("button", { name: "Code" }),
    );
    await waitFor(() => expect(composerForThread(threadIdOf(PARSER))).toBeNull());

    h.injectDirective({ kind: "submit_composer", threadId: threadIdOf(PARSER) });
    await talk(h, "send that");
    await findInWidget("That thread's message box isn't open. Nothing was sent.");
    expect(sent(h)).toHaveLength(0);
  });

  it("“go back” focuses the thread used before this one", async () => {
    const h = await mountStable();
    await learnThreads(h);
    await openThread(h, PARSER);
    await openThread(h, OAUTH);
    act(() => (document.activeElement as HTMLElement | null)?.blur());
    await talk(h, "go back");
    await waitFor(() => expect(within(detail()).getByRole("heading", { name: PARSER })).toBeInTheDocument());
  });

  it("open_new_thread opens New thread prefilled and starts nothing (S3)", async () => {
    const h = await mountStable();
    await learnThreads(h);
    const threadsBefore = h.calls.filter((c) => c.command === "thread_create").length;
    h.injectDirective({
      kind: "open_new_thread",
      providerId: "codex",
      providerAccountId: null,
      workspaceId: null,
    });
    await talk(h, "open a new codex thread with my work account");
    const form = within(await screen.findByRole("region", { name: "New thread" }));
    await waitFor(() => expect(form.getByRole("combobox", { name: "Provider" })).toHaveValue("codex"));
    expect(h.calls.filter((c) => c.command === "thread_create")).toHaveLength(threadsBefore);
  });

  it("a raw-terminal target never gets a composer submit or clear", async () => {
    const h = await mountStable();
    await learnThreads(h);
    await openThread(h, PARSER);
    await focusComposer();
    await talk(h, "keep this draft");
    await waitFor(() => expect(composer()).toHaveValue("keep this draft"));

    // A registered terminal sink has focus; a stray submit for the shown thread is refused.
    const { registerDictationSink } = await import("./dictation.ts");
    const host = document.createElement("div");
    const input = document.createElement("textarea");
    host.append(input);
    document.body.append(host);
    const deliver = vi.fn(async () => undefined);
    const unregister = registerDictationSink(host, {
      label: "Terminal",
      destination: { kind: "raw_terminal", terminalId: "terminal-1" },
      deliver,
    });
    try {
      act(() => input.focus());
      h.injectDirective({ kind: "submit_composer", threadId: threadIdOf(PARSER) });
      await talk(h, "send that");
      await findInWidget("KalVoice never presses Enter in a terminal. Press Enter yourself to run it.");
      h.injectDirective({ kind: "clear_composer", threadId: threadIdOf(PARSER) });
      await talk(h, "clear that");
      await findInWidget("KalVoice doesn't edit a terminal's line. Nothing was changed.");
      expect(sent(h)).toHaveLength(0);
      expect(composer()).toHaveValue("keep this draft");
      expect(deliver).not.toHaveBeenCalled();
    } finally {
      unregister();
      host.remove();
    }
  });
});
