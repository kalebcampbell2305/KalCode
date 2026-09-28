import type { SurfaceFlag, ThreadStatus, ThreadSummary, Workspace } from "@kalcode/protocol";
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
import nativeStableSurfaces from "../../shell/fixtures/stable-native-surfaces.json";
import { Shell } from "../../shell/Shell.tsx";
import { openProviderAccounts } from "./providersTab.ts";

// Providers → Accounts on the Stable channel: every account shows its thread use, the workspaces
// that remember it, Set default, Manage, sign in/out, and each provider can connect another
// account through the same add-then-official-sign-in flow. ProviderProfiles and AccountSignIn are
// Available on Stable (flags.rs); the view ships unconditionally and reads neither flag.
vi.mock("@xterm/xterm", () => ({ Terminal: class {} }));

const IDS = {
  claudePersonal: "0192f3c4-0000-7000-8000-000000000101",
  codexPersonal: "0192f3c4-0000-7000-8000-000000000201",
  codexWork: "0192f3c4-0000-7000-8000-000000000202",
  geminiPersonal: "0192f3c4-0000-7000-8000-000000000301",
} as const;

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

/** Thread states pinned by name, so counts don't race the scripted fake provider session. */
const PINNED: Record<string, { status: ThreadStatus; archived?: boolean }> = {
  "Codex running": { status: "running_tool" },
  "Codex ready": { status: "idle" },
  "Codex archived": { status: "idle", archived: true },
  "Claude waiting": { status: "waiting_for_permission" },
};

async function mountStable({ openAccounts = true }: { openAccounts?: boolean } = {}) {
  const transport = createMemoryTransport("account-ready", { detectDelayMs: 0 });
  const calls: CommandName[] = [];
  const invoke = transport.invoke.bind(transport);
  transport.invoke = (async <T,>(command: CommandName, args?: Record<string, unknown>): Promise<T> => {
    calls.push(command);
    const result = await invoke<T>(command, args);
    if (command !== "thread_list") return result;
    return (result as ThreadSummary[]).map((thread) => {
      const pin = PINNED[thread.name];
      return pin
        ? { ...thread, status: pin.status, archivedAt: pin.archived ? "2026-09-28T10:00:00.000Z" : null }
        : thread;
    }) as T;
  }) as typeof transport.invoke;
  const client = new KalCodeClient(transport);
  const boot = await client.boot();
  boot.info.channel = "stable";
  boot.info.flags.surfaces = (nativeStableSurfaces as SurfaceFlag[]).map((flag) => ({ ...flag }));
  boot.info.flags.features = boot.info.flags.features.map((flag) => ({
    ...flag,
    visible: flag.state === "available",
  }));
  expect(boot.info.flags.features.find((f) => f.id === "provider_profiles")?.visible).toBe(true);
  expect(boot.info.flags.features.find((f) => f.id === "account_sign_in")?.visible).toBe(true);
  expect(boot.info.flags.features.find((f) => f.id === "provider_panes")?.visible).toBe(false);

  transport.workspaces.queueFolders("beta", "alpha");
  const beta = (await client.openWorkspaceDialog()) as Workspace;
  const alpha = (await client.openWorkspaceDialog()) as Workspace;
  const create = (providerId: string, providerAccountId: string, workspaceId: string, name: string) =>
    client.createThread({
      providerId,
      providerAccountId,
      workspaceId,
      model: null,
      permissionMode: "approve",
      prompt: "summarize the README",
      name,
    });
  await create("codex", IDS.codexPersonal, alpha.id, "Codex running");
  await create("codex", IDS.codexPersonal, alpha.id, "Codex ready");
  await create("codex", IDS.codexPersonal, beta.id, "Codex archived");
  await create("claude-code", IDS.claudePersonal, beta.id, "Claude waiting");
  await client.bindProviderAccount("codex", "workspace", alpha.id, IDS.codexPersonal);
  await client.bindProviderAccount("gemini-cli", "workspace", beta.id, IDS.geminiPersonal);
  await client.bindProviderAccount("gemini-cli", "workspace", alpha.id, IDS.geminiPersonal);
  calls.length = 0;

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
  if (!openAccounts) return { user, calls, client };
  const primary = within(screen.getByRole("navigation", { name: "Primary" }));
  await user.click(primary.getByRole("button", { name: "Providers" }));
  await screen.findByRole("heading", { level: 1, name: "Providers" });
  await user.click(screen.getByRole("tab", { name: "Accounts" }));
  await screen.findByRole("region", { name: "Codex account Personal" });
  return { user, calls, client };
}

const card = (name: string) => screen.getByRole("region", { name });

/** The value of one labelled usage row ("Active threads", "Workspace default in") on a card. */
function usage(region: HTMLElement, term: string): string {
  const dt = within(region).getByText(term, { selector: "dt" });
  return dt.nextElementSibling?.textContent ?? "";
}

