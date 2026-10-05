import { ToastProvider, TooltipProvider } from "@kalcode/ui/components";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AccountProvider } from "../account/AccountProvider.tsx";
import { AccountClient } from "../ipc/account.ts";
import { KalCodeClient } from "../ipc/client.ts";
import { createMemoryTransport } from "../ipc/memoryTransport.ts";
import { RuntimeProvider } from "../runtime/RuntimeProvider.tsx";
import { Shell } from "./Shell.tsx";

vi.mock("../surfaces/code/TerminalView.tsx", () => ({ TerminalView: () => null }));

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

async function mount() {
  const transport = createMemoryTransport("code", { detectDelayMs: 0 });
  const client = new KalCodeClient(transport);
  const boot = await client.boot();
  // Voice capture is unrelated to navigation and needs native media devices.
  boot.info.flags.surfaces = boot.info.flags.surfaces.map((flag) =>
    flag.id === "kalvoice" ? { ...flag, visible: false } : flag,
  );
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
  const primary = within(screen.getByRole("navigation", { name: "Primary" }));
  return { user: userEvent.setup(), primary };
}

it("Back restores the exact provider account after its page remounts", async () => {
  const { user, primary } = await mount();
  await user.click(primary.getByRole("button", { name: "Providers" }));
  const accountId = "provider-account-0192f3c4-0000-7000-8000-000000000202";
  await waitFor(() => expect(document.getElementById(accountId)).not.toBeNull());
  act(() => document.getElementById(accountId)?.focus());
  await user.click(primary.getByRole("button", { name: "Settings" }));
  await screen.findByRole("heading", { name: "Settings", level: 1 });
  await user.click(screen.getByRole("button", { name: "Go back" }));
  await waitFor(() => expect(document.activeElement?.id).toBe(accountId));
  expect(screen.getByRole("tab", { name: "Accounts" })).toHaveAttribute("aria-selected", "true");
  await user.click(screen.getByRole("tab", { name: "Health" }));
  await user.click(screen.getByRole("button", { name: "Go back" }));
  await waitFor(() => expect(document.activeElement?.id).toBe(accountId));
  expect(screen.getByRole("tab", { name: "Accounts" })).toHaveAttribute("aria-selected", "true");
});

it("Back restores a Settings section and Forward restores the selected Providers tab", async () => {
  const { user, primary } = await mount();
  await user.click(primary.getByRole("button", { name: "Settings" }));
  const appearance = await screen.findByRole("region", { name: "Appearance" });
  const heading = within(appearance).getByRole("heading");
  act(() => {
    heading.tabIndex = -1;
    heading.focus();
  });
  await user.click(primary.getByRole("button", { name: "Providers" }));
  await user.click(await screen.findByRole("tab", { name: "Setup" }));
  // The tab change is a visit of its own; Back first returns to Accounts.
  await user.click(screen.getByRole("button", { name: "Go back" }));
  await waitFor(() => expect(screen.getByRole("tab", { name: "Accounts" })).toHaveAttribute("aria-selected", "true"));
  await user.click(screen.getByRole("button", { name: "Go back" }));
  await waitFor(() => expect(document.activeElement?.textContent).toBe("Appearance"));
  await user.click(screen.getByRole("button", { name: "Go forward" }));
  await waitFor(() => expect(screen.getByRole("tab", { name: "Accounts" })).toHaveAttribute("aria-selected", "true"));
  await user.click(screen.getByRole("button", { name: "Go forward" }));
  await waitFor(() => expect(screen.getByRole("tab", { name: "Setup" })).toHaveAttribute("aria-selected", "true"));
});

it("Back restores the selected Runs detail and closing it creates a forward branch", async () => {
  const { user, primary } = await mount();
  await user.click(primary.getByRole("button", { name: "Operations" }));
  // The run row, never its "Pin globally: Package desktop" favorite action (#235).
  await user.click(
    await screen.findByRole("button", {
      name: /^(?!(?:Pin|Unpin) globally: |(?:Add|Remove) Favorite: ).*Package desktop/,
    }),
  );
  await screen.findByRole("button", { name: "Close run details" });
  await user.click(primary.getByRole("button", { name: "Settings" }));
  await user.click(screen.getByRole("button", { name: "Go back" }));
  await screen.findByRole("heading", { name: "Package desktop", level: 2 });
  expect(screen.getByRole("tab", { name: "Runs" })).toHaveAttribute("aria-selected", "true");
  await user.click(screen.getByRole("button", { name: "Close run details" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Go forward" })).toBeDisabled());
});
