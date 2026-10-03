import type { ProviderAccount, ProviderHealth, ThreadSummary } from "@kalcode/protocol";
import { ToastProvider, TooltipProvider } from "@kalcode/ui/components";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KalCodeClient } from "../../ipc/client.ts";
import { createMemoryTransport } from "../../ipc/memoryTransport.ts";
import type { CommandName } from "../../ipc/transport.ts";
import { ProviderAccountsView } from "./ProviderAccountsView.tsx";
import { accountUsage } from "./useProviderAccounts.ts";

// The account row must sign a Gemini account in through the native, account-scoped command on
// every build channel. Stable ships without provider panes, so nothing here may depend on one.
const runtime = vi.hoisted(() => ({ client: null as unknown as KalCodeClient }));
vi.mock("../../runtime/RuntimeProvider.tsx", () => ({ useRuntime: () => runtime }));

let calls: CommandName[] = [];

/** Uses the memory transport, recording every command; `accounts` / `threads` replace those lists. */
function useTransport({
  accounts,
  threads,
  fail,
}: {
  accounts?: ProviderAccount[];
  threads?: ThreadSummary[];
  fail?: CommandName;
} = {}) {
  const transport = createMemoryTransport("default", { detectDelayMs: 0 });
  const invoke = transport.invoke.bind(transport);
  transport.invoke = (<T,>(command: CommandName, args?: Record<string, unknown>): Promise<T> => {
    calls.push(command);
    if (command === fail) {
      return Promise.reject({ category: "internal", code: "boom", message: "Threads unavailable", retryable: true });
    }
    if (accounts && command === "provider_accounts_list") return Promise.resolve(accounts as T);
    if (threads && command === "thread_list") return Promise.resolve(threads as T);
    // Account edits on the fixture list answer like the backend: the updated account.
    const edit: Partial<Record<CommandName, Partial<ProviderAccount>>> = {
      provider_account_set_default: { isDefault: true },
      provider_account_rename: { displayName: String(args?.displayName) },
      provider_account_archive: { archivedAt: "2026-10-01T12:00:00.000Z" },
    };
    const change = accounts ? edit[command] : undefined;
    if (accounts && change) {
      const account = accounts.find((candidate) => candidate.id === args?.accountId);
      return Promise.resolve({ ...account, ...change } as T);
    }
    return invoke<T>(command, args);
  }) as typeof transport.invoke;
  runtime.client = new KalCodeClient(transport);
}

beforeEach(() => {
  calls = [];
  useTransport();
  // Radix menus measure their trigger.
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
  vi.useRealTimers();
});

function mount(health: ProviderHealth[] | null = null) {
  return render(
    <ToastProvider>
      <TooltipProvider>
        <ProviderAccountsView enabled statuses={null} health={health} />
      </TooltipProvider>
    </ToastProvider>,
  );
}

function account(id: string, providerId: string, displayName: string, extra: Partial<ProviderAccount> = {}) {
  return {
    id,
    providerId,
    displayName,
    providerReportedIdentity: null,
    authenticationState: "unknown",
    isDefault: false,
    createdAt: "2026-09-01T10:00:00.000Z",
    lastUsedAt: null,
    lastCheckedAt: null,
    lastErrorCode: null,
    archivedAt: null,
    ...extra,
  } as ProviderAccount;
}

async function openMenu(user: ReturnType<typeof userEvent.setup>, row: HTMLElement, name: string) {
  await user.click(within(row).getByRole("button", { name: `More actions for ${name}` }));
  return screen.findByRole("menu");
}

