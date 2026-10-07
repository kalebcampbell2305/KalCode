import type { SurfaceFlag } from "@kalcode/protocol";
import { ToastProvider, TooltipProvider } from "@kalcode/ui/components";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccountProvider } from "../../account/AccountProvider.tsx";
import { AccountClient } from "../../ipc/account.ts";
import { KalCodeClient } from "../../ipc/client.ts";
import { createMemoryTransport } from "../../ipc/memoryTransport.ts";
import type { CommandName, Transport } from "../../ipc/transport.ts";
import { DRAFT_STORAGE_KEY } from "../../runtime/drafts.ts";
import { RuntimeProvider } from "../../runtime/RuntimeProvider.tsx";
import nativeStableSurfaces from "../../shell/fixtures/stable-native-surfaces.json";
import { Shell } from "../../shell/Shell.tsx";
import { goTo } from "../../test/nav.ts";

vi.mock("@xterm/xterm", () => ({ Terminal: class {} }));

function clearDraftStorage() {
  for (let index = localStorage.length - 1; index >= 0; index -= 1) {
    const key = localStorage.key(index);
    if (key?.startsWith(DRAFT_STORAGE_KEY)) localStorage.removeItem(key);
  }
}

beforeEach(() => {
  clearDraftStorage();
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
  clearDraftStorage();
  vi.unstubAllGlobals();
});

type RecordedCall = { command: CommandName; args: Record<string, unknown> | undefined };

async function harness(scenario: "threads" | "account-ready") {
  const transport = createMemoryTransport(scenario, { detectDelayMs: 0 });
  const calls: RecordedCall[] = [];
  const raw = transport.invoke.bind(transport);
  let intercept: ((command: CommandName, args: Record<string, unknown> | undefined) => Promise<unknown> | null) | null =
    null;
  transport.invoke = (<T,>(command: CommandName, args?: Record<string, unknown>): Promise<T> => {
    calls.push({ command, args });
    const replacement = intercept?.(command, args);
    return (replacement ?? raw<T>(command, args)) as Promise<T>;
  }) as Transport["invoke"];

  const client = new KalCodeClient(transport);
  const boot = await client.boot();
  boot.info.channel = "stable";
  boot.info.flags.surfaces = (nativeStableSurfaces as SurfaceFlag[]).map((flag) => ({ ...flag }));
  boot.info.flags.features = boot.info.flags.features.map((flag) => ({
    ...flag,
    visible: flag.state === "available",
  }));
  const settings = await client.getSettings();

  const mount = () =>
    render(
      <ToastProvider>
        <TooltipProvider>
          <AccountProvider client={new AccountClient(transport)}>
            <RuntimeProvider client={client} info={boot.info} initialSettings={settings}>
              <Shell />
            </RuntimeProvider>
          </AccountProvider>
        </TooltipProvider>
      </ToastProvider>,
    );

  return {
    calls,
    client,
    mount,
    raw,
    setIntercept(next: typeof intercept) {
      intercept = next;
    },
    transport,
  };
}

async function openThreads(user: ReturnType<typeof userEvent.setup>) {
  await goTo(user, "Threads");
  return screen.findByRole("list", { name: "Threads" });
}

async function openParserThread(user: ReturnType<typeof userEvent.setup>) {
  const list = await openThreads(user);
  await user.click(
    await within(list).findByRole("button", {
      name: /^(?!(?:Pin|Unpin) globally: |(?:Add|Remove) Favorite: ).*Write Unit Tests for Parser Module/,
    }),
  );
  return screen.findByRole("textbox", { name: "Message" });
}

async function openNewThread(user: ReturnType<typeof userEvent.setup>) {
  await goTo(user, "Threads");
  await screen.findByRole("heading", { level: 1, name: "Threads" });
  await user.click(screen.getAllByRole("button", { name: "New thread" })[0] as HTMLElement);
  const region = await screen.findByRole("region", { name: "New thread" });
  return within(region).findByRole("textbox", { name: "Task" });
}

