import type { SurfaceFlag, ThreadSummary } from "@kalcode/protocol";
import { ToastProvider, TooltipProvider } from "@kalcode/ui/components";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccountProvider } from "../../account/AccountProvider.tsx";
import { AccountClient } from "../../ipc/account.ts";
import { KalCodeClient } from "../../ipc/client.ts";
import { createMemoryTransport } from "../../ipc/memoryTransport.ts";
import { RuntimeProvider } from "../../runtime/RuntimeProvider.tsx";
import nativeStableSurfaces from "../../shell/fixtures/stable-native-surfaces.json";
import { Shell } from "../../shell/Shell.tsx";
import { resetAccountIntentForTests } from "./accountIntent.ts";

/** A thread row by name, never its "Pin globally: <name>" favorite action (#235). */
const threadRow = (name: string) => new RegExp(`^(?!(?:Pin|Unpin) globally: |(?:Add|Remove) Favorite: ).*${name}`);

// How the Threads surface shows a launch held for system resources, a wait that ran out, and an
// idle thread whose last turn failed (Stable). The runtime states are the native ones
// (crates/threads/src/runtime.rs); the memory transport's summaries are patched to them.
vi.mock("@xterm/xterm", () => ({ Terminal: class {} }));

const CODEX_PERSONAL = "0192f3c4-0000-7000-8000-000000000201";
const GEMINI_PERSONAL = "0192f3c4-0000-7000-8000-000000000301";

beforeEach(() => {
  resetAccountIntentForTests();
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
  resetAccountIntentForTests();
});

type Patch = Partial<Pick<ThreadSummary, "status" | "currentActivity" | "error">>;

// The runtime's own copy (crates/threads/src/runtime.rs): only genuine hard pressure or the
// person's own Custom limit holds a coding agent, never CPU load.
const WAITING: Patch = {
  status: "waiting_for_dependency",
  currentActivity: "Waiting to start: memory is critically low (412 MB free)",
  error: {
    code: "waiting_for_resources",
    message:
      "Memory is critically low (412 MB free). KalCode is holding Codex so your system stays usable; it starts as soon as this clears. Run KalTidy to free resources, or choose Start Anyway.",
  },
};

const NOT_STARTED: Patch = {
  status: "interrupted",
  currentActivity: "Not started: system resources were too low",
  error: {
    code: "resources_unavailable",
    message:
      "Codex didn't start: 4 of 4 agents are already working (your Custom limit) after 90 s. Your message is saved; Resume sends it. Stop an agent you're not using, then resume this one, or choose Start Anyway.",
  },
};

const LAST_TURN_FAILED: Patch = {
  status: "idle",
  currentActivity: "Last turn failed",
  error: { code: "process_exited", message: "Gemini CLI stopped unexpectedly (exit code 1)." },
};

async function mountStable() {
  const transport = createMemoryTransport("threads", { detectDelayMs: 0 });
  const original = transport.invoke.bind(transport);
  const patches = new Map<string, Patch>();
  const patch = (thread: ThreadSummary): ThreadSummary => ({ ...thread, ...patches.get(thread.id) });
  vi.spyOn(transport, "invoke").mockImplementation(async (command, args) => {
    const result = await original(command, args);
    if (command === "thread_list") return (result as ThreadSummary[]).map(patch) as never;
    if (command === "thread_get") return patch(result as ThreadSummary) as never;
    return result as never;
  });
  const client = new KalCodeClient(transport);
  const boot = await client.boot();
  boot.info.channel = "stable";
  boot.info.flags.surfaces = (nativeStableSurfaces as SurfaceFlag[]).map((flag) => ({ ...flag }));
  boot.info.flags.features = boot.info.flags.features.map((flag) => ({
    ...flag,
    visible: flag.state === "available",
  }));
  await client.detectProviders();
  const workspace = (await client.threadOptions()).workspaces[0];
  if (!workspace) throw new Error("fixture has no workspace");
  const settled = async (providerId: string, providerAccountId: string, name: string, state: Patch) => {
    const created = await client.createThread({
      providerId,
      providerAccountId,
      workspaceId: workspace.id,
      model: null,
      permissionMode: "approve",
      prompt: `Work on ${name}`,
      name,
    });
    await client.stopThread(created.id);
    patches.set(created.id, state);
  };
  await settled("codex", CODEX_PERSONAL, "Codex held", WAITING);
  await settled("codex", CODEX_PERSONAL, "Codex not started", NOT_STARTED);
  await settled("gemini-cli", GEMINI_PERSONAL, "Gemini refused", LAST_TURN_FAILED);
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
  const user = userEvent.setup();
  const primary = within(screen.getByRole("navigation", { name: "Primary" }));
  await user.click(primary.getByRole("button", { name: "Threads" }));
  await screen.findByRole("heading", { name: "Threads", level: 1 });
  return user;
}