describe("Gemini account row", () => {
  it("signs in and out with Gemini's own sign-in, never a provider pane", async () => {
    const user = userEvent.setup();
    mount();
    const row = await screen.findByRole("region", { name: "Gemini CLI · Personal" });
    expect(within(row).queryByRole("button", { name: /auth pane/i })).toBeNull();
    expect(within(row).getByText("Not checked", { exact: true })).toBeTruthy();

    await user.click(within(row).getByRole("button", { name: "Sign in Personal" }));
    await waitFor(() => expect(within(row).getByText("Signed in", { exact: true })).toBeTruthy());
    expect(calls).toContain("provider_gemini_login_start");
    expect(calls).toContain("provider_gemini_login_wait");

    let menu = await openMenu(user, row, "Personal");
    await user.click(within(menu).getByRole("menuitem", { name: "Sign out Personal" }));
    await waitFor(() => expect(within(row).getByText("Signed out", { exact: true })).toBeTruthy());
    expect(calls).toContain("provider_gemini_logout");

    await user.click(within(row).getByRole("button", { name: "Refresh Personal sign-in status" }));
    await waitFor(() => expect(calls).toContain("provider_gemini_account_refresh"));
    calls = [];
    menu = await openMenu(user, row, "Personal");
    await user.click(within(menu).getByRole("menuitem", { name: "Refresh Personal status" }));
    await waitFor(() => expect(calls).toContain("provider_gemini_account_refresh"));

    // Reading workspace names (for "Workspace default in") is fine; opening or switching one isn't.
    const paneOrWorkspace = calls.filter(
      (command) =>
        command.startsWith("provider_pane_") || (command.startsWith("workspace") && command !== "workspace_list"),
    );
    expect(paneOrWorkspace).toEqual([]);
    // Claude Code and Codex keep their own commands.
    expect(calls.some((command) => command.startsWith("provider_claude_"))).toBe(false);
    expect(calls.some((command) => command.startsWith("provider_codex_"))).toBe(false);
  }, 15_000);

  it("explains that Gemini sign-in stays with the provider and the account", async () => {
    mount();
    await screen.findByRole("region", { name: "Gemini CLI · Personal" });
    expect(screen.getByText(/Gemini CLI opens Google sign-in in your browser/)).toBeTruthy();
    expect(screen.queryByText(/\/auth/)).toBeNull();
  });
});

