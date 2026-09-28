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
import nativeStableSurfaces from "../../shell/fixtures/stable-native-surfaces.json";
import { Shell } from "../../shell/Shell.tsx";
import { getRebindRequest, getSelectedThread, requestRebind, resetAccountIntentForTests } from "./accountIntent.ts";
import { describeRebindError } from "./useThreadAccount.ts";

// Switch accounts on the Stable Threads surface (lane 2). Stable flags follow
// shell/Shell.stable.test.tsx: ProviderProfiles / AccountSignIn stay Gated there, and nothing here
// may depend on them.
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
});

interface Mounted {
  client: KalCodeClient;
  user: ReturnType<typeof userEvent.setup>;
  calls: (command: CommandName) => number;
  gemini: ThreadSummary;
  geminiB: ProviderAccount;
  codex: ThreadSummary;
  /** Makes the next rebind fail with this native error. */
  failRebind: (code: string, message?: string) => void;
}

async function settledThread(
  client: KalCodeClient,
  providerId: string,
  providerAccountId: string,
  name: string,
): Promise<ThreadSummary> {
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

async function mountStable(): Promise<Mounted> {
  const transport = createMemoryTransport("threads", { detectDelayMs: 0 });
  const original = transport.invoke.bind(transport);
  const counts = new Map<string, number>();
  let failure: { code: string; message: string } | null = null;
  vi.spyOn(transport, "invoke").mockImplementation(async (command, args) => {
    counts.set(command, (counts.get(command) ?? 0) + 1);
    if (command === "thread_rebind_account" && failure) {
      const { code, message } = failure;
      failure = null;
      throw { category: "validation", code, message, retryable: false };
    }
    const result = await original(command, args);
    // The provider reported an identity for Gemini B only (identity is optional metadata).
    if (command === "provider_accounts_list") {
      return (result as ProviderAccount[]).map((account) =>
        account.displayName === "Gemini B" ? { ...account, providerReportedIdentity: "b@example.com" } : account,
      ) as never;
    }
    return result as never;
  });
  const client = new KalCodeClient(transport);
  const boot = await client.boot();
  boot.info.channel = "stable";
  boot.info.flags.surfaces = (nativeStableSurfaces as SurfaceFlag[]).map((flag) => ({ ...flag }));
  boot.info.flags.features = boot.info.flags.features.map((flag) => ({
    ...flag,
    visible: flag.state === "available",
  }));
  await client.detectProviders();
  const geminiB = await client.createProviderAccount("gemini-cli", "Gemini B");
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
  const user = userEvent.setup();
  return {
    client,
    user,
    calls: (command) => counts.get(command) ?? 0,
    gemini,
    geminiB,
    codex,
    failRebind: (code, message = "Refused.") => {
      failure = { code, message };
    },
  };
}

async function openThreads(user: Mounted["user"]) {
  const primary = within(screen.getByRole("navigation", { name: "Primary" }));
  await user.click(primary.getByRole("button", { name: "Threads" }));
  await screen.findByRole("heading", { name: "Threads", level: 1 });
}

async function openThread(user: Mounted["user"], name: string) {
  const list = await screen.findByRole("list", { name: "Threads" });
  await user.click(await within(list).findByRole("button", { name: new RegExp(name) }));
  await screen.findByRole("heading", { name, level: 2 });
}

const accountButton = (label: string) => screen.findByRole("button", { name: new RegExp(`^${label}, `) });

async function openMenu(user: Mounted["user"], label: string) {
  await user.click(await accountButton(label));
  return screen.findByRole("menu", { name: "Switch account" });
}

describe("thread account switch on Stable", () => {
  it("shows the thread's provider and account as text in the header and in the list", async () => {
    const { user } = await mountStable();
    await openThreads(user);
    await openThread(user, "Gemini docs pass");
    const header = screen.getByRole("article");
    expect(within(header).getByText("Provider").nextElementSibling).toHaveTextContent("Gemini CLI · Personal");
    expect(await accountButton("Personal")).toHaveTextContent("Personal");
    const list = screen.getByRole("list", { name: "Threads" });
    expect(within(list).getByRole("button", { name: /Gemini docs pass/ })).toHaveTextContent(
      "Gemini CLI · Personal · kalcode",
    );
    expect(getSelectedThread()).toEqual({
      threadId: expect.any(String),
      providerId: "gemini-cli",
      providerAccountId: GEMINI_PERSONAL,
    });
  });

  it("lists the provider's accounts with Active, identity, status and account links", async () => {
    const { user } = await mountStable();
    await openThreads(user);
    await openThread(user, "Gemini docs pass");
    const menu = await openMenu(user, "Personal");
    expect(within(menu).getByText("Switch account")).toBeInTheDocument();
    const radios = within(menu).getAllByRole("menuitemradio");
    expect(radios.map((item) => item.textContent)).toEqual([
      "PersonalActiveNot checked",
      "Gemini Bb@example.com · Not checked",
    ]);
    expect(radios[0]).toHaveAttribute("aria-checked", "true");
    expect(radios[1]).toHaveAttribute("aria-checked", "false");
    expect(within(menu).getByRole("menuitem", { name: "Connect another Gemini CLI account" })).toBeInTheDocument();
    expect(within(menu).getByRole("menuitem", { name: "Manage provider accounts" })).toBeInTheDocument();
  });

  it("Connect another opens Providers → Accounts with that provider's connect form; Manage opens it without", async () => {
    const { user, calls } = await mountStable();
    await openThreads(user);
    await openThread(user, "Gemini docs pass");
    let menu = await openMenu(user, "Personal");
    await user.click(within(menu).getByRole("menuitem", { name: "Connect another Gemini CLI account" }));
    const name = await screen.findByRole("textbox", { name: "Name for the new Gemini CLI account" });
    expect(screen.getByRole("tab", { name: "Accounts" })).toHaveAttribute("aria-selected", "true");
    expect(screen.queryByRole("textbox", { name: "Name for the new Codex account" })).toBeNull();
    expect(name).toBeInTheDocument();
    // Opening the form creates or signs in nothing.
    expect(calls("provider_account_create")).toBe(0);

    await openThreads(user);
    await openThread(user, "Codex cleanup");
    menu = await openMenu(user, "Personal");
    await user.click(within(menu).getByRole("menuitem", { name: "Manage provider accounts" }));
    await waitFor(() => expect(screen.getByRole("tab", { name: "Accounts" })).toHaveAttribute("aria-selected", "true"));
    expect(screen.queryByRole("textbox", { name: "Name for the new Codex account" })).toBeNull();
  });

  it("disables signed-out accounts with the reason as text", async () => {
    const { user } = await mountStable();
    await openThreads(user);
    await openThread(user, "Codex cleanup");
    const menu = await openMenu(user, "Personal");
    const work = within(menu).getByRole("menuitemradio", { name: /Work/ });
    expect(work).toHaveAttribute("aria-disabled", "true");
    expect(work).toHaveTextContent("Signed out · sign in from Providers to use it");
    expect(within(menu).getByRole("menuitemradio", { name: /Personal/ })).toHaveTextContent("Active");
  });

  it("choosing another account opens the Rebind dialog with the exact copy and focus on Cancel", async () => {
    const { user, calls } = await mountStable();
    await openThreads(user);
    await openThread(user, "Gemini docs pass");
    const menu = await openMenu(user, "Personal");
    await user.click(within(menu).getByRole("menuitemradio", { name: /Gemini B/ }));
    const dialog = await screen.findByRole("alertdialog", { name: "Rebind thread?" });
    expect(within(dialog).getByText("This thread currently belongs to Personal.")).toBeInTheDocument();
    expect(within(dialog).getByText("Switch future messages to Gemini B?")).toBeInTheDocument();
    expect(
      within(dialog).getByText(
        "Past conversation history remains unchanged. Only future provider requests use Gemini B.",
      ),
    ).toBeInTheDocument();
    const cancel = within(dialog).getByRole("button", { name: "Cancel" });
    expect(within(dialog).getByRole("button", { name: "Switch to Gemini B" })).toBeEnabled();
    await waitFor(() => expect(cancel).toHaveFocus());

    await user.click(cancel);
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(calls("thread_rebind_account")).toBe(0);
    expect(await accountButton("Personal")).toBeInTheDocument();
  });

  it("confirm rebinds exactly once and the header and list follow", async () => {
    const { user, calls } = await mountStable();
    await openThreads(user);
    await openThread(user, "Gemini docs pass");
    await user.click(within(await openMenu(user, "Personal")).getByRole("menuitemradio", { name: /Gemini B/ }));
    const dialog = await screen.findByRole("alertdialog", { name: "Rebind thread?" });
    const confirm = within(dialog).getByRole("button", { name: "Switch to Gemini B" });
    await user.dblClick(confirm);
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(calls("thread_rebind_account")).toBe(1);
    expect(await accountButton("Gemini B")).toBeInTheDocument();
    expect(await screen.findByText("Switched to Gemini B")).toBeInTheDocument();
    const list = screen.getByRole("list", { name: "Threads" });
    await waitFor(() =>
      expect(within(list).getByRole("button", { name: /Gemini docs pass/ })).toHaveTextContent(
        "Gemini CLI · Gemini B · kalcode",
      ),
    );
    await waitFor(() => expect(getSelectedThread()?.providerAccountId).not.toBe(GEMINI_PERSONAL));
    const menu = await openMenu(user, "Gemini B");
    expect(within(menu).getByRole("menuitemradio", { name: /Gemini B/ })).toHaveAttribute("aria-checked", "true");
  });

  it("maps refusals to human copy and offers sign-in for a signed-out account", async () => {
    const { user, failRebind } = await mountStable();
    await openThreads(user);
    await openThread(user, "Gemini docs pass");

    failRebind("thread_rebind_busy");
    await user.click(within(await openMenu(user, "Personal")).getByRole("menuitemradio", { name: /Gemini B/ }));
    await user.click(await screen.findByRole("button", { name: "Switch to Gemini B" }));
    expect(
      await screen.findByText(
        "This thread is still working. Finish or stop the current turn first, then switch to Gemini B.",
      ),
    ).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());

    failRebind("provider_account_not_authenticated");
    await user.click(within(await openMenu(user, "Personal")).getByRole("menuitemradio", { name: /Gemini B/ }));
    await user.click(await screen.findByRole("button", { name: "Switch to Gemini B" }));
    const dialog = await screen.findByRole("alertdialog", { name: "Rebind thread?" });
    expect(await within(dialog).findByRole("button", { name: "Sign in to Gemini B" })).toBeInTheDocument();
    expect(within(dialog).getByRole("alert")).toHaveTextContent("Gemini B isn't signed in.");
    await user.click(within(dialog).getByRole("button", { name: "Sign in to Gemini B" }));
    expect(await screen.findByRole("heading", { name: "Providers", level: 1 })).toBeInTheDocument();
    expect(await screen.findByRole("tab", { name: "Accounts", selected: true })).toBeInTheDocument();
  });

  it("describes every Phase 0 refusal code in plain words", () => {
    const context = { target: "Gemini B", providerName: "Gemini CLI", thread: null };
    const describe = (code: string) =>
      describeRebindError({ category: "validation", code, message: "native copy", retryable: false }, context);
    expect(describe("thread_rebind_busy").description).toMatch(/Finish or stop the current turn first/);
    expect(describe("thread_rebind_pending_approval").description).toMatch(/waiting for your approval/);
    expect(describe("provider_account_not_authenticated")).toMatchObject({ signIn: true });
    expect(describe("provider_account_mismatch").description).toBe(
      "Gemini B belongs to a different provider. Choose a Gemini CLI account for this thread.",
    );
    expect(describe("thread_archived").description).toMatch(/Archived threads/);
    // The native rebind codes (SA lane 1) get the same plain copy as the memory contract's.
    for (const code of ["provider_account_unknown", "provider_account_archived", "provider_account_not_found"]) {
      expect(describe(code).description).toBe("Gemini B isn't connected any more. Choose another Gemini CLI account.");
    }
    expect(describe("provider_account_plan_unsupported").description).toBe(
      "Gemini B uses an organization plan KalCode can't run yet. Choose another Gemini CLI account.",
    );
    expect(describe("something_new").description).toBe("native copy");
    const waiting = describeRebindError(
      { category: "validation", code: "thread_rebind_busy", message: "", retryable: false },
      { ...context, thread: { status: "waiting_for_permission", pendingApprovals: 1 } as ThreadSummary },
    );
    expect(waiting.description).toMatch(/waiting for your approval/);
  });

  it("a busy thread can't be confirmed", async () => {
    const { client, user } = await mountStable();
    await client.createProviderAccount("claude-code", "Claude Work");
    await openThreads(user);
    // The fixture's running thread (legacy, no stored account id).
    await openThread(user, "Fix OAuth Callback Race");
    await user.click(within(await openMenu(user, "Personal")).getByRole("menuitemradio", { name: /Claude Work/ }));
    const dialog = await screen.findByRole("alertdialog", { name: "Rebind thread?" });
    expect(within(dialog).getByRole("status")).toHaveTextContent("Finish or stop the current turn first");
    expect(within(dialog).getByRole("button", { name: "Switch to Claude Work" })).toBeDisabled();
  });

  it("opens the same dialog for a palette or KalVoice request and marks it handled", async () => {
    const { user, gemini, geminiB, calls } = await mountStable();
    await openThreads(user);
    await openThread(user, "Codex cleanup");
    act(() => {
      requestRebind(gemini.id, geminiB.id);
    });
    const dialog = await screen.findByRole("alertdialog", { name: "Rebind thread?" });
    expect(within(dialog).getByText("This thread currently belongs to Personal.")).toBeInTheDocument();
    expect(within(dialog).getByText("Switch future messages to Gemini B?")).toBeInTheDocument();
    expect(getRebindRequest()).toBeNull();
    await user.click(within(dialog).getByRole("button", { name: "Switch to Gemini B" }));
    await waitFor(() => expect(calls("thread_rebind_account")).toBe(1));
    expect(await screen.findByRole("heading", { name: "Gemini docs pass", level: 2 })).toBeInTheDocument();
    expect(await accountButton("Gemini B")).toBeInTheDocument();
  });

  it("follows thread.account_changed from a rebind made elsewhere", async () => {
    const { client, user, gemini, geminiB } = await mountStable();
    await openThreads(user);
    await openThread(user, "Gemini docs pass");
    expect(await accountButton("Personal")).toBeInTheDocument();
    await act(async () => {
      await client.rebindThreadAccount(gemini.id, geminiB.id);
    });
    expect(await accountButton("Gemini B")).toBeInTheDocument();
  });
});
