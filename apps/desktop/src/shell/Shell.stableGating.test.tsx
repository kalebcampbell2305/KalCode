import type { SurfaceFlag } from "@kalcode/protocol";
import { ToastProvider, TooltipProvider } from "@kalcode/ui/components";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccountProvider } from "../account/AccountProvider.tsx";
import { AccountClient } from "../ipc/account.ts";
import { KalCodeClient } from "../ipc/client.ts";
import { createMemoryTransport } from "../ipc/memoryTransport.ts";
import { RuntimeProvider } from "../runtime/RuntimeProvider.tsx";
import nativeStableSurfaces from "./fixtures/stable-native-surfaces.json";
import { Shell } from "./Shell.tsx";

// Gated features must not be reachable from the Stable UI (B5), while Development builds (which
// show gated features) keep offering them. Stable flags follow Shell.stable.test.tsx.
// The Code canvas is exercised for its menus only; terminals render as placeholders.
vi.mock("../surfaces/code/TerminalView.tsx", () => ({ TerminalView: () => null }));

const originalScroll = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollIntoView");
beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: () => {} });
});
afterEach(() => {
  vi.unstubAllGlobals();
  if (originalScroll) Object.defineProperty(HTMLElement.prototype, "scrollIntoView", originalScroll);
  else Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
});

type Channel = "stable" | "development";

async function mount(channel: Channel) {
  const transport = createMemoryTransport("code", { detectDelayMs: 0 });
  const invoke = vi.spyOn(transport, "invoke");
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
  return { user: userEvent.setup(), invoke };
}

function primary() {
  return within(screen.getByRole("navigation", { name: "Primary" }));
}

async function openPalette(user: ReturnType<typeof userEvent.setup>) {
  await user.keyboard("{Control>}k{/Control}");
  return within(await screen.findByRole("dialog", { name: "Command palette" }));
}

describe.each(["stable", "development"] as const)("%s build", (channel) => {
  const stable = channel === "stable";

  it("offers KalVoice examples and command copy that this build can run (E8)", async () => {
    const { user } = await mount(channel);
    await user.click(primary().getByRole("button", { name: "KalVoice" }));
    const examples = within(await screen.findByRole("list", { name: "Examples" }));
    const commandsCopy = await screen.findByText(/KalCode acts the moment you let go/);
    expect(examples.getByRole("button", { name: "Open four Codex threads" })).toBeInTheDocument();
    expect(commandsCopy.textContent).toMatch(/Open four Codex terminals/);
  });

  it("offers Git status in a pane only when Git is in the build (E6)", async () => {
    const { user } = await mount(channel);
    await user.click(primary().getByRole("button", { name: "Code" }));
    const palette = await openPalette(user);
    await palette.findByRole("option", { name: /Split pane right/ });
    const git = palette.queryByRole("option", { name: /Show Git status in a pane/ });
    if (stable) expect(git).toBeNull();
    else expect(git).toBeInTheDocument();
  });

  it("searches the Session Locator from the palette only when the locator is in the build (E4)", async () => {
    const { user, invoke } = await mount(channel);
    const palette = await openPalette(user);
    expect(palette.getByRole("combobox")).toHaveAttribute(
      "placeholder",
      stable
        ? "Search anything: workspaces, agents, files, settings..."
        : "Search anything: workspaces, agents, files, settings...",
    );
    await user.type(palette.getByRole("combobox"), "theme");
    if (stable) {
      await palette.findByRole("option", { name: /Use dark theme/ });
      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(invoke.mock.calls.some(([command]) => command === "locator_search")).toBe(false);
      expect(palette.queryByText(/Searching…|Sessions and places/)).toBeNull();
    } else {
      await waitFor(() => expect(invoke.mock.calls.some(([command]) => command === "locator_search")).toBe(true));
    }
  });

  it("lists the Home, Project and Workspaces widgets in the pane add menu only when their views are visible (E5)", async () => {
    const { user } = await mount(channel);
    await user.click(primary().getByRole("button", { name: "Code" }));
    await user.click(await screen.findByRole("button", { name: "Add to pane 1" }));
    const menu = within(await screen.findByRole("menu"));
    expect(menu.getByRole("menuitem", { name: "Dashboard" })).toBeInTheDocument();
    for (const name of ["Home", "Project", "Workspaces"]) {
      const item = menu.queryByRole("menuitem", { name });
      if (stable) expect(item).toBeNull();
      else expect(item).toBeInTheDocument();
    }
  });

  it("names the unshipped Git pane only where the Git feature is visible, and lists Browser up top (B8 D4, D7)", async () => {
    const { user } = await mount(channel);
    await user.click(primary().getByRole("button", { name: "Code" }));
    await user.click(await screen.findByRole("button", { name: "Add to pane 1" }));
    const menu = within(await screen.findByRole("menu"));
    const items = menu.getAllByRole("menuitem").map((item) => item.textContent ?? "");
    const browser = items.findIndex((text) => text.startsWith("Browser"));
    const dashboard = items.findIndex((text) => text.startsWith("Dashboard"));
    expect(browser).toBeGreaterThan(-1);
    // Browser sits with the other "open here" items, above the Dashboard and the widget list.
    expect(browser).toBeLessThan(dashboard);
    const git = menu.queryByRole("menuitem", { name: /^Git/ });
    if (stable) expect(git).toBeNull();
    else expect(git).toBeInTheDocument();
  });
});
