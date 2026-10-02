import type { ProviderAccount, SurfaceFlag, ThreadSummary } from "@kalcode/protocol";
import { ToastProvider, TooltipProvider } from "@kalcode/ui/components";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccountProvider } from "../../account/AccountProvider.tsx";
import { AccountClient } from "../../ipc/account.ts";
import { KalCodeClient } from "../../ipc/client.ts";
import { createMemoryTransport } from "../../ipc/memoryTransport.ts";
import type { CommandName } from "../../ipc/transport.ts";
import { RuntimeProvider } from "../../runtime/RuntimeProvider.tsx";
import { resetAccountIntentForTests } from "../../surfaces/threads/accountIntent.ts";
import nativeStableSurfaces from "../fixtures/stable-native-surfaces.json";
import { Shell } from "../Shell.tsx";

// The Provider Dock in the Stable Command Deck, against the memory transport's accounts: Claude
// Personal, Codex Personal, Codex Work (signed out), Gemini Personal, plus Gemini B and Codex B.
vi.mock("@xterm/xterm", () => ({ Terminal: class {} }));

const GEMINI_PERSONAL = "0192f3c4-0000-7000-8000-000000000301";
const CODEX_PERSONAL = "0192f3c4-0000-7000-8000-000000000201";

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
});
afterEach(() => {
  vi.unstubAllGlobals();
  resetAccountIntentForTests();
  Reflect.deleteProperty(document, "elementFromPoint");
});

async function settledThread(client: KalCodeClient, providerId: string, providerAccountId: string, name: string) {
  const options = await client.threadOptions();
  const workspace = options.workspaces[0];
  if (!workspace) throw new Error("fixture has no workspace");
  const created = await client.createThread({
    providerId,
    providerAccountId,
    workspaceId: workspace.id,
    model: null,
    permissionMode: "approve",
    prompt: `Work on ${name}`,
    name,
  });
  return client.stopThread(created.id);
}

interface Mounted {
  user: ReturnType<typeof userEvent.setup>;
  calls: (command: CommandName) => number;
  gemini: ThreadSummary;
  geminiB: ProviderAccount;
  codex: ThreadSummary;
}

async function mountStable(options: { codexPersonalFailing?: boolean } = {}): Promise<Mounted> {
  const transport = createMemoryTransport("threads", { detectDelayMs: 0 });
  const original = transport.invoke.bind(transport);
  const counts = new Map<string, number>();
  vi.spyOn(transport, "invoke").mockImplementation(async (command, args) => {
    counts.set(command, (counts.get(command) ?? 0) + 1);
    const result = await original(command, args);
    if (command === "provider_accounts_list" && options.codexPersonalFailing) {
      return (result as ProviderAccount[]).map((account) =>
        account.id === CODEX_PERSONAL ? { ...account, lastErrorCode: "auth_expired" } : account,
      ) as never;
    }
    return result as never;
  });
  const client = new KalCodeClient(transport);
  const boot = await client.boot();
  boot.info.channel = "stable";
  boot.info.flags.surfaces = (nativeStableSurfaces as SurfaceFlag[]).map((flag) => ({ ...flag }));
  boot.info.flags.features = boot.info.flags.features.map((flag) => ({ ...flag, visible: flag.state === "available" }));
  await client.detectProviders();
  const geminiB = await client.createProviderAccount("gemini-cli", "Gemini B");
  await client.createProviderAccount("codex", "B");
  const gemini = await settledThread(client, "gemini-cli", GEMINI_PERSONAL, "Gemini docs pass");
  const codex = await settledThread(client, "codex", CODEX_PERSONAL, "Codex cleanup");
  counts.clear();
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
  return { user: userEvent.setup(), calls: (command) => counts.get(command) ?? 0, gemini, geminiB, codex };
}

const dock = async () => within(await screen.findByRole("group", { name: "Provider accounts" }));
const chip = async (label: string) => (await dock()).findByRole("button", { name: new RegExp(`^${label}:`) });

async function openThread(user: Mounted["user"], name: string) {
  const primary = within(screen.getByRole("navigation", { name: "Primary" }));
  await user.click(primary.getByRole("button", { name: "Threads" }));
  const list = await screen.findByRole("list", { name: "Threads" });
  await user.click(await within(list).findByRole("button", { name: new RegExp(name) }));
  await screen.findByRole("heading", { name, level: 2 });
}

function pointer(target: EventTarget, type: string, x: number, y: number) {
  const event = new MouseEvent(type, { bubbles: true, button: 0, clientX: x, clientY: y });
  Object.defineProperty(event, "pointerId", { value: 1 });
  act(() => {
    target.dispatchEvent(event);
  });
}

