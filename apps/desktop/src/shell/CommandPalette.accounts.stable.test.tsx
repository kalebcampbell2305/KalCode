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
import { getRebindRequest, resetAccountIntentForTests, setSelectedThread } from "../surfaces/threads/accountIntent.ts";
import { matchAccounts, parseAccountCommand } from "./accountCommands.ts";
import nativeStableSurfaces from "./fixtures/stable-native-surfaces.json";
import { Shell } from "./Shell.tsx";

// 0.1.5 switch accounts, Lane 4: palette account commands on the Stable channel. A thread
// rebind only ever asks the Rebind dialog; a workspace default is written and confirmed.
vi.mock("../surfaces/code/TerminalView.tsx", () => ({ TerminalView: () => null }));

const originalScroll = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollIntoView");
beforeEach(() => {
  resetAccountIntentForTests();
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
  resetAccountIntentForTests();
  vi.unstubAllGlobals();
  if (originalScroll) Object.defineProperty(HTMLElement.prototype, "scrollIntoView", originalScroll);
  else Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
});

async function mountStable() {
  const transport = createMemoryTransport("code", { detectDelayMs: 0 });
  const invoke = vi.spyOn(transport, "invoke");
  const client = new KalCodeClient(transport);
  const boot = await client.boot();
  boot.info.channel = "stable";
  boot.info.flags.surfaces = (nativeStableSurfaces as SurfaceFlag[]).map((flag) => ({ ...flag }));
  boot.info.flags.features = boot.info.flags.features.map((flag) => ({ ...flag, visible: flag.state === "available" }));
  const geminiA = await client.createProviderAccount("gemini-cli", "Gemini A");
  // The shell checks Gemini accounts in the background (#129); a managed Gemini profile without its
  // own credentials reads as signed out, and a signed-out account asks for sign-in instead of a
  // rebind. Gemini B, the account the thread switches to, signs in through Gemini's login flow.
  const { loginHandle } = await client.startGeminiLogin(
    (await client.createProviderAccount("gemini-cli", "Gemini B")).id,
  );
  const geminiB = await client.waitForGeminiLogin(loginHandle);
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
  return { user: userEvent.setup(), invoke, client, geminiA, geminiB };
}

async function typeInPalette(user: ReturnType<typeof userEvent.setup>, text: string) {
  await user.keyboard("{Control>}k{/Control}");
  const palette = within(await screen.findByRole("dialog", { name: "Command palette" }));
  await user.type(palette.getByRole("combobox"), text);
  return palette;
}

function invoked(invoke: ReturnType<typeof vi.fn>, command: string) {
  return invoke.mock.calls.filter(([name]) => name === command);
}

