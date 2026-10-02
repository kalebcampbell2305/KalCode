import type { SurfaceFlag } from "@kalcode/protocol";
import { ToastProvider, TooltipProvider } from "@kalcode/ui/components";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccountProvider } from "../account/AccountProvider.tsx";
import { AccountClient, type AccountCommandName, type AccountTier } from "../ipc/account.ts";
import { KalCodeClient } from "../ipc/client.ts";
import { createMemoryTransport } from "../ipc/memoryTransport.ts";
import { RuntimeProvider } from "../runtime/RuntimeProvider.tsx";
import { kalcodeIdentity, planLabel } from "./AccountHub.tsx";
import nativeStableSurfaces from "./fixtures/stable-native-surfaces.json";
import { Shell } from "./Shell.tsx";

// The shell registers terminal panes eagerly; these tests never open one.
vi.mock("@xterm/xterm", () => ({ Terminal: class {} }));

beforeEach(() => {
  // jsdom has no layout; focusSection scrolls the section into view.
  Element.prototype.scrollIntoView = vi.fn();
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

interface MountOptions {
  collapsed?: boolean;
  displayName?: string;
  tier?: AccountTier;
}

/** The Stable shell signed in as owner@example.com (Free unless `tier` says otherwise). */
async function mount({ collapsed = false, displayName, tier }: MountOptions = {}) {
  const transport = createMemoryTransport("account-ready", { detectDelayMs: 0 });
  const client = new KalCodeClient(transport);
  const boot = await client.boot();
  boot.info.channel = "stable";
  boot.info.flags.surfaces = (nativeStableSurfaces as SurfaceFlag[]).map((flag) => ({ ...flag }));
  boot.info.flags.features = boot.info.flags.features.map((flag) => ({ ...flag, visible: flag.state === "available" }));
  const accountCalls: AccountCommandName[] = [];
  const accounts = new AccountClient({
    async invoke(command, args) {
      accountCalls.push(command);
      const result = await transport.invoke<Record<string, unknown>>(command, args);
      return tier && command === "account_status" && result.tier ? { ...result, tier } : result;
    },
  });
  const settings = { ...(await client.getSettings()), sidebarCollapsed: collapsed, displayName };
  render(
    <ToastProvider>
      <TooltipProvider>
        <AccountProvider client={accounts}>
          <RuntimeProvider client={client} info={boot.info} initialSettings={settings}>
            <Shell />
          </RuntimeProvider>
        </AccountProvider>
      </TooltipProvider>
    </ToastProvider>,
  );
  const user = userEvent.setup();
  const hub = await screen.findByRole("button", { name: /^Account:/ });
  return { user, hub, accountCalls };
}

const items = () => within(screen.getByRole("menu")).getAllByRole("menuitem");

describe("kalcodeIdentity (the hub's name and initials)", () => {
  it("prefers the display name and falls back to the email's local part", () => {
    expect(kalcodeIdentity("Ada Lovelace", "ada@example.com")).toEqual({ name: "Ada Lovelace", initials: "AL" });
    expect(kalcodeIdentity("  ", "grace.hopper@example.com")).toEqual({
      name: "grace.hopper",
      initials: "GH",
    });
    expect(kalcodeIdentity(null, "owner@example.com")).toEqual({ name: "owner", initials: "O" });
    expect(kalcodeIdentity("Émile Zola Jr", "e@example.com").initials).toBe("ÉJ");
    // A malformed address keeps every character rather than losing the last one.
    expect(kalcodeIdentity(null, "localonly")).toEqual({ name: "localonly", initials: "L" });
    expect(kalcodeIdentity(undefined, "@example.com").name).toBe("@example.com");
  });
});

describe("planLabel", () => {
  it("names the verified plan and says when access is offline", () => {
    expect(planLabel("pro", "ready")).toBe("Pro plan");
    expect(planLabel("max2x", "ready")).toBe("Max 2X plan");
    expect(planLabel("owner", "ready")).toBe("Owner");
    expect(planLabel("free", "offline_grace")).toBe("Free plan · Offline");
    expect(planLabel(null, "authenticated_unactivated")).toBeNull();
  });
});

describe("Account Hub", () => {
  it("shows the avatar initials, name and plan at the foot of the sidebar", async () => {
    const { hub } = await mount({ displayName: "Ada Lovelace" });
    const primary = screen.getByRole("navigation", { name: "Primary" });
    expect(primary).toContainElement(hub);
    expect(hub).toHaveAccessibleName("Account: Ada Lovelace, Free plan");
    expect(hub).toHaveTextContent("AL");
    expect(hub).toHaveTextContent("Ada Lovelace");
    expect(hub).toHaveTextContent("Free plan");
    expect(hub).toHaveAttribute("aria-haspopup", "menu");
    // The build version lives in the hub menu while an account is shown.
    expect(within(primary).queryByText(/^Version /)).toBeNull();
    // The hub opens a menu; it never jumps straight to Settings.
    expect(screen.queryByRole("heading", { level: 1, name: "Settings" })).toBeNull();
  });

  it("collapses to the avatar with a tooltip and still opens the menu", async () => {
    const { user, hub } = await mount({ collapsed: true, tier: "pro" });
    expect(hub).toHaveAccessibleName("Account: owner, Pro plan");
    expect(hub).toHaveTextContent(/^O$/);
    await user.hover(hub);
    expect(await screen.findByRole("tooltip")).toHaveTextContent("owner · Pro plan");
    await user.click(hub);
    expect(screen.getByRole("menu")).toHaveTextContent("owner@example.com");
    // The tooltip never sits over the open menu.
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("lists the account shortcuts, Settings and Sign out", async () => {
    const { user, hub } = await mount();
    await user.click(hub);
    const menu = screen.getByRole("menu");
    expect(menu).toHaveTextContent("owner@example.com");
    expect(items().map((item) => item.textContent?.replace(/(Ctrl|⌘) K$/, "").trim())).toEqual([
      "Account & plan",
      "Usage",
      "Billing",
      "Connected providers",
      "KalVoice",
      "Preferences",
      "Appearance",
      "Keyboard shortcuts",
      "Full Settings",
      "Sign out",
    ]);
    // Usage comes from the verified account (Free: 75 KalVoice requests).
    await waitFor(() => expect(menu).toHaveTextContent("0 of 75"));
  });

  it("is keyboard operable and returns focus to the hub on Escape", async () => {
    const { user, hub } = await mount();
    hub.focus();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(items()[0]).toHaveFocus());
    await user.keyboard("{ArrowDown}");
    expect(items()[1]).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(hub).toHaveFocus();
  });

  it.each([
    ["Appearance", "Appearance"],
    ["Account & plan", "KalCode account"],
    ["Usage", "KalCode account"],
    ["KalVoice", "KalVoice"],
    ["Preferences", "Permissions"],
  ])("%s opens Settings at its section", async (item, section) => {
    const { user, hub } = await mount();
    await user.click(hub);
    await user.click(screen.getByRole("menuitem", { name: item }));
    expect(await screen.findByRole("heading", { level: 1, name: "Settings" })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("heading", { level: 2, name: section })).toHaveFocus());
  });

  it("opens the Providers surface, full Settings and the command palette", async () => {
    const { user, hub } = await mount();
    await user.click(hub);
    await user.click(screen.getByRole("menuitem", { name: "Connected providers" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Providers" })).toBeInTheDocument();
    await user.click(hub);
    await user.click(screen.getByRole("menuitem", { name: "Full Settings" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Settings" })).toBeInTheDocument();
    await user.click(hub);
    await user.click(screen.getByRole("menuitem", { name: /Keyboard shortcuts/ }));
    expect(await screen.findByRole("dialog", { name: /command/i })).toBeInTheDocument();
  });

  it("opens the billing portal for a paid plan", async () => {
    const { user, hub, accountCalls } = await mount({ tier: "pro" });
    await user.click(hub);
    await user.click(screen.getByRole("menuitem", { name: "Billing" }));
    await waitFor(() => expect(accountCalls).toContain("account_portal"));
    expect(await screen.findByRole("heading", { level: 1, name: "Settings" })).toBeInTheDocument();
  });

  it("sends a Free plan's Billing to the account section without opening a portal", async () => {
    const { user, hub, accountCalls } = await mount();
    await user.click(hub);
    await user.click(screen.getByRole("menuitem", { name: "Billing" }));
    await waitFor(() => expect(screen.getByRole("heading", { level: 2, name: "KalCode account" })).toHaveFocus());
    expect(accountCalls).not.toContain("account_portal");
  });

  it("signs out through the account's sign-out path", async () => {
    const { user, hub, accountCalls } = await mount();
    await user.click(hub);
    await user.click(screen.getByRole("menuitem", { name: "Sign out" }));
    await waitFor(() => expect(accountCalls).toContain("account_logout"));
    await waitFor(() => expect(screen.queryByRole("button", { name: /^Account:/ })).toBeNull());
    // Without the hub, the sidebar footer still shows the build version.
    expect(within(screen.getByRole("navigation", { name: "Primary" })).getByText(/^Version \d/)).toBeInTheDocument();
  });
});
