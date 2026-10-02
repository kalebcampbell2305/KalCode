import type { SurfaceFlag } from "@kalcode/protocol";
import { ToastProvider, TooltipProvider } from "@kalcode/ui/components";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AccountProvider } from "../account/AccountProvider.tsx";
import { AccountClient } from "../ipc/account.ts";
import { KalCodeClient } from "../ipc/client.ts";
import { createMemoryTransport } from "../ipc/memoryTransport.ts";
import { RuntimeProvider } from "../runtime/RuntimeProvider.tsx";
import nativeStableSurfaces from "./fixtures/stable-native-surfaces.json";
import { Shell } from "./Shell.tsx";

const code = vi.hoisted(() => ({ mounts: 0, unmounts: 0 }));
// Code's terminals must survive navigation: count how often the page itself mounts.
vi.mock("../surfaces/code/CodePage.tsx", () => ({
  CodePage: () => {
    useEffect(() => {
      code.mounts += 1;
      return () => {
        code.unmounts += 1;
      };
    }, []);
    return <h1>Code page</h1>;
  },
}));
vi.mock("@xterm/xterm", () => ({ Terminal: class {} }));

beforeEach(() => {
  code.mounts = 0;
  code.unmounts = 0;
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

it("keeps Code mounted and hidden while another page is shown", async () => {
  const transport = createMemoryTransport("account-ready", { detectDelayMs: 0 });
  const client = new KalCodeClient(transport);
  const boot = await client.boot();
  boot.info.channel = "stable";
  boot.info.flags.surfaces = (nativeStableSurfaces as SurfaceFlag[]).map((flag) => ({ ...flag }));
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
  // Not mounted before the first visit.
  expect(screen.queryByText("Code page")).toBeNull();

  await user.click(primary.getByRole("button", { name: "Code" }));
  expect(await screen.findByRole("heading", { name: "Code page", level: 1 })).toBeInTheDocument();
  const main = screen.getByRole("main");
  expect(main).toHaveAttribute("data-surface", "code");

  await user.click(primary.getByRole("button", { name: "Settings" }));
  expect(main).toHaveAttribute("data-surface", "settings");
  // Hidden: out of the accessibility tree (one h1 per page), but still mounted.
  expect(screen.queryByRole("heading", { name: "Code page" })).toBeNull();
  expect(screen.getByText("Code page").closest("[hidden]")).not.toBeNull();

  await user.click(primary.getByRole("button", { name: "Code" }));
  expect(screen.getByRole("heading", { name: "Code page", level: 1 })).toBeInTheDocument();
  expect(code.mounts).toBe(1);
  expect(code.unmounts).toBe(0);
});
