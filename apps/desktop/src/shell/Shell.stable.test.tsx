import type { SurfaceFlag } from "@kalcode/protocol";
import { ToastProvider, TooltipProvider } from "@kalcode/ui/components";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AccountProvider } from "../account/AccountProvider.tsx";
import { AccountClient } from "../ipc/account.ts";
import { KalCodeClient } from "../ipc/client.ts";
import { createMemoryTransport } from "../ipc/memoryTransport.ts";
import { RuntimeProvider } from "../runtime/RuntimeProvider.tsx";
import { goTo, morePlaces } from "../test/nav.ts";
import nativeStableSurfaces from "./fixtures/stable-native-surfaces.json";
import { Shell } from "./Shell.tsx";

// The shell registers terminal panes eagerly; this test never opens one. Avoid xterm's
// canvas capability probe in jsdom while keeping the complete KalVoice subtree real.
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

async function mountStable(compiled = true) {
  const transport = createMemoryTransport("account-ready", { detectDelayMs: 0 });
  const client = new KalCodeClient(transport);
  const boot = await client.boot();
  // Native Rust parity test verifies this fixture against the actual Stable flags table
  // after its speech-engine component check. Keep memory transport's Development flags out.
  boot.info.channel = "stable";
  boot.info.flags.surfaces = (nativeStableSurfaces as SurfaceFlag[]).map((flag) =>
    flag.id === "kalvoice" && !compiled ? { ...flag, visible: false } : { ...flag },
  );
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

it("mounts Stable KalVoice navigation, provider, widget and Settings when the speech engine is compiled", async () => {
  const user = await mountStable();
  const primary = within(screen.getByRole("navigation", { name: "Primary" }));
  const places = await morePlaces(user);
  expect(places).toEqual(expect.arrayContaining(["KalVoice", "Operations"]));
  expect(places).not.toContain("Agents");
  await user.keyboard("{Escape}");
  expect(await screen.findByRole("region", { name: "KalVoice widget" })).toBeInTheDocument();
  expect(primary.queryByRole("button", { name: "Agents" })).toBeNull();
  await goTo(user, "Operations");
  expect(await screen.findByRole("heading", { name: "Operations", level: 1 })).toBeInTheDocument();
  await goTo(user, "KalVoice");
  expect(await screen.findByRole("heading", { name: "KalVoice", level: 1 })).toBeInTheDocument();
  expect(screen.getByRole("textbox", { name: "Type a request for KalVoice" })).toBeInTheDocument();
  await user.click(primary.getByRole("button", { name: "Settings" }));
  expect(await screen.findByText("Speech model")).toBeInTheDocument();
  expect(screen.getByText(/Local dictation is unlimited on every plan/)).toBeInTheDocument();
});

it("keeps KalVoice out of the Stable shell when the native speech component is absent", async () => {
  const user = await mountStable(false);
  const primary = within(screen.getByRole("navigation", { name: "Primary" }));
  expect(await morePlaces(user)).not.toContain("KalVoice");
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("region", { name: "KalVoice widget" })).toBeNull();
  await user.click(primary.getByRole("button", { name: "Settings" }));
  expect(screen.queryByText("Speech model")).toBeNull();
});