describe("restart-safe thread drafts", () => {
  it("restores an unsent thread message after remount without sending it, then removes it after a successful send", async () => {
    const h = await harness("threads");
    let view = h.mount();
    let user = userEvent.setup();
    let composer = await openParserThread(user);
    await user.type(composer, "Keep this after restart");
    expect(h.calls.some((call) => call.command === "thread_send")).toBe(false);

    view.unmount();
    view = h.mount();
    user = userEvent.setup();
    composer = await openParserThread(user);
    expect(composer).toHaveValue("Keep this after restart");
    expect(h.calls.some((call) => call.command === "thread_send")).toBe(false);

    h.setIntercept((command) =>
      command === "thread_send"
        ? Promise.reject({ code: "provider_unavailable", message: "Provider unavailable", retryable: true })
        : null,
    );
    await user.click(screen.getByRole("button", { name: "Send" }));
    await screen.findByText("Message not sent");
    expect(composer).toHaveValue("Keep this after restart");

    view.unmount();
    view = h.mount();
    user = userEvent.setup();
    composer = await openParserThread(user);
    expect(composer).toHaveValue("Keep this after restart");

    const failedSends = h.calls.filter((call) => call.command === "thread_send").length;
    h.setIntercept(null);
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(h.calls.filter((call) => call.command === "thread_send")).toHaveLength(failedSends + 1));
    await waitFor(() => expect(composer).toHaveValue(""));

    view.unmount();
    h.mount();
    user = userEvent.setup();
    composer = await openParserThread(user);
    expect(composer).toHaveValue("");
    fireEvent.change(composer, { target: { value: "x".repeat(65_537) } });
    expect(
      await screen.findByText("Draft not saved for restart because it is over 65,536 characters. Shorten it to retry."),
    ).toBeVisible();
    fireEvent.change(composer, { target: { value: "small again" } });
    expect(screen.queryByText(/Draft not saved for restart because/)).not.toBeInTheDocument();
  });

  it("keeps edits made while a thread message is sending", async () => {
    const h = await harness("threads");
    const view = h.mount();
    let user = userEvent.setup();
    const composer = await openParserThread(user);
    let finish!: () => void;
    h.setIntercept((command, args) =>
      command === "thread_send"
        ? new Promise((resolve, reject) => {
            finish = () => void h.raw(command, args).then(resolve, reject);
          })
        : null,
    );

    await user.type(composer, "First version");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(finish).toBeTypeOf("function"));
    await user.type(composer, " plus a newer edit");
    await act(async () => finish());

    expect(composer).toHaveValue("First version plus a newer edit");
    view.unmount();
    h.mount();
    user = userEvent.setup();
    expect(await openParserThread(user)).toHaveValue("First version plus a newer edit");
  });
});

describe("restart-safe new-thread drafts", () => {
  it("restores task text after remount and clears only a successfully started task", async () => {
    const h = await harness("account-ready");
    h.transport.workspaces.queueFolders("draft-workspace");
    await h.client.openWorkspaceDialog();
    let view = h.mount();
    let user = userEvent.setup();
    let task = await openNewThread(user);
    await user.type(task, "Build the restart flow");

    view.unmount();
    view = h.mount();
    user = userEvent.setup();
    task = await openNewThread(user);
    expect(task).toHaveValue("Build the restart flow");

    h.setIntercept((command) =>
      command === "thread_create"
        ? Promise.reject({
            category: "provider",
            code: "provider_unavailable",
            message: "Provider unavailable",
            retryable: true,
          })
        : null,
    );
    await user.click(screen.getByRole("button", { name: "Start thread" }));
    await screen.findByText("Provider unavailable");
    expect(task).toHaveValue("Build the restart flow");

    view.unmount();
    view = h.mount();
    user = userEvent.setup();
    task = await openNewThread(user);
    expect(task).toHaveValue("Build the restart flow");

    const failedCreates = h.calls.filter((call) => call.command === "thread_create").length;
    h.setIntercept(null);
    await user.click(screen.getByRole("button", { name: "Start thread" }));
    await waitFor(() =>
      expect(h.calls.filter((call) => call.command === "thread_create")).toHaveLength(failedCreates + 1),
    );
    await screen.findByRole("region", { name: "Thread" });

    view.unmount();
    h.mount();
    user = userEvent.setup();
    task = await openNewThread(user);
    expect(task).toHaveValue("");
    fireEvent.change(task, { target: { value: "x".repeat(65_537) } });
    expect(
      await screen.findByText("Draft not saved for restart because it is over 65,536 characters. Shorten it to retry."),
    ).toBeVisible();
    fireEvent.change(task, { target: { value: "small again" } });
    expect(screen.queryByText(/Draft not saved for restart because/)).not.toBeInTheDocument();
  });

  it("retains a newer task edit made while thread creation is pending", async () => {
    const h = await harness("account-ready");
    h.transport.workspaces.queueFolders("draft-workspace");
    await h.client.openWorkspaceDialog();
    const view = h.mount();
    let user = userEvent.setup();
    const task = await openNewThread(user);
    let finish!: () => void;
    h.setIntercept((command, args) =>
      command === "thread_create"
        ? new Promise((resolve, reject) => {
            finish = () => void h.raw(command, args).then(resolve, reject);
          })
        : null,
    );

    await user.type(task, "Original task");
    await user.click(screen.getByRole("button", { name: "Start thread" }));
    await waitFor(() => expect(finish).toBeTypeOf("function"));
    await user.type(task, " with a newer edit");
    await act(async () => finish());
    expect(task).toHaveValue("Original task with a newer edit");

    view.unmount();
    h.mount();
    user = userEvent.setup();
    expect(await openNewThread(user)).toHaveValue("Original task with a newer edit");
  });
});
