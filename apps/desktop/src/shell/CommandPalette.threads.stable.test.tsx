import type { SurfaceFlag } from "@kalcode/protocol";
import { ToastProvider, TooltipProvider } from "@kalcode/ui/components";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccountProvider } from "../account/AccountProvider.tsx";
import { AccountClient } from "../ipc/account.ts";
import { KalCodeClient } from "../ipc/client.ts";
import { createMemoryTransport } from "../ipc/memoryTransport.ts";
import { RuntimeProvider } from "../runtime/RuntimeProvider.tsx";
import { resetAccountIntentForTests } from "../surfaces/threads/accountIntent.ts";
import { paletteThreadLabel } from "./CommandPalette.tsx";
import { FAVORITES_STORAGE_KEY } from "./favorites/store.ts";
import nativeStableSurfaces from "./fixtures/stable-native-surfaces.json";
import { Shell } from "./Shell.tsx";

// TK-4 palette part: open threads by "Name · Provider · Account" on the Stable channel, without
// the Gated Session Locator. The default (empty) palette list is unchanged.
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
  resetAccountIntentForTests();
  vi.unstubAllGlobals();
  if (originalScroll) Object.defineProperty(HTMLElement.prototype, "scrollIntoView", originalScroll);
  else Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
});

async function mountStable() {
  const transport = createMemoryTransport("threads", { detectDelayMs: 0 });
  const client = new KalCodeClient(transport);
  const boot = await client.boot();
  boot.info.channel = "stable";
  boot.info.flags.surfaces = (nativeStableSurfaces as SurfaceFlag[]).map((flag) => ({ ...flag }));
  boot.info.flags.features = boot.info.flags.features.map((flag) => ({ ...flag, visible: flag.state === "available" }));
  expect(boot.info.flags.features.find((f) => f.id === "session_locator")?.visible).toBe(false);
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
  return { user: userEvent.setup(), client };
}

async function openPalette(user: ReturnType<typeof userEvent.setup>) {
  await user.keyboard("{Control>}k{/Control}");
  return within(await screen.findByRole("dialog", { name: "Command palette" }));
}

