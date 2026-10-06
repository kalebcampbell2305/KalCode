import type { SurfaceFlag } from "@kalcode/protocol";
import { ToastProvider, TooltipProvider } from "@kalcode/ui/components";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AccountProvider } from "../../account/AccountProvider.tsx";
import { AccountClient } from "../../ipc/account.ts";
import { KalCodeClient } from "../../ipc/client.ts";
import { createMemoryTransport } from "../../ipc/memoryTransport.ts";
import { RuntimeProvider } from "../../runtime/RuntimeProvider.tsx";
import nativeStableSurfaces from "../../shell/fixtures/stable-native-surfaces.json";
import { Shell } from "../../shell/Shell.tsx";
import { goTo } from "../../test/nav.ts";

// The open thread on the Stable Threads surface: it stays archived after it leaves the list, and
// opening it clears its unread count (reading marks it read natively without a thread event).
vi.mock("@xterm/xterm", () => ({ Terminal: class {} }));

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
afterEach(() => vi.unstubAllGlobals());

async function mountStable() {
  const transport = createMemoryTransport("threads", { detectDelayMs: 0 });
  const client = new KalCodeClient(transport);
  const boot = await client.boot();
  boot.info.channel = "stable";
  boot.info.flags.surfaces = (nativeStableSurfaces as SurfaceFlag[]).map((flag) => ({ ...flag }));
  boot.info.flags.features = boot.info.flags.features.map((flag) => ({
    ...flag,
    visible: flag.state === "available",
  }));
  const threads = await client.listThreads();
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
  await screen.findByRole("navigation", { name: "Primary" });
  await goTo(user, "Threads");
  const list = await screen.findByRole("list", { name: "Threads" });
  return { user, threads, list };
}

it("keeps an archived thread read-only after it leaves the list", async () => {
  const { user, threads, list } = await mountStable();
  const finished = threads.find(
    (thread) => thread.status === "completed" || thread.status === "failed" || thread.status === "interrupted",
  );
  if (!finished) throw new Error("the threads fixture has a finished thread");
  await user.click(await within(list).findByText(finished.name));
  const detail = screen.getByRole("region", { name: "Thread" });
  await user.click(await within(detail).findByRole("button", { name: "Archive" }));
  await screen.findByText("Thread archived");
  // "Show archived" is off, so the thread drops out of the list but stays open and archived.
  await waitFor(() => expect(within(list).queryByText(finished.name)).toBeNull());
  const archived = () => {
    expect(within(detail).getByText("Archived")).toBeInTheDocument();
    expect(within(detail).getByRole("button", { name: "Unarchive" })).toBeInTheDocument();
    expect(within(detail).queryByRole("button", { name: "Archive" })).toBeNull();
    expect(within(detail).getByText("Archived threads are read-only.")).toBeInTheDocument();
  };
  archived();

  // Showing and then hiding archived threads again doesn't forget it either.
  const showArchived = screen.getByRole("checkbox", { name: "Show archived" });
  await user.click(showArchived);
  await within(list).findByText(finished.name);
  await user.click(showArchived);
  await waitFor(() => expect(within(list).queryByText(finished.name)).toBeNull());
  archived();
});

it("clears a thread's unread count once it's opened", async () => {
  const { user, threads, list } = await mountStable();
  const unread = threads.find((thread) => thread.unreadMessages > 0);
  if (!unread) throw new Error("the threads fixture has an unread thread");
  const row = (await within(list).findByText(unread.name)).closest("button");
  if (!row) throw new Error("the thread has a row");
  await user.click(row);
  await waitFor(() => expect(row).not.toHaveTextContent(/unread message/));
});