async function openThread(user: ReturnType<typeof userEvent.setup>, name: string) {
  const list = await screen.findByRole("list", { name: "Threads" });
  await user.click(await within(list).findByRole("button", { name: threadRow(name) }));
  await screen.findByRole("heading", { name, level: 2 });
  return screen.getByRole("article");
}

describe("thread problems on Stable", () => {
  it("a held launch shows the real reason, never CPU busy or a provider failure, and offers Start Anyway", async () => {
    const user = await mountStable();
    const list = await screen.findByRole("list", { name: "Threads" });
    expect(within(list).getByRole("button", { name: threadRow("Codex held") })).toHaveTextContent("Waiting to start");
    const detail = await openThread(user, "Codex held");
    const notice = within(detail).getByRole("status", { name: "" });
    expect(notice).toHaveTextContent("Waiting to start: memory is critically low (412 MB free)");
    expect(notice).toHaveTextContent("Run KalTidy to free resources, or choose Start Anyway.");
    expect(notice).toHaveTextContent("Code: waiting_for_resources");
    expect(notice).not.toHaveTextContent(/CPU|every few seconds/);
    expect(within(detail).queryByRole("alert")).toBeNull();
    expect(within(detail).queryByText(/couldn't start|Check that it works in a terminal/)).toBeNull();
    expect(within(detail).getByRole("button", { name: "Start Anyway" })).toBeInTheDocument();
    expect(within(detail).getByRole("button", { name: "Stop" })).toBeInTheDocument();
    expect(within(detail).queryByRole("button", { name: "Resume" })).toBeNull();
    expect(within(detail).queryByRole("button", { name: "Interrupt" })).toBeNull();
    expect(within(detail).getByLabelText("Message")).toBeDisabled();
    expect(within(detail).getByText(/Messages can be sent once this thread starts/)).toBeInTheDocument();
  });

  it("a wait that ran out reads Not started with a Resume path, not a failure", async () => {
    const user = await mountStable();
    const detail = await openThread(user, "Codex not started");
    expect(within(detail).getByText("Not started", { exact: true })).toBeInTheDocument();
    const notice = within(detail).getByRole("status", { name: "" });
    expect(notice).toHaveTextContent("Not started: system resources were too low");
    expect(notice).toHaveTextContent("Stop an agent you're not using");
    expect(within(detail).getByRole("button", { name: "Start Anyway" })).toBeInTheDocument();
    expect(within(detail).queryByRole("alert")).toBeNull();
    expect(within(detail).getByRole("button", { name: "Resume" })).toBeInTheDocument();
    expect(within(detail).queryByRole("button", { name: "Stop" })).toBeNull();
  });

  it("an idle thread whose last turn failed says so, and offers Archive instead of Stop", async () => {
    const user = await mountStable();
    const detail = await openThread(user, "Gemini refused");
    expect(within(detail).getByText("Last turn failed", { exact: true })).toBeInTheDocument();
    expect(within(detail).queryByText("Ready", { exact: true })).toBeNull();
    const alert = within(detail).getByRole("alert");
    expect(alert).toHaveTextContent("The last turn failed");
    expect(alert).toHaveTextContent("Gemini CLI stopped unexpectedly (exit code 1).");
    expect(within(detail).queryByRole("button", { name: "Stop" })).toBeNull();
    expect(within(detail).getByRole("button", { name: "Archive" })).toBeInTheDocument();
  });
});
