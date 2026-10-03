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
import { resetAccountIntentForTests } from "../surfaces/threads/accountIntent.ts";
import { paletteThreadLabel } from "./CommandPalette.tsx";
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
    // The default list and placeholder are unchanged: no per-thread items until something is typed.
    expect(palette.getByRole("combobox")).toHaveAttribute("placeholder", "Search workspaces and commands");
    expect(palette.queryByRole("option", { name: /· Claude Code/ })).toBeNull();
    expect(palette.getByRole("option", { name: "New thread" })).toBeInTheDocument();

    await user.type(palette.getByRole("combobox"), "parser");
    const option = await palette.findByRole("option", {
      name: "Write Unit Tests for Parser Module · Claude Code · Personal",
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

  it("never lists a coding agent under Threads", async () => {
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
      await palette.findByRole("option", { name: "Write Unit Tests for Parser Module · Claude Code · Personal" }),
    ).toBeInTheDocument();
    expect(palette.queryByRole("option", { name: /Parser Agent/ })).toBeNull();
  }, 15_000);
});
