import type { SurfaceFlag } from "@kalcode/protocol";
import { ToastProvider, TooltipProvider } from "@kalcode/ui/components";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccountProvider } from "../../account/AccountProvider.tsx";
import { AccountClient } from "../../ipc/account.ts";
import { KalCodeClient } from "../../ipc/client.ts";
import { createMemoryTransport } from "../../ipc/memoryTransport.ts";
import { RuntimeProvider } from "../../runtime/RuntimeProvider.tsx";
import nativeStableSurfaces from "../../shell/fixtures/stable-native-surfaces.json";
import { Shell } from "../../shell/Shell.tsx";

// Settings on the Stable channel (B8 visual audit D1, D6, D23): only what a Stable build actually
// does. Flags are applied exactly as Shell.stable.test.tsx applies them.
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

async function mount(channel: "stable" | "development", prepare?: (client: KalCodeClient) => Promise<void>) {
  const transport = createMemoryTransport("account-ready", { detectDelayMs: 0 });
  const client = new KalCodeClient(transport);
  const boot = await client.boot();
  if (channel === "stable") {
    boot.info.channel = "stable";
    boot.info.flags.surfaces = (nativeStableSurfaces as SurfaceFlag[]).map((flag) => ({ ...flag }));
    boot.info.flags.features = boot.info.flags.features.map((flag) => ({
      ...flag,
      visible: flag.state === "available",
    }));
  }
  await prepare?.(client);
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
  await user.click(primary.getByRole("button", { name: "Settings" }));
  await screen.findByRole("heading", { level: 1, name: "Settings" });
  return { user, primary };
}

const permissions = () => within(screen.getByRole("region", { name: "Permissions" }));
const defaultModes = () =>
  within(permissions().getByRole("radiogroup", { name: "Default mode for new coding agents" }));

describe("Settings on Stable", () => {
  it("offers only startable modes and recommends Auto by default", async () => {
    await mount("stable");
    await waitFor(() => expect(defaultModes().getByRole("radio", { name: "Auto" })).toBeChecked());
    expect(
      defaultModes()
        .getAllByRole("radio")
        .map((radio) => radio.textContent),
    ).toEqual(["Plan", "Approve", "Auto"]);
  });

  it("says a saved Bypass default starts coding agents in Approve, with no sidebar alarm", async () => {
    const { user, primary } = await mount("stable", async (client) => {
      await client.updatePermissionSettings("bypass", { confirmBypass: true });
    });
    const note = await permissions().findByRole("status");
    expect(note).toHaveTextContent("Bypass is your saved default");
    expect(note).toHaveTextContent("New coding agents start in Approve");
    expect(note).toHaveTextContent("Bypass cannot be selected at launch");
    expect(primary.queryByRole("button", { name: /Bypass/ })).not.toBeInTheDocument();

    await user.click(within(note).getByRole("button", { name: "Use Approve" }));
    await waitFor(() => expect(defaultModes().getByRole("radio", { name: "Approve" })).toBeChecked());
    expect(permissions().queryByText("Bypass is your saved default")).not.toBeInTheDocument();
  });

  it("hides the display name, which only Home shows, when Home isn't in the build", async () => {
    await mount("stable");
    expect(screen.queryByRole("region", { name: "Profile" })).not.toBeInTheDocument();
    expect(screen.queryByText(/Home greets you/)).not.toBeInTheDocument();
  });

  it("never offers the Dev update channel", async () => {
    await mount("stable");
    const updates = within(await screen.findByRole("region", { name: "Updates" }));
    const channels = within(await updates.findByRole("radiogroup", { name: "Update channel" }));
    expect(channels.getAllByRole("radio").map((radio) => radio.textContent)).toEqual(["Stable", "Beta"]);
    expect(updates.getByText("Stable is recommended. Beta may contain unfinished changes.")).toBeInTheDocument();
  });
});

describe("Settings on a Development build", () => {
  it("keeps the engineering choices and the Profile that Home uses", async () => {
    await mount("development");
    await waitFor(() => expect(defaultModes().getAllByRole("radio")).toHaveLength(5));
    expect(screen.getByRole("region", { name: "Profile" })).toBeInTheDocument();
    const updates = within(await screen.findByRole("region", { name: "Updates" }));
    const channels = within(await updates.findByRole("radiogroup", { name: "Update channel" }));
    expect(channels.getByRole("radio", { name: "Dev" })).toBeInTheDocument();
  });
});