/** Presses `row`, drags past the threshold and releases over `target`. */
function dragOnto(row: HTMLElement, target: HTMLElement) {
  Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => target });
  pointer(row, "pointerdown", 10, 10);
  pointer(window, "pointermove", 40, 60);
  pointer(window, "pointermove", 80, 400);
  pointer(window, "pointerup", 80, 400);
}

describe("Provider Dock on Stable", () => {
  it("shows every active account in provider order with health and usage", async () => {
    await mountStable();
    const buttons = await waitFor(async () => {
      const found = (await dock()).getAllByRole("button");
      expect(found).toHaveLength(6);
      return found;
    });
    expect(buttons.map((button) => button.getAttribute("aria-label"))).toEqual([
      "Claude Code · Personal: Healthy, No threads",
      "Codex · Personal: Healthy, Idle · 1 thread",
      "Codex · B: Not checked, No threads",
      "Codex · Work: Signed out, No threads",
      "Gemini CLI · Personal: Not checked, Idle · 1 thread",
      "Gemini CLI · Gemini B: Not checked, No threads",
    ]);
    expect(buttons[3]).toHaveAttribute("data-health", "signed_out");
    expect(buttons[0]).toHaveTextContent("Claude Personal");
    expect(buttons[5]).toHaveTextContent("Gemini B");
  });

  it("moves the open thread onto a chip's account in two clicks, without a dialog", async () => {
    const { user, calls } = await mountStable();
    await openThread(user, "Gemini docs pass");
    expect(await chip("Gemini CLI · Personal")).toHaveAttribute("data-current", "true");
    await user.click(await chip("Gemini CLI · Gemini B"));
    const menu = await screen.findByRole("menu");
    await user.click(within(menu).getByRole("menuitem", { name: /Move “Gemini docs pass” here/ }));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    await waitFor(() => expect(calls("thread_rebind_account")).toBe(1));
    expect(await screen.findByText("Moved “Gemini docs pass” to Gemini B (Gemini CLI)")).toBeInTheDocument();
    await waitFor(async () => expect(await chip("Gemini CLI · Gemini B")).toHaveAttribute("data-current", "true"));
  });

  it("says why a chip can't take the open thread and offers nothing to click", async () => {
    const { user, calls } = await mountStable();
    await openThread(user, "Gemini docs pass");
    await user.click(await chip("Codex · Personal"));
    let menu = await screen.findByRole("menu");
    const move = within(menu).getByRole("menuitem", { name: /Move “Gemini docs pass” here/ });
    expect(move).toHaveAttribute("aria-disabled", "true");
    expect(move).toHaveTextContent("Not a Gemini CLI account");
    await user.keyboard("{Escape}");
    await user.click(await chip("Gemini CLI · Personal"));
    menu = await screen.findByRole("menu");
    expect(within(menu).getByText("“Gemini docs pass” uses this account.")).toBeInTheDocument();
    expect(calls("thread_rebind_account")).toBe(0);
  });

  it("asks before a dropped thread moves, and refuses a drop on an account that can't take it", async () => {
    const { user, calls } = await mountStable();
    await openThread(user, "Gemini docs pass");
    const list = screen.getByRole("list", { name: "Threads" });

    dragOnto(within(list).getByRole("button", { name: /Codex cleanup/ }), await chip("Codex · Work"));
    expect(await screen.findByText("Codex Work can't take “Codex cleanup”")).toBeInTheDocument();
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();

    dragOnto(within(list).getByRole("button", { name: /Codex cleanup/ }), await chip("Codex · B"));
    const dialog = await screen.findByRole("alertdialog", { name: "Rebind thread?" });
    expect(calls("thread_rebind_account")).toBe(0);
    await user.click(within(dialog).getByRole("button", { name: "Switch to B" }));
    await waitFor(() => expect(calls("thread_rebind_account")).toBe(1));
    await waitFor(async () => expect(await chip("Codex · B")).toHaveAccessibleName(/Idle · 1 thread/));
    // The drag didn't open the row it started on: the Gemini thread is still the open one.
    expect(screen.getByRole("heading", { name: "Gemini docs pass", level: 2 })).toBeInTheDocument();
  }, 20_000);

  it("outlines compatible accounts when the open thread's account is unavailable, without switching", async () => {
    const { user, calls } = await mountStable({ codexPersonalFailing: true });
    await openThread(user, "Codex cleanup");
    expect(await (await dock()).findByRole("status")).toHaveTextContent(
      "Codex Personal needs attention · Codex B can take it",
    );
    expect(await chip("Codex · B")).toHaveAttribute("data-suggested", "true");
    expect(await chip("Codex · Work")).not.toHaveAttribute("data-suggested");
    expect(calls("thread_rebind_account")).toBe(0);
  });
});