describe("palette account commands (Stable)", () => {
  it("offers the named Gemini account for the shown thread and asks the Rebind dialog, never rebinding", async () => {
    const { user, invoke, geminiA, geminiB } = await mountStable();
    setSelectedThread({ threadId: "thread-gemini", providerId: "gemini-cli", providerAccountId: geminiA.id });
    const palette = await typeInPalette(user, "switch gemini b");

    expect(await palette.findByText("Accounts")).toBeInTheDocument();
    const forThread = await palette.findByRole("option", { name: /Use Gemini B \(Gemini CLI\) for this thread/ });
    expect(palette.getByRole("option", { name: /Use Gemini B \(Gemini CLI\) in this workspace/ })).toBeInTheDocument();
    // Only the account that was named.
    expect(palette.queryByRole("option", { name: /Gemini A/ })).toBeNull();

    await user.click(forThread);
    expect(getRebindRequest()).toMatchObject({ threadId: "thread-gemini", accountId: geminiB.id });
    expect(invoked(invoke as never, "thread_rebind_account")).toHaveLength(0);
    expect(invoked(invoke as never, "provider_account_bind")).toHaveLength(0);
  }, 15_000);

  it("shows every matching account when the name is ambiguous and marks the thread's current one", async () => {
    const { user, geminiA } = await mountStable();
    setSelectedThread({ threadId: "thread-gemini", providerId: "gemini-cli", providerAccountId: geminiA.id });
    const palette = await typeInPalette(user, "switch to gemini");
    const current = await palette.findByRole("option", { name: /Use Gemini A \(Gemini CLI\) for this thread/ });
    expect(current).toHaveTextContent("Current");
    expect(palette.getByRole("option", { name: /Use Gemini B \(Gemini CLI\) for this thread/ })).toBeInTheDocument();
    expect(palette.getByRole("option", { name: /Use Personal \(Gemini CLI\) for this thread/ })).toBeInTheDocument();
    // Nothing was picked for the person.
    expect(getRebindRequest()).toBeNull();
  }, 15_000);

  it("lists matching accounts default first, then in natural name order, marking the default", async () => {
    const { user, client } = await mountStable();
    await client.createProviderAccount("gemini-cli", "Gemini 10");
    await client.createProviderAccount("gemini-cli", "Gemini 2");
    setSelectedThread({ threadId: "thread-gemini", providerId: "gemini-cli", providerAccountId: null });
    const palette = await typeInPalette(user, "switch to gemini");
    const options = await palette.findAllByRole("option", { name: /for this thread/ });
    expect(options.map((option) => option.textContent?.replace(/ for this thread.*/, ""))).toEqual([
      "Use Personal (Gemini CLI)",
      "Use Gemini 2 (Gemini CLI)",
      "Use Gemini 10 (Gemini CLI)",
      "Use Gemini A (Gemini CLI)",
      "Use Gemini B (Gemini CLI)",
    ]);
    // The default was checked in the background and has no Gemini sign-in of its own.
    await waitFor(async () =>
      expect((await palette.findAllByRole("option", { name: /for this thread/ }))[0]).toHaveTextContent(
        "Default · Signed out",
      ),
    );
    expect(options[1]).not.toHaveTextContent("Default");
  });

  it("sets the workspace default with a confirmation toast", async () => {
    const { user, invoke } = await mountStable();
    const palette = await typeInPalette(user, "use claude personal");
    // No thread is shown: only the workspace item.
    expect(palette.queryByRole("option", { name: /for this thread/ })).toBeNull();
    await user.click(await palette.findByRole("option", { name: /Use Personal \(Claude Code\) in this workspace/ }));
    await waitFor(() => expect(invoked(invoke as never, "provider_account_bind")).toHaveLength(1));
    expect(invoked(invoke as never, "provider_account_bind")[0]?.[1]).toMatchObject({
      providerId: "claude-code",
      kind: "workspace",
    });
    expect(await screen.findByText("New Claude Code threads in kalcode-site use Personal")).toBeInTheDocument();
  });

  it("never binds a signed-out account and says to sign in", async () => {
    const { user, invoke } = await mountStable();
    const palette = await typeInPalette(user, "use codex work");
    const item = await palette.findByRole("option", { name: /Use Work \(Codex\) in this workspace/ });
    expect(item).toHaveTextContent("Signed out");
    await user.click(item);
    expect(await screen.findByText("Sign in to Work (Codex) first")).toBeInTheDocument();
    expect(invoked(invoke as never, "provider_account_bind")).toHaveLength(0);
  });

  it("keeps workspace switching and account switching apart under their own headings", async () => {
    const { user, client } = await mountStable();
    // An account named exactly like another workspace.
    await client.createProviderAccount("gemini-cli", "api-server");
    const palette = await typeInPalette(user, "switch to api-server");
    expect(await palette.findByRole("option", { name: "Switch to api-server" })).toBeInTheDocument();
    expect(palette.getByText("Code")).toBeInTheDocument();
    expect(await palette.findByText("Accounts")).toBeInTheDocument();
    expect(
      palette.getByRole("option", { name: /Use api-server \(Gemini CLI\) in this workspace/ }),
    ).toBeInTheDocument();
  });
});

describe("account command matching", () => {
  const account = (providerId: string, displayName: string, id = displayName) =>
    ({ id, providerId, displayName, archivedAt: null }) as never;
  const accounts = [
    account("gemini-cli", "Gemini A"),
    account("gemini-cli", "Gemini B"),
    account("codex", "Work"),
    account("codex", "Work 2"),
    account("claude-code", "Personal"),
    account("codex", "Personal", "codex-personal"),
  ];
  const labels = (text: string) =>
    matchAccounts(accounts, parseAccountCommand(text) ?? []).map(
      (a) => `${(a as { providerId: string }).providerId}:${(a as { displayName: string }).displayName}`,
    );

  it.each([
    ["switch gemini b", ["gemini-cli:Gemini B"]],
    ["switch to gemini a", ["gemini-cli:Gemini A"]],
    ["Switch to Gemini-A", ["gemini-cli:Gemini A"]],
    ["use codex work", ["codex:Work"]],
    ["use claude personal", ["claude-code:Personal"]],
    ["use my codex work account", ["codex:Work"]],
    ["switch gemini", ["gemini-cli:Gemini A", "gemini-cli:Gemini B"]],
    ["use personal", ["claude-code:Personal", "codex:Personal"]],
  ])("%s", (text, expected) => {
    expect(labels(text)).toEqual(expected);
  });

  it("ignores text that isn't an account command", () => {
    expect(parseAccountCommand("use dark theme")).toEqual(["dark", "theme"]);
    expect(labels("use dark theme")).toEqual([]);
    expect(parseAccountCommand("open settings")).toBeNull();
    expect(parseAccountCommand("switch")).toBeNull();
    expect(labels("switch to c")).toEqual([]);
  });
});