describe("account rows", () => {
  it("marks the default quietly and states identity, plan and usage truthfully", async () => {
    useTransport({
      accounts: [
        account("a", "codex", "Personal", {
          isDefault: true,
          authenticationState: "authenticated",
          providerReportedIdentity: "me@example.com",
          lastCheckedAt: "2026-10-01T09:00:00.000Z",
        }),
        account("b", "codex", "Work"),
      ],
    });
    const user = userEvent.setup();
    mount();
    const personal = await screen.findByRole("region", { name: "Codex · Personal" });
    const work = screen.getByRole("region", { name: "Codex · Work" });

    expect(within(personal).getByText("Default", { exact: true })).toBeInTheDocument();
    expect(within(work).queryByText("Default", { exact: true })).toBeNull();
    expect(within(personal).getByText("me@example.com")).toBeInTheDocument();
    expect(within(work).getByText("Identity not reported")).toBeInTheDocument();
    // KalCode reads no provider usage: checked accounts say it's unavailable, unchecked ones say so.
    expect(within(personal).getByText("Usage unavailable")).toBeInTheDocument();
    expect(within(work).getByText("Usage not checked")).toBeInTheDocument();
    expect(screen.queryByRole("progressbar")).toBeNull();
    expect(screen.queryByRole("meter")).toBeNull();
    // The plan isn't reported either; details say so and never guess one.
    await user.click(within(work).getByRole("button", { name: "Account details for Work" }));
    const plan = within(work).getByText("Plan", { selector: "dt" });
    expect(plan.nextElementSibling).toHaveTextContent("Not reported");
  });

  it("menu actions call the account's own commands", async () => {
    useTransport({ accounts: [account("a", "codex", "Personal", { isDefault: true }), account("b", "codex", "Work")] });
    const user = userEvent.setup();
    mount();
    const work = await screen.findByRole("region", { name: "Codex · Work" });

    let menu = await openMenu(user, work, "Work");
    expect(within(menu).queryByRole("menuitem", { name: "Sign out Work" })).toBeNull();
    await user.click(within(menu).getByRole("menuitem", { name: "Set Work as default" }));
    await waitFor(() => expect(calls).toContain("provider_account_set_default"));
    await waitFor(() => expect(within(work).getByText("Default", { exact: true })).toBeInTheDocument());
    menu = await openMenu(user, work, "Work");
    expect(within(menu).queryByRole("menuitem", { name: "Set Work as default" })).toBeNull();
    await user.keyboard("{Escape}");

    menu = await openMenu(user, work, "Work");
    await user.click(within(menu).getByRole("menuitem", { name: "Rename Work" }));
    const name = within(work).getByRole("textbox", { name: "Account name for Work" });
    expect(name).toHaveFocus();
    await user.clear(name);
    await user.type(name, "Work 2");
    await user.click(within(work).getByRole("button", { name: "Save account name" }));
    await waitFor(() => expect(calls).toContain("provider_account_rename"));

    const renamed = await screen.findByRole("region", { name: "Codex · Work 2" });
    menu = await openMenu(user, renamed, "Work 2");
    await user.click(within(menu).getByRole("menuitem", { name: "Remove Work 2 from KalCode" }));
    expect(within(renamed).getByText(/doesn't sign out of Codex or delete provider credentials/)).toBeInTheDocument();
    await user.click(within(renamed).getByRole("button", { name: "Confirm remove Work 2" }));
    await waitFor(() => expect(calls).toContain("provider_account_archive"));
    await waitFor(() => expect(screen.queryByRole("region", { name: "Codex · Work 2" })).toBeNull());
  }, 15_000);

  it("offers a filter only past six accounts, matching name or identity", async () => {
    const many = Array.from({ length: 7 }, (_, i) =>
      account(`c${i}`, i < 4 ? "claude-code" : "codex", `Claude ${i + 1}`, {
        providerReportedIdentity: i === 5 ? "team@example.com" : null,
      }),
    );
    useTransport({ accounts: many });
    const user = userEvent.setup();
    mount();
    await screen.findByRole("region", { name: "Claude Code · Claude 1" });
    expect(screen.getByText("7 accounts · 0 signed in")).toBeInTheDocument();
    const filter = screen.getByRole("searchbox", { name: "Filter accounts" });
    await user.type(filter, "team@");
    expect(screen.getAllByRole("region", { name: /·/ }).map((region) => region.getAttribute("aria-label"))).toEqual([
      "Codex · Claude 6",
    ]);
    await user.clear(filter);
    await user.type(filter, "nothing like it");
    expect(screen.getByText("No accounts match “nothing like it”.")).toBeInTheDocument();
  });

  it("has no filter with six or fewer accounts", async () => {
    mount();
    await screen.findByRole("region", { name: "Gemini CLI · Personal" });
    expect(screen.queryByRole("searchbox", { name: "Filter accounts" })).toBeNull();
  });

  it("shows a provider-wide limit on the section header only, never on an account", async () => {
    useTransport({
      accounts: [account("a", "codex", "Personal", { isDefault: true }), account("b", "codex", "Work")],
    });
    // Local midday, so "now + 15 min" never crosses midnight into the dated format.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 9, 3, 12, 0, 0));
    const backoffUntil = new Date(Date.now() + 15 * 60_000).toISOString();
    const codexHealth = {
      providerId: "codex",
      displayName: "Codex",
      capacity: "backing_off",
      reasonCode: "rate_limited",
      backoffUntil,
    } as ProviderHealth;
    mount([codexHealth]);
    const section = await screen.findByRole("region", { name: "Codex" });
    const limit = within(section).getByText(/^Rate limited · retry \d/);
    expect(limit.closest("header")).not.toBeNull();
    expect(limit.closest("p")).toHaveTextContent(/Provider-wide$/);
    for (const name of ["Codex · Personal", "Codex · Work"]) {
      expect(within(screen.getByRole("region", { name })).queryByText(/Rate limited|retry/)).toBeNull();
    }
    expect(within(screen.getByRole("region", { name: "Claude Code" })).queryByText(/Provider-wide/)).toBeNull();
  });

  it("adds an account from the toolbar, then runs that provider's own sign-in", async () => {
    const user = userEvent.setup();
    mount();
    await screen.findByRole("region", { name: "Gemini CLI · Personal" });
    await user.click(screen.getByRole("button", { name: "Add account" }));
    await user.selectOptions(screen.getByRole("combobox", { name: "Provider" }), "codex");
    await user.type(screen.getByRole("textbox", { name: "Name for the new Codex account" }), "Side");
    await user.click(screen.getByRole("button", { name: "Add and sign in" }));
    const added = await screen.findByRole("region", { name: "Codex · Side" });
    await waitFor(() => expect(within(added).getByText("Signed in", { exact: true })).toBeInTheDocument());
    expect(calls.indexOf("provider_account_create")).toBeLessThan(calls.indexOf("provider_codex_login_start"));
  });

  it("gives every provider the backend returns its own section", async () => {
    useTransport({ accounts: [account("x", "aider", "Lab")] });
    mount();
    const section = await screen.findByRole("region", { name: "aider" });
    expect(within(section).getByRole("region", { name: "aider · Lab" })).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "Codex" })).getByText("No Codex accounts yet.")).toBeTruthy();
  });
});