describe("palette threads (Stable)", () => {
  it("saves a command without executing it or closing the palette", async () => {
    localStorage.removeItem(FAVORITES_STORAGE_KEY);
    const { user, client } = await mountStable();
    const create = vi.spyOn(client, "createThread");
    const palette = await openPalette(user);
    await user.type(palette.getByRole("combobox"), "New thread");
    const favorite = await palette.findByRole("button", { name: /^(Add Favorite|Pin globally): New thread$/ });
    expect(favorite.closest('[role="option"]')).toBeNull();
    expect(favorite.closest('[role="listbox"]')).toBeNull();
    await user.click(favorite);
    expect(screen.getByRole("dialog", { name: "Command palette" })).toBeVisible();
    expect(create).not.toHaveBeenCalled();
    expect(JSON.parse(localStorage.getItem(FAVORITES_STORAGE_KEY) ?? "{}").entries).toEqual([
      expect.objectContaining({ target: { kind: "command", id: "thread:new", workspaceId: null } }),
    ]);
    await user.click(palette.getByRole("button", { name: /^(Remove Favorite|Unpin globally): New thread$/ }));
    expect(JSON.parse(localStorage.getItem(FAVORITES_STORAGE_KEY) ?? "{}").entries).toEqual([]);
  });

  it("labels a thread Name · Provider · Account", () => {
    expect(paletteThreadLabel({ name: "Research", providerName: "Gemini CLI", accountLabel: "Gemini B" })).toBe(
      "Research · Gemini CLI · Gemini B",
    );
    expect(paletteThreadLabel({ name: "Research", providerName: "Codex", accountLabel: null })).toBe(
      "Research · Codex",
    );
  });

  it("lists open threads by name once typed and focuses the chosen one", async () => {
    const { user } = await mountStable();
    const palette = await openPalette(user);
    // The warm local index offers contextual suggestions immediately.
    expect(palette.getByRole("combobox")).toHaveAttribute(
      "placeholder",
      "Search anything: workspaces, agents, files, settings...",
    );
    expect(palette.getByRole("option", { name: "New thread" })).toBeInTheDocument();

    await user.type(palette.getByRole("combobox"), "parser");
    const option = await palette.findByRole("option", {
      name: /Write Unit Tests for Parser Module.*Thread.*Claude Code.*Personal/,
    });
    // Archived threads are not offered.
    await user.clear(palette.getByRole("combobox"));
    await user.type(palette.getByRole("combobox"), "bump deps");
    expect(palette.queryByRole("option", { name: /Bump Deps/ })).toBeNull();
    await user.clear(palette.getByRole("combobox"));
    await user.type(palette.getByRole("combobox"), "parser");
    await user.click(await palette.findByRole("option", { name: option.textContent ?? "" }));

    const detail = await screen.findByRole("region", { name: "Thread" });
    await waitFor(() =>
      expect(within(detail).getByRole("heading", { name: "Write Unit Tests for Parser Module" })).toBeInTheDocument(),
    );
  }, 15_000);

  it("keeps a deliberate keyboard selection when slower account metadata arrives", async () => {
    const { user, client } = await mountStable();
    const threads = await client.listThreads({ includeArchived: false });
    const base = threads[0];
    if (!base) throw new Error("Missing thread fixture");
    vi.spyOn(client, "listThreads").mockResolvedValue([
      { ...base, id: "selection-a", name: "Selection alpha", archivedAt: null },
      { ...base, id: "selection-b", name: "Selection beta", archivedAt: null },
    ]);
    const accounts = await client.listProviderAccounts();
    let release: ((value: typeof accounts) => void) | undefined;
    vi.spyOn(client, "listProviderAccounts").mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const palette = await openPalette(user);
    await user.type(palette.getByRole("combobox"), "Selection");
    const alpha = await palette.findByRole("option", { name: /Selection alpha/ });
    const beta = await palette.findByRole("option", { name: /Selection beta/ });
    await waitFor(() => expect(alpha).toHaveAttribute("aria-selected", "true"));
    await user.keyboard("{ArrowDown}");
    expect(beta).toHaveAttribute("aria-selected", "true");
    await act(async () => release?.(accounts.map((account) => ({ ...account, displayName: "Selection account" }))));
    await palette.findAllByRole("option", { name: /Selection account/ });
    await waitFor(() => expect(beta).toHaveAttribute("aria-selected", "true"));
    expect(palette.getByRole("combobox")).toHaveAttribute("aria-activedescendant", beta.id);
  }, 15_000);

  it("offers New agent first, with options next, and finds them by agent or provider words", async () => {
    const { user } = await mountStable();
    const palette = await openPalette(user);
    const options = palette.getAllByRole("option").map((option) => option.textContent);
    const start = options.indexOf("New agent");
    expect(start).toBeGreaterThanOrEqual(0);
    expect(options[start + 1]).toBe("New agent with options…");
    await user.type(palette.getByRole("combobox"), "codex");
    expect(await palette.findByRole("option", { name: /^New agent$/ })).toBeInTheDocument();
    await user.clear(palette.getByRole("combobox"));
    await user.type(palette.getByRole("combobox"), "model");
    expect(await palette.findByRole("option", { name: "New agent with options…" })).toBeInTheDocument();
    await user.clear(palette.getByRole("combobox"));
    await user.type(palette.getByRole("combobox"), "new agent");
    await user.keyboard("{Enter}");
    // The palette closes and Code opens for the launcher.
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Command palette" })).toBeNull());
  }, 15_000);

  it("lists a coding agent under Agents, never under Threads", async () => {
    const { user, client } = await mountStable();
    const listThreads = client.listThreads.bind(client);
    vi.spyOn(client, "listThreads").mockImplementation(async (args) => {
      const listed = await listThreads(args);
      const base = listed.find((t) => t.archivedAt === null);
      if (!base) return listed;
      const agent = { ...base, id: "agent-parser", name: "Parser Agent", runtimeKind: "interactive_pty" as const };
      return [...listed, agent];
    });
    const palette = await openPalette(user);
    await user.type(palette.getByRole("combobox"), "parser");
    expect(
      await palette.findByRole("option", { name: /Write Unit Tests for Parser Module.*Thread.*Claude Code.*Personal/ }),
    ).toBeInTheDocument();
    expect(palette.getByRole("option", { name: /Parser Agent.*Coding agent/ })).toBeInTheDocument();
    expect(palette.queryByRole("option", { name: /Parser Agent.*Thread/ })).toBeNull();
  }, 15_000);

  it("opens a coding agent result in Code through the canonical agent focus, even when its thread read fails", async () => {
    const { user, client } = await mountStable();
    const listThreads = client.listThreads.bind(client);
    vi.spyOn(client, "listThreads").mockImplementation(async (args) => {
      const listed = await listThreads(args);
      const base = listed.find((t) => t.archivedAt === null);
      if (!base) return listed;
      return [
        ...listed,
        { ...base, id: "agent-parser", name: "Parser Agent", runtimeKind: "interactive_pty" as const },
      ];
    });
    const getThread = client.getThread.bind(client);
    vi.spyOn(client, "getThread").mockImplementation(async (id) => {
      if (id === "agent-parser") throw new Error("transient metadata failure");
      return getThread(id);
    });
    const palette = await openPalette(user);
    await user.type(palette.getByRole("combobox"), "parser agent");
    await user.click(await palette.findByRole("option", { name: /Parser Agent.*Coding agent/ }));
    const primary = screen.getByRole("navigation", { name: "Primary" });
    await waitFor(() =>
      expect(within(primary).getByRole("button", { name: "Code" })).toHaveAttribute("aria-current", "page"),
    );
    expect(screen.queryByRole("region", { name: "Thread" })).toBeNull();
  }, 15_000);
});
