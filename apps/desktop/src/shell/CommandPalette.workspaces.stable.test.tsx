import type { SurfaceFlag, Workspace } from "@kalcode/protocol";
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
import { createFavoritesStore, FAVORITES_STORAGE_KEY } from "./favorites/store.ts";
import nativeStableSurfaces from "./fixtures/stable-native-surfaces.json";
import { Shell } from "./Shell.tsx";

// Two projects may share a folder name (two clones called "api-server"). Each gets its own
// "Switch to" command that keyboard selection can reach, told apart by its path.
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

const CLONE_ID = "00000000-0000-4000-8000-00000000c10e";

async function mountStable() {
  const transport = createMemoryTransport("code", { detectDelayMs: 0 });
  const invoke = transport.invoke.bind(transport);
  let clone: Workspace | null = null;
  const activated: string[] = [];
  vi.spyOn(transport, "invoke").mockImplementation(async (command, args) => {
    if (command === "workspace_activate" && args?.workspaceId === CLONE_ID && clone) {
      activated.push(CLONE_ID);
      return clone as never;
    }
    if (command === "workspace_activate") activated.push(String(args?.workspaceId));
    const result = await invoke(command, args);
    if (command === "workspace_list") {
      const list = result as Workspace[];
      const api = list.find((w) => w.name === "api-server");
      if (!api) return result as never;
      clone ??= {
        ...api,
        id: CLONE_ID,
        rootPath: "C:\\Work\\api-server",
        displayPath: "C:\\Work\\api-server",
        lastOpenedAt: new Date(Date.parse(api.lastOpenedAt) - 60_000).toISOString(),
      };
      return [...list, clone] as never;
    }
    return result as never;
  });
  const client = new KalCodeClient(transport);
  const boot = await client.boot();
  boot.info.channel = "stable";
  boot.info.flags.surfaces = (nativeStableSurfaces as SurfaceFlag[]).map((flag) => ({ ...flag }));
  boot.info.flags.features = boot.info.flags.features.map((flag) => ({ ...flag, visible: flag.state === "available" }));
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
  return { user: userEvent.setup(), activated, client };
}

describe("palette workspace switching (Stable)", () => {
  it("omits a visible pin from suggestions while keeping it in typed search", async () => {
    localStorage.removeItem(FAVORITES_STORAGE_KEY);
    const { user, client } = await mountStable();
    const workspace = (await client.listWorkspaces()).find(
      (item) => item.name === "api-server" && item.id !== CLONE_ID,
    );
    if (!workspace) throw new Error("Missing workspace fixture");
    act(() => {
      createFavoritesStore(() => localStorage).toggle(
        { kind: "workspace", id: workspace.id, workspaceId: workspace.id },
        workspace.name,
        null,
      );
      window.dispatchEvent(new StorageEvent("storage", { key: FAVORITES_STORAGE_KEY }));
    });
    await user.keyboard("{Control>}k{/Control}");
    const palette = within(await screen.findByRole("dialog", { name: "Command palette" }));
    await waitFor(() => expect(palette.getAllByRole("option", { name: /^api-server.*Workspace/ })).toHaveLength(1));
    await user.type(palette.getByRole("combobox"), "api-server");
    await waitFor(() => expect(palette.getAllByRole("option", { name: /^api-server.*Workspace/ })).toHaveLength(2));
    localStorage.removeItem(FAVORITES_STORAGE_KEY);
  });

  it("reaches and opens each of two same-named projects from the keyboard", async () => {
    const { user, activated } = await mountStable();
    await user.keyboard("{Control>}k{/Control}");
    const palette = within(await screen.findByRole("dialog", { name: "Command palette" }));
    await user.type(palette.getByRole("combobox"), "switch to api");

    const options = await palette.findAllByRole("option", { name: /^api-server.*Workspace/ });
    expect(options).toHaveLength(2);
    // Same names are told apart by where each project lives.
    expect(new Set(options.map((o) => o.textContent)).size).toBe(2);
    expect(options.some((o) => o.textContent?.includes("C:\\Work\\api-server"))).toBe(true);

    // Only one option is ever selected, and the arrow keys move between the two.
    await waitFor(() => expect(palette.getAllByRole("option", { selected: true })).toHaveLength(1));
    const start = palette.getByRole("option", { selected: true });
    await user.keyboard("{ArrowDown}");
    expect(palette.getAllByRole("option", { selected: true })).toHaveLength(1);
    expect(palette.getByRole("option", { selected: true })).not.toBe(start);

    // Select the clone from the keyboard and open it.
    const clone = options.find((o) => o.textContent?.includes("C:\\Work\\api-server"));
    while (palette.getByRole("option", { selected: true }) !== clone) await user.keyboard("{ArrowDown}");
    await user.keyboard("{Enter}");
    await waitFor(() => expect(activated).toContain(CLONE_ID));
  }, 15_000);
});