describe("account usage", () => {
  it("still shows accounts and sign-in when thread use can't load, and says so in text", async () => {
    useTransport({ fail: "thread_list" });
    const user = userEvent.setup();
    mount();
    const row = await screen.findByRole("region", { name: "Codex · Personal" });
    await waitFor(() => expect(within(row).getByText("Activity unavailable")).toBeInTheDocument());
    await user.click(within(row).getByRole("button", { name: "Account details for Personal" }));
    expect(within(row).getAllByText("Unavailable")).toHaveLength(3);
    expect(within(row).getByRole("button", { name: "More actions for Personal" })).toBeTruthy();
    expect(within(row).queryByText("None")).toBeNull();
  });

  it("calls coding agents agents and chat threads threads, never one count for both", async () => {
    const bound = (id: string, status: ThreadSummary["status"], agent: boolean) =>
      ({
        id,
        providerAccountId: "a",
        status,
        archivedAt: null,
        runtimeKind: agent ? "interactive_pty" : null,
        terminalId: null,
      }) as ThreadSummary;
    useTransport({
      accounts: [account("a", "codex", "Personal", { isDefault: true })],
      threads: [bound("1", "editing", true), bound("2", "idle", true), bound("3", "idle", false)],
    });
    const user = userEvent.setup();
    mount();
    const row = await screen.findByRole("region", { name: "Codex · Personal" });
    await waitFor(() => expect(within(row).getByText("2 agents · 1 thread · 1 running")).toBeInTheDocument());
    await user.click(within(row).getByRole("button", { name: "Account details for Personal" }));
    const fact = (term: string) => within(row).getByText(term, { selector: "dt" }).nextElementSibling;
    expect(fact("Active agents")).toHaveTextContent(/^2 · 1 running$/);
    expect(fact("Active threads")).toHaveTextContent(/^1$/);
  });

  it("counts non-archived agents and threads per account apart and lists only known workspaces", () => {
    const thread = (
      id: string,
      accountId: string | null,
      status: ThreadSummary["status"],
      archived = false,
      agent = false,
    ) =>
      ({
        id,
        providerAccountId: accountId,
        status,
        archivedAt: archived ? "2026-09-28T00:00:00Z" : null,
        runtimeKind: agent ? "interactive_pty" : null,
        terminalId: null,
      }) as ThreadSummary;
    const usage = accountUsage(
      [
        thread("1", "a", "running_tool"),
        thread("2", "a", "idle"),
        thread("3", "a", "thinking", true),
        thread("4", null, "running_tool"),
        thread("5", "b", "completed"),
        thread("6", "a", "editing", false, true),
        thread("7", "a", "idle", false, true),
        thread("8", "a", "idle", false, true),
      ],
      [
        { providerId: "codex", kind: "workspace", scopeId: "w2", accountId: "a" },
        { providerId: "gemini-cli", kind: "workspace", scopeId: "w1", accountId: "a" },
        { providerId: "codex", kind: "workspace", scopeId: "gone", accountId: "b" },
        { providerId: "codex", kind: "thread", scopeId: "w1", accountId: "b" },
      ],
      [
        { id: "w1", name: "beta" },
        { id: "w2", name: "alpha" },
      ],
    );
    expect(usage.get("a")).toEqual({
      agents: 3,
      agentsRunning: 1,
      threads: 2,
      threadsRunning: 1,
      workspaces: ["alpha", "beta"],
    });
    expect(usage.get("b")).toEqual({ agents: 0, agentsRunning: 0, threads: 1, threadsRunning: 0, workspaces: [] });
    expect(usage.get("c")).toBeUndefined();
  });
});
