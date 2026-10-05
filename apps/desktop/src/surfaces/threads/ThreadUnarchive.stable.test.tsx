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

// Unarchive from the Stable Threads surface: an archived thread shown with "Show archived" can be
// restored, and it becomes an ordinary open thread again. Stable flags as in Shell.stable.test.tsx.
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

it("restores an archived thread from the Threads surface", async () => {
  const transport = createMemoryTransport("threads", { detectDelayMs: 0 });
  const client = new KalCodeClient(transport);
  const boot = await client.boot();
  boot.info.channel = "stable";
  boot.info.flags.surfaces = (nativeStableSurfaces as SurfaceFlag[]).map((flag) => ({ ...flag }));
  boot.info.flags.features = boot.info.flags.features.map((flag) => ({
    ...flag,
    visible: flag.state === "available",
  }));
  const finished = (await client.listThreads()).find(
    (thread) => thread.status === "completed" || thread.status === "failed" || thread.status === "interrupted",
  );
  if (!finished) throw new Error("the threads fixture has a finished thread");
  await client.archiveThread(finished.id);
  const unarchive = vi.spyOn(client, "unarchiveThread");

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
  await screen.findByRole("heading", { level: 1, name: "Threads" });
  const list = await screen.findByRole("list", { name: "Threads" });
  expect(within(list).queryByText(finished.name)).toBeNull();

  await user.click(screen.getByRole("checkbox", { name: "Show archived" }));
  await user.click(await within(list).findByText(finished.name));
  const detail = screen.getByRole("region", { name: "Thread" });
  await within(detail).findByText("Archived");
  expect(within(detail).queryByRole("button", { name: "Archive" })).toBeNull();

  await user.click(within(detail).getByRole("button", { name: "Unarchive" }));
  expect(unarchive).toHaveBeenCalledWith(finished.id);
  expect(await screen.findByText("Thread restored")).toBeInTheDocument();
  // Open again: no Archived badge, Archive is offered, and it lists without "Show archived".
  await waitFor(() => expect(within(detail).queryByText("Archived")).toBeNull());
  expect(within(detail).getByRole("button", { name: "Archive" })).toBeInTheDocument();
  expect((await client.listThreads()).map((thread) => thread.id)).toContain(finished.id);
});