describe("Providers → Accounts (Stable)", () => {
  it("shows each account's open threads, running ones, and the workspaces that remember it", async () => {
    await mountStable();
    const codexPersonal = card("Codex account Personal");
    await waitFor(() => expect(usage(codexPersonal, "Active threads")).toBe("2 · 1 running"));
    expect(usage(codexPersonal, "Workspace default in")).toBe("alpha");
    expect(within(codexPersonal).getByText("Default", { exact: true })).toBeInTheDocument();
    expect(within(codexPersonal).getByText("Signed in", { exact: true })).toBeInTheDocument();

    const claude = card("Claude Code account Personal");
    expect(usage(claude, "Active threads")).toBe("1");
    expect(usage(claude, "Workspace default in")).toBe("None");

    const codexWork = card("Codex account Work");
    expect(usage(codexWork, "Active threads")).toBe("None");
    expect(within(codexWork).getByText("Signed out", { exact: true })).toBeInTheDocument();

    const gemini = card("Gemini CLI account Personal");
    expect(usage(gemini, "Workspace default in")).toBe("alpha, beta");
    expect(usage(gemini, "Active threads")).toBe("None");
  });

  it("sets a default with the existing command and keeps Manage actions together", async () => {
    const { user, calls } = await mountStable();
    const work = card("Codex account Work");
    expect(within(work).queryByText("Default", { exact: true })).toBeNull();
    await user.click(within(work).getByRole("button", { name: "Set Work as default" }));
    await waitFor(() => expect(within(work).getByText("Default", { exact: true })).toBeInTheDocument());
    expect(calls).toContain("provider_account_set_default");
    const personal = card("Codex account Personal");
    expect(within(personal).queryByText("Default", { exact: true })).toBeNull();
    expect(within(personal).getByRole("button", { name: "Set Personal as default" })).toBeInTheDocument();

    // Rename and Remove live under Manage; Sign in/out stays on the card.
    expect(within(work).queryByRole("button", { name: "Rename Work" })).toBeNull();
    const manage = within(work).getByRole("button", { name: "Manage Work" });
    expect(manage).toHaveAttribute("aria-expanded", "false");
    await user.click(manage);
    expect(manage).toHaveAttribute("aria-expanded", "true");
    expect(within(work).getByRole("button", { name: "Rename Work" })).toBeInTheDocument();
    expect(within(work).getByRole("button", { name: "Remove Work from KalCode" })).toBeInTheDocument();
    expect(within(work).getByRole("button", { name: "Sign in Work" })).toBeInTheDocument();
    expect(within(personal).getByRole("button", { name: "Sign out Personal" })).toBeInTheDocument();
  });

  it.each([
    ["Claude Code", "claude-code", "provider_claude_login_start"],
    ["Codex", "codex", "provider_codex_login_start"],
    ["Gemini CLI", "gemini-cli", "provider_gemini_login_start"],
  ] as const)("connects another %s account with the provider's own sign-in", async (name, _id, loginStart) => {
    const { user, calls } = await mountStable();
    const panel = screen.getByRole("region", { name: new RegExp(`^${name}\\s*\\d+$`) });
    await user.click(within(panel).getByRole("button", { name: `Connect another ${name} account` }));
    await user.type(within(panel).getByRole("textbox", { name: `Name for the new ${name} account` }), "Side");
    await user.click(within(panel).getByRole("button", { name: "Add and sign in" }));

    const added = await screen.findByRole("region", { name: `${name} account Side` });
    await waitFor(() => expect(within(added).getByText("Signed in", { exact: true })).toBeInTheDocument());
    expect(calls).toContain("provider_account_create");
    expect(calls).toContain(loginStart);
    expect(calls.indexOf("provider_account_create")).toBeLessThan(calls.indexOf(loginStart));
    // Connecting never touches a workspace, a thread or a provider pane.
    expect(calls.filter((c) => c.startsWith("provider_pane_") || c === "provider_account_bind")).toEqual([]);
    expect(usage(added, "Active threads")).toBe("None");
  });

  it("openProviderAccounts opens Accounts at that provider with its connect form, and creates nothing", async () => {
    const { user, calls } = await mountStable({ openAccounts: false });
    await screen.findByRole("heading", { level: 1, name: "Dashboard" });
    act(() => openProviderAccounts({ providerId: "gemini-cli", connect: true }));
    const primary = within(screen.getByRole("navigation", { name: "Primary" }));
    await user.click(primary.getByRole("button", { name: "Providers" }));

    const name = await screen.findByRole("textbox", { name: "Name for the new Gemini CLI account" });
    expect(screen.getByRole("tab", { name: "Accounts" })).toHaveAttribute("aria-selected", "true");
    const gemini = screen.getByRole("region", { name: /^Gemini CLI\s*\d+$/ });
    expect(gemini).toContainElement(name);
    expect(name).toHaveFocus();
    // Only one provider's form opens, and nothing is added or signed in until the person acts.
    expect(screen.queryByRole("textbox", { name: "Name for the new Codex account" })).toBeNull();
    expect(calls.filter((c) => c === "provider_account_create" || c.endsWith("_login_start"))).toEqual([]);

    // Followed while Accounts is already open, too.
    act(() => openProviderAccounts({ providerId: "codex", connect: true }));
    expect(await screen.findByRole("textbox", { name: "Name for the new Codex account" })).toBeInTheDocument();
    // Without `connect`, the section is shown but no form opens.
    act(() => openProviderAccounts({ providerId: "claude-code" }));
    await waitFor(() =>
      expect(screen.queryByRole("textbox", { name: "Name for the new Claude Code account" })).toBeNull(),
    );
    expect(calls.filter((c) => c === "provider_account_create" || c.endsWith("_login_start"))).toEqual([]);
  });
});
