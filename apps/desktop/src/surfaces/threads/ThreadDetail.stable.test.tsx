import type { SurfaceFlag } from "@kalcode/protocol";
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

// Thread detail on the Stable channel (B8 visual audit D2): the waiting notice never points at
// approval controls that aren't on screen.
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
  // The "threads" fixture has a Codex thread waiting for a decision whose request isn't loaded.
  const transport = createMemoryTransport("threads", { detectDelayMs: 0 });
  const client = new KalCodeClient(transport);
  const boot = await client.boot();
  boot.info.channel = "stable";
  boot.info.flags.surfaces = (nativeStableSurfaces as SurfaceFlag[]).map((flag) => ({ ...flag }));
  boot.info.flags.features = boot.info.flags.features.map((flag) => ({
    ...flag,
    visible: flag.state === "available",
  }));
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
  return userEvent.setup();
}

describe("Waiting thread (Stable)", () => {
  it("says the request isn't shown here and opens Approvals instead of 'Answer below'", async () => {
    const user = await mountStable();
    const primary = within(screen.getByRole("navigation", { name: "Primary" }));
    await user.click(primary.getByRole("button", { name: "Threads" }));
    const threads = await screen.findByRole("list", { name: "Threads" });
    await user.click(await within(threads).findByRole("button", { name: /Add Dark Mode Toggle/ }));

    expect(await screen.findByText("Waiting for 1 permission decision")).toBeInTheDocument();
    expect(screen.getByText("Requested: Run npm install lodash")).toBeInTheDocument();
    expect(screen.queryByText(/Answer below/)).not.toBeInTheDocument();
    expect(
      await screen.findByText(
        "The request isn't showing here yet. Check Approvals, or interrupt the turn to deny it and keep the thread.",
      ),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Open Approvals" }));
    expect(await screen.findByRole("dialog", { name: "Approvals" })).toBeInTheDocument();
  });
});
