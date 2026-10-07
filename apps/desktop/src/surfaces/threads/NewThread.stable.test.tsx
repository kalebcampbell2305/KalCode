import type { SurfaceFlag, Workspace } from "@kalcode/protocol";
import { ToastProvider, TooltipProvider } from "@kalcode/ui/components";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccountProvider } from "../../account/AccountProvider.tsx";
import { AccountClient } from "../../ipc/account.ts";
import { KalCodeClient } from "../../ipc/client.ts";
import { createMemoryTransport } from "../../ipc/memoryTransport.ts";
import type { CommandName } from "../../ipc/transport.ts";
import { DRAFT_STORAGE_KEY } from "../../runtime/drafts.ts";
import { RuntimeProvider } from "../../runtime/RuntimeProvider.tsx";
import nativeStableSurfaces from "../../shell/fixtures/stable-native-surfaces.json";
import { Shell } from "../../shell/Shell.tsx";
import { goTo } from "../../test/nav.ts";

// New thread on the Stable channel: the account picker follows the active workspace's remembered
// account, then the provider default, and "Remember these accounts for this workspace" is the
// only thing that writes a workspace binding. Nothing here may depend on a Gated feature flag.
vi.mock("@xterm/xterm", () => ({ Terminal: class {} }));

const CLAUDE_PERSONAL = "0192f3c4-0000-7000-8000-000000000101";

/** Replaces one command's answer (a failed create, a failed provider start). */
let intercept: ((command: CommandName, args: Record<string, unknown> | undefined) => Promise<unknown> | null) | null =
  null;

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
afterEach(() => {
  vi.unstubAllGlobals();
  intercept = null;
});

interface Harness {
  client: KalCodeClient;
  calls: { command: CommandName; args: Record<string, unknown> | undefined }[];
  alpha: Workspace;
  beta: Workspace;
  claudeWork: string;
  /** The transport's own answer, without recording or interception. */
  raw: <T>(command: CommandName, args?: Record<string, unknown>) => Promise<T>;
  user: ReturnType<typeof userEvent.setup>;
}

async function mountStable(prepare?: (h: Omit<Harness, "user" | "raw">) => Promise<void>): Promise<Harness> {
  const transport = createMemoryTransport("account-ready", { detectDelayMs: 0 });
  const calls: Harness["calls"] = [];
  const invoke = transport.invoke.bind(transport);
  transport.invoke = (<T,>(command: CommandName, args?: Record<string, unknown>): Promise<T> => {
    calls.push({ command, args });
    const replaced = intercept?.(command, args);
    if (replaced) return replaced as Promise<T>;
    return invoke<T>(command, args);
  }) as typeof transport.invoke;
  const client = new KalCodeClient(transport);
  const boot = await client.boot();
  boot.info.channel = "stable";
  boot.info.flags.surfaces = (nativeStableSurfaces as SurfaceFlag[]).map((flag) => ({ ...flag }));
  // Stable (flags.rs): ProviderProfiles and AccountSignIn are Available; the account UI shipped
  // before the flip and still reads neither flag.
  boot.info.flags.features = boot.info.flags.features.map((flag) => ({
    ...flag,
    visible: flag.state === "available",
  }));
  expect(boot.info.flags.features.find((f) => f.id === "provider_profiles")?.visible).toBe(true);
  expect(boot.info.flags.features.find((f) => f.id === "account_sign_in")?.visible).toBe(true);
  expect(boot.info.flags.features.find((f) => f.id === "provider_panes")?.visible).toBe(true);

  transport.workspaces.queueFolders("alpha", "beta");
  const alpha = (await client.openWorkspaceDialog()) as Workspace;
  const beta = (await client.openWorkspaceDialog()) as Workspace;
  const claudeWork = (await client.createProviderAccount("claude-code", "Work")).id;
  const base = { client, calls, alpha, beta, claudeWork };
  await prepare?.(base);
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
  return { ...base, raw: invoke, user: userEvent.setup() };
}

async function openNewThread(user: Harness["user"]) {
  await goTo(user, "Threads");
  await screen.findByRole("heading", { level: 1, name: "Threads" });
  await user.click(screen.getAllByRole("button", { name: "New thread" })[0] as HTMLElement);
  const form = await screen.findByRole("region", { name: "New thread" });
  await within(form).findByRole("combobox", { name: "Account" });
  return within(form);
}

const account = (form: ReturnType<typeof within>) => form.getByRole("combobox", { name: "Account" });
const workspace = (form: ReturnType<typeof within>) => form.getByRole("combobox", { name: "Workspace" });
const remember = (form: ReturnType<typeof within>) =>
  form.getByRole("checkbox", { name: "Remember these accounts for this workspace" });

function simulateClaudeHealthChange() {
  (
    window as unknown as {
      __kalcodeMemory: {
        simulate: (event: {
          type: "provider.health_changed";
          payload: { providerId: "claude-code"; from: "healthy"; to: "unavailable"; reason: string };
        }) => void;
      };
    }
  ).__kalcodeMemory.simulate({
    type: "provider.health_changed",
    payload: { providerId: "claude-code", from: "healthy", to: "unavailable", reason: "cli_disappeared" },
  });
}

describe("New thread account model identity (Stable)", () => {
  it("discovers the selected account's exact models and passes the provider-native id to launch", async () => {
    const h = await mountStable();
    intercept = (command, args) =>
      command === "provider_account_models"
        ? Promise.resolve({
            accountId: String(args?.accountId),
            providerId: "claude-code",
            source: "runtime",
            supportedEfforts: [],
            models:
              args?.accountId === h.claudeWork
                ? [
                    {
                      id: "claude-opus-4-1-20261001",
                      displayName: "Claude Opus 4.1",
                      isDefault: false,
                      defaultEffort: null,
                      supportedEfforts: [],
                    },
                  ]
                : [],
          })
        : null;

    const form = await openNewThread(h.user);
    await h.user.selectOptions(account(form), h.claudeWork);
    const model = form.getByRole("combobox", { name: "Model" });
    expect(
      await within(model).findByRole("option", { name: "Claude Opus 4.1 · claude-opus-4-1-20261001" }),
    ).toBeVisible();
    expect(
      h.calls.some((call) => call.command === "provider_account_models" && call.args?.accountId === h.claudeWork),
    ).toBe(true);

    await h.user.selectOptions(model, "claude-opus-4-1-20261001");
    await h.user.type(form.getByRole("textbox", { name: "Task" }), "summarize the README");
    await h.user.click(form.getByRole("button", { name: "Start thread" }));
    await waitFor(() => expect(h.calls.some((call) => call.command === "thread_review_create_prompt")).toBe(true));
    expect(h.calls.find((call) => call.command === "thread_review_create_prompt")?.args?.model).toBe(
      "claude-opus-4-1-20261001",
    );
  });

  it("preserves an explicit model through a transient failure, then blocks a fresh runtime incompatibility", async () => {
    const h = await mountStable();
    let discovery = 0;
    intercept = (command, args) => {
      if (command !== "provider_account_models") return null;
      discovery += 1;
      if (discovery === 2) return Promise.reject(new Error("Model service is temporarily offline"));
      return Promise.resolve({
        accountId: String(args?.accountId),
        providerId: "claude-code",
        source: "runtime",
        supportedEfforts: [],
        models:
          discovery === 1
            ? [
                {
                  id: "exact-model-v9",
                  displayName: "Exact Model Nine",
                  isDefault: false,
                  defaultEffort: null,
                  supportedEfforts: [],
                },
              ]
            : [
                {
                  id: "replacement-model-v10",
                  displayName: "Replacement Model Ten",
                  isDefault: true,
                  defaultEffort: null,
                  supportedEfforts: [],
                },
              ],
      });
    };

    const form = await openNewThread(h.user);
    const model = form.getByRole("combobox", { name: "Model" });
    await within(model).findByRole("option", { name: "Exact Model Nine · exact-model-v9" });
    await h.user.selectOptions(model, "exact-model-v9");
    await h.user.type(form.getByRole("textbox", { name: "Task" }), "Keep my exact choice");

    expect(await form.findByText(/Existing exact choices stay selected/i)).toBeVisible();
    expect(model).toHaveValue("exact-model-v9");
    expect(form.getByRole("button", { name: "Start thread" })).toBeEnabled();

    await h.user.click(form.getByRole("textbox", { name: "Task" }));
    await h.user.click(model);
    expect(await form.findByRole("alert")).toHaveTextContent(
      "This exact model is unavailable for Personal. Choose an available model or Provider default.",
    );
    expect(model).toHaveValue("exact-model-v9");
    expect(form.getByRole("button", { name: "Start thread" })).toBeDisabled();
  });

  it("does not treat a documented-alias catalog as proof that an explicit model is unavailable", async () => {
    const h = await mountStable();
    let discovery = 0;
    intercept = (command, args) => {
      if (command !== "provider_account_models") return null;
      discovery += 1;
      return Promise.resolve({
        accountId: String(args?.accountId),
        providerId: "claude-code",
        source: discovery === 1 ? "runtime" : "documented_aliases",
        supportedEfforts: [],
        models:
          discovery === 1
            ? [
                {
                  id: "account-only-model",
                  displayName: "Account Only Model",
                  isDefault: false,
                  defaultEffort: null,
                  supportedEfforts: [],
                },
              ]
            : [{ id: "opus", displayName: "Opus", isDefault: false, defaultEffort: null, supportedEfforts: [] }],
      });
    };

    const form = await openNewThread(h.user);
    const model = form.getByRole("combobox", { name: "Model" });
    await within(model).findByRole("option", { name: "Account Only Model · account-only-model" });
    await h.user.selectOptions(model, "account-only-model");
    await h.user.type(form.getByRole("textbox", { name: "Task" }), "Keep the account model");

    expect(await form.findByText(/Documented model aliases/i)).toBeVisible();
    expect(model).toHaveValue("account-only-model");
    expect(form.queryByText(/This exact model is unavailable/)).not.toBeInTheDocument();
    expect(form.getByRole("button", { name: "Start thread" })).toBeEnabled();
  });
});

describe("New thread account defaults (Stable)", () => {
  it("shows provider choices while supplementary availability diagnostics are still loading", async () => {
    const h = await mountStable();
    intercept = (command) => (command === "providers_list" ? new Promise(() => {}) : null);

    const form = await openNewThread(h.user);

    expect(form.getByRole("combobox", { name: "Provider" })).toHaveDisplayValue("Claude Code");
    await form.findByRole("combobox", { name: "Model" });
  });

  it("keeps an in-progress inline sign-in alive when thread options finish loading", async () => {
    const h = await mountStable(async ({ client, claudeWork }) => {
      await client.logoutClaudeAccount(claudeWork);
    });
    let finishOptions!: (value: unknown) => void;
    let finishLogin!: () => void;
    const pendingOptions = new Promise((resolve) => {
      finishOptions = resolve;
    });
    intercept = (command, args) => {
      if (command === "thread_options") return pendingOptions;
      if (command === "provider_claude_login_wait")
        return new Promise((resolve) => {
          finishLogin = () => {
            void h.raw(command, args).then(resolve);
          };
        });
      return null;
    };
    const form = await openNewThread(h.user);
    await h.user.selectOptions(account(form), h.claudeWork);
    await h.user.click(form.getByRole("button", { name: "Sign in to Work" }));
    await form.findByRole("button", { name: "Cancel sign-in" });
    await act(async () => {
      finishOptions(await h.raw("thread_options"));
    });
    expect(h.calls.some((call) => call.command === "provider_claude_login_cancel")).toBe(false);
    await act(async () => {
      finishLogin();
    });
    await form.findByRole("textbox", { name: "Task" });
    expect(account(form)).toHaveValue(h.claudeWork);
  });

  it("preserves the draft when signing in without reloading unrelated thread options", async () => {
    const h = await mountStable(async ({ client, claudeWork }) => {
      await client.logoutClaudeAccount(claudeWork);
    });
    const form = await openNewThread(h.user);
    await h.user.selectOptions(account(form), h.claudeWork);
    await h.user.type(form.getByRole("textbox", { name: "Task" }), "Keep this draft through recovery");
    intercept = (command) =>
      command === "thread_options"
        ? Promise.reject({ category: "internal", code: "options_unavailable", message: "Options unavailable" })
        : null;
    await h.user.click(form.getByRole("button", { name: "Sign in to Work" }));
    await waitFor(() => expect(form.getByRole("button", { name: "Start thread" })).toBeEnabled());
    expect(form.getByRole("textbox", { name: "Task" })).toHaveValue("Keep this draft through recovery");
    expect(account(form)).toHaveValue(h.claudeWork);
  });

  it("signs in the selected account in place and keeps the draft", async () => {
    const h = await mountStable(async ({ client, claudeWork }) => {
      await client.logoutClaudeAccount(claudeWork);
    });
    const form = await openNewThread(h.user);
    await h.user.selectOptions(account(form), h.claudeWork);
    await h.user.type(form.getByRole("textbox", { name: "Task" }), "Keep this draft");
    expect(form.getByRole("button", { name: "Start thread" })).toBeDisabled();
    await h.user.click(form.getByRole("button", { name: "Sign in to Work" }));
    await waitFor(() => expect(form.getByRole("button", { name: "Start thread" })).toBeEnabled());
    expect(form.getByRole("textbox", { name: "Task" })).toHaveValue("Keep this draft");
    expect(account(form)).toHaveValue(h.claudeWork);
    expect(h.calls.some((call) => call.command === "provider_claude_login_start")).toBe(true);
  });

  it("keeps a selected account blocked when it is removed during refresh until another is chosen", async () => {
    const h = await mountStable(async ({ client, claudeWork }) => {
      await client.logoutClaudeAccount(claudeWork);
    });
    const form = await openNewThread(h.user);
    await h.user.selectOptions(account(form), h.claudeWork);
    await h.user.type(form.getByRole("textbox", { name: "Task" }), "Keep this exact account");
    intercept = (command, args) =>
      command === "provider_claude_login_wait"
        ? h.raw(command, args).then(async (connected) => {
            await h.raw("provider_account_archive", { accountId: h.claudeWork });
            return connected;
          })
        : null;

    await h.user.click(form.getByRole("button", { name: "Sign in to Work" }));

    expect(await form.findByRole("alert")).toHaveTextContent(
      "The selected account is no longer available. Add or choose another account to continue.",
    );
    expect(account(form)).toHaveValue("");
    expect(form.getByRole("button", { name: "Start thread" })).toBeDisabled();
    expect(h.calls.some((call) => call.command === "thread_review_create_prompt")).toBe(false);

    await h.user.selectOptions(account(form), CLAUDE_PERSONAL);
    expect(form.getByRole("button", { name: "Start thread" })).toBeEnabled();
  });

  it("adds and signs in an account without leaving a new thread", async () => {
    const h = await mountStable(async ({ client, claudeWork }) => {
      await client.archiveProviderAccount(claudeWork);
      await client.archiveProviderAccount(CLAUDE_PERSONAL);
    });
    await goTo(h.user, "Threads");
    await h.user.click(screen.getAllByRole("button", { name: "New thread" })[0] as HTMLElement);
    const form = within(await screen.findByRole("region", { name: "New thread" }));
    await h.user.type(await form.findByRole("textbox", { name: /Account name/ }), "New Work");
    await h.user.click(form.getByRole("button", { name: "Add Claude Code account" }));
    await waitFor(() => expect(form.queryByRole("button", { name: "Sign in to New Work" })).not.toBeInTheDocument());
    await waitFor(async () =>
      expect(
        (await h.client.listProviderAccounts()).find((a) => a.displayName === "New Work")?.authenticationState,
      ).toBe("authenticated"),
    );
    expect(screen.getByRole("heading", { level: 2, name: "New thread" })).toBeVisible();
  });

  it("shows the account picker while thread options are still loading", async () => {
    const h = await mountStable();
    intercept = (command) => (command === "thread_options" ? new Promise(() => {}) : null);
    const form = await openNewThread(h.user);
    await h.user.selectOptions(account(form), h.claudeWork);
    expect(account(form)).toHaveValue(h.claudeWork);
  });

  it("uses the only account without making the user choose it", async () => {
    const h = await mountStable(async ({ client, claudeWork }) => {
      await client.archiveProviderAccount(claudeWork);
    });
    await goTo(h.user, "Threads");
    await h.user.click(screen.getAllByRole("button", { name: "New thread" })[0] as HTMLElement);
    const form = within(await screen.findByRole("region", { name: "New thread" }));
    await form.findByRole("textbox", { name: "Task" });
    expect(form.queryByRole("combobox", { name: "Account" })).not.toBeInTheDocument();
    await h.user.type(form.getByRole("textbox", { name: "Task" }), "Inspect this project");
    await h.user.click(form.getByRole("button", { name: "Start thread" }));
    await waitFor(() =>
      expect(
        h.calls.some((call) => call.command === "thread_create" && JSON.stringify(call.args).includes(CLAUDE_PERSONAL)),
      ).toBe(true),
    );
  });

  it("preselects the workspace's remembered account before the provider default", async () => {
    const h = await mountStable(async ({ client, alpha, claudeWork }) => {
      await client.bindProviderAccount("claude-code", "workspace", alpha.id, claudeWork);
    });
    // beta was opened last, so it is the active workspace: no binding, the provider default.
    const form = await openNewThread(h.user);
    await waitFor(() => expect(workspace(form)).toHaveValue(h.beta.id));
    expect(account(form)).toHaveValue(CLAUDE_PERSONAL);
    expect(form.getByText("Default account.")).toBeInTheDocument();

    // Choosing alpha in the form re-resolves to alpha's remembered account and says why.
    await h.user.selectOptions(workspace(form), h.alpha.id);
    expect(account(form)).toHaveValue(h.claudeWork);
    expect(form.getByText("Workspace default for alpha.")).toBeInTheDocument();

    // Picking the provider default says so; a pick that is neither default is this thread's choice.
    await h.user.selectOptions(account(form), CLAUDE_PERSONAL);
    expect(form.getByText("Default account.")).toBeInTheDocument();
    await h.user.selectOptions(workspace(form), h.beta.id);
    expect(account(form)).toHaveValue(CLAUDE_PERSONAL);
    await h.user.selectOptions(account(form), h.claudeWork);
    expect(form.getByText("Chosen for this thread.")).toBeInTheDocument();
    // Nothing is written by choosing.
    expect(h.calls.some((c) => c.command === "provider_account_bind")).toBe(false);
  }, 15_000);

  it("lists accounts default first in natural name order, with the default and sign-in state in words", async () => {
    const h = await mountStable(async ({ client }) => {
      await client.createProviderAccount("claude-code", "Claude 10");
      await client.createProviderAccount("claude-code", "Claude 2");
    });
    const form = await openNewThread(h.user);
    const options = within(account(form)).getAllByRole("option");
    expect(options.map((option) => option.textContent)).toEqual([
      "Personal · Default",
      "Claude 2 · Not checked",
      "Claude 10 · Not checked",
      "Work · Not checked",
    ]);
  });

  it("follows the active workspace A → B → A and restores each workspace's account", async () => {
    const h = await mountStable(async ({ client, alpha, claudeWork }) => {
      await client.bindProviderAccount("claude-code", "workspace", alpha.id, claudeWork);
      await client.activateWorkspace(alpha.id);
    });
    const form = await openNewThread(h.user);
    await waitFor(() => expect(workspace(form)).toHaveValue(h.alpha.id));
    expect(account(form)).toHaveValue(h.claudeWork);

    await act(async () => {
      await h.client.activateWorkspace(h.beta.id);
    });
    await waitFor(() => expect(workspace(form)).toHaveValue(h.beta.id));
    expect(account(form)).toHaveValue(CLAUDE_PERSONAL);
    expect(form.getByText("Default account.")).toBeInTheDocument();

    await act(async () => {
      await h.client.activateWorkspace(h.alpha.id);
    });
    await waitFor(() => expect(workspace(form)).toHaveValue(h.alpha.id));
    expect(account(form)).toHaveValue(h.claudeWork);
    expect(form.getByText("Workspace default for alpha.")).toBeInTheDocument();
    // Following the workspace never writes a binding.
    expect(h.calls.some((c) => c.command === "provider_account_bind" || c.command === "provider_account_unbind")).toBe(
      false,
    );
  });

  it("sends the preselected account id, not the global default, when creating", async () => {
    const h = await mountStable(async ({ client, alpha, claudeWork }) => {
      await client.bindProviderAccount("claude-code", "workspace", alpha.id, claudeWork);
      await client.activateWorkspace(alpha.id);
    });
    const form = await openNewThread(h.user);
    await waitFor(() => expect(account(form)).toHaveValue(h.claudeWork));
    await h.user.type(form.getByRole("textbox", { name: "Task" }), "summarize the README");
    await h.user.click(form.getByRole("button", { name: "Start thread" }));
    await waitFor(() => expect(h.calls.some((c) => c.command === "thread_create")).toBe(true));
    const create = h.calls.find((c) => c.command === "thread_create");
    expect(create?.args?.providerAccountId).toBe(h.claudeWork);
    expect(h.calls.some((c) => c.command === "provider_account_bind")).toBe(false);
  });

  it("remembers the chosen account for the workspace only when the box is checked", async () => {
    const h = await mountStable();
    const form = await openNewThread(h.user);
    await waitFor(() => expect(workspace(form)).toHaveValue(h.beta.id));
    await h.user.selectOptions(account(form), h.claudeWork);
    expect(remember(form)).not.toBeChecked();
    await h.user.click(remember(form));
    expect(form.getByText("New Claude Code threads in beta will start with Work.")).toBeInTheDocument();
    await h.user.type(form.getByRole("textbox", { name: "Task" }), "summarize the README");
    await h.user.click(form.getByRole("button", { name: "Start thread" }));

    await waitFor(() => expect(h.calls.some((c) => c.command === "provider_account_bind")).toBe(true));
    const bind = h.calls.find((c) => c.command === "provider_account_bind");
    expect(bind?.args).toEqual({
      providerId: "claude-code",
      kind: "workspace",
      scopeId: h.beta.id,
      accountId: h.claudeWork,
    });
    expect(await screen.findByText("New Claude Code threads in beta use Work")).toBeInTheDocument();
    expect(await h.client.listProviderAccountBindings({ kind: "workspace" })).toEqual([
      { providerId: "claude-code", kind: "workspace", scopeId: h.beta.id, accountId: h.claudeWork },
    ]);

    // The next New thread in beta starts from the remembered account.
    const again = await openNewThread(h.user);
    await waitFor(() => expect(account(again)).toHaveValue(h.claudeWork));
    expect(again.getByText("Workspace default for beta.")).toBeInTheDocument();
  });

  it("leaves workspace bindings untouched when the box is unchecked", async () => {
    const h = await mountStable(async ({ client, beta }) => {
      await client.bindProviderAccount("claude-code", "workspace", beta.id, CLAUDE_PERSONAL);
    });
    const form = await openNewThread(h.user);
    await waitFor(() => expect(account(form)).toHaveValue(CLAUDE_PERSONAL));
    expect(form.getByText("Workspace default for beta.")).toBeInTheDocument();
    await h.user.selectOptions(account(form), h.claudeWork);
    await h.user.type(form.getByRole("textbox", { name: "Task" }), "summarize the README");
    await h.user.click(form.getByRole("button", { name: "Start thread" }));
    await waitFor(() => expect(h.calls.some((c) => c.command === "thread_create")).toBe(true));
    await screen.findByRole("region", { name: "Thread" });
    expect(h.calls.some((c) => c.command === "provider_account_bind" || c.command === "provider_account_unbind")).toBe(
      false,
    );
    expect(await h.client.listProviderAccountBindings({ kind: "workspace" })).toEqual([
      { providerId: "claude-code", kind: "workspace", scopeId: h.beta.id, accountId: CLAUDE_PERSONAL },
    ]);
  });

  it("clears a submitted draft before a slow remembered-account write finishes", async () => {
    const h = await mountStable();
    const form = await openNewThread(h.user);
    await waitFor(() => expect(workspace(form)).toHaveValue(h.beta.id));
    await h.user.selectOptions(account(form), h.claudeWork);
    await h.user.click(remember(form));
    const submitted = "Already submitted before remembering this account";
    await h.user.type(form.getByRole("textbox", { name: "Task" }), submitted);
    const savedDrafts = () =>
      Object.keys(localStorage)
        .filter((key) => key.startsWith(DRAFT_STORAGE_KEY))
        .map((key) => localStorage.getItem(key))
        .join("");
    expect(savedDrafts()).toContain(submitted);
    let finishBinding!: () => void;
    intercept = (command, args) =>
      command === "provider_account_bind"
        ? new Promise((resolve) => {
            finishBinding = () => void h.raw(command, args).then(resolve);
          })
        : null;
    await h.user.click(form.getByRole("button", { name: "Start thread" }));
    await waitFor(() => expect(h.calls.some((call) => call.command === "provider_account_bind")).toBe(true));
    try {
      // A restart here must not recover text whose thread has already started.
      expect(savedDrafts()).not.toContain(submitted);
      expect(form.getByRole("textbox", { name: "Task" })).toHaveValue("");
    } finally {
      await act(async () => finishBinding());
    }
    await screen.findByRole("region", { name: "Thread" });
  });

  it("remembers the workspace account only after the thread was created and started (N5)", async () => {
    const h = await mountStable();
    const form = await openNewThread(h.user);
    await waitFor(() => expect(workspace(form)).toHaveValue(h.beta.id));
    await h.user.selectOptions(account(form), h.claudeWork);
    await h.user.click(remember(form));
    await h.user.type(form.getByRole("textbox", { name: "Task" }), "summarize the README");

    // 1. The create is refused: nothing is remembered and the form says why.
    intercept = (command) =>
      command === "thread_create"
        ? Promise.reject({
            category: "provider",
            code: "provider_account_not_authenticated",
            message: "Work isn't signed in.",
            retryable: false,
          })
        : null;
    await h.user.click(form.getByRole("button", { name: "Start thread" }));
    expect(await form.findByRole("alert")).toHaveTextContent("Work isn't signed in.");

    // 2. The thread is created but its provider fails to start: still nothing remembered.
    intercept = (command, args) =>
      command === "thread_create"
        ? h
            .raw<Record<string, unknown>>("thread_create", args)
            .then((thread) => ({ ...thread, status: "failed", error: { code: "provider_exited", message: "Exited." } }))
        : null;
    await h.user.click(form.getByRole("button", { name: "Start thread" }));
    expect(await screen.findByText("The provider couldn't start")).toBeInTheDocument();
    await screen.findByRole("region", { name: "Thread" });
    expect(h.calls.some((c) => c.command === "provider_account_bind")).toBe(false);
    expect(await h.client.listProviderAccountBindings({ kind: "workspace" })).toEqual([]);
  });
});

describe("New thread permission mode (Stable)", () => {
  const modes = (form: ReturnType<typeof within>) => within(form.getByRole("radiogroup", { name: "Permissions" }));

  it("starts fresh installs in Bypass: no approval prompts", async () => {
    const h = await mountStable();
    const form = await openNewThread(h.user);
    await waitFor(() => expect(modes(form).getByRole("radio", { name: "Bypass" })).toBeChecked());
    expect(modes(form).queryByRole("radio", { name: "Approve" })).not.toBeInTheDocument();

    await h.user.type(form.getByRole("textbox", { name: "Task" }), "run the focused tests");
    await h.user.click(form.getByRole("button", { name: "Start thread" }));
    await waitFor(() => expect(h.calls.some((c) => c.command === "thread_create")).toBe(true));
    const create = h.calls.find((c) => c.command === "thread_create");
    expect(create?.args?.permissionMode).toBe("bypass");
    expect(create?.args?.confirmBypass).toBe(true);
  });

  it("adopts delayed provider readiness without remounting or clearing the draft", async () => {
    const h = await mountStable();
    const readyOptions = await h.raw<Awaited<ReturnType<KalCodeClient["threadOptions"]>>>("thread_options");
    const statuses = await h.raw<Awaited<ReturnType<KalCodeClient["listProviders"]>>>("providers_list");
    let ready = false;
    intercept = (command) => {
      if (command === "thread_options") {
        return Promise.resolve(
          ready
            ? readyOptions
            : { ...readyOptions, providers: readyOptions.providers.filter((provider) => provider.id !== "codex") },
        );
      }
      if (command === "providers_list") {
        return Promise.resolve(
          ready
            ? statuses
            : statuses.map((status) =>
                status.id === "codex"
                  ? {
                      ...status,
                      detection: status.detection
                        ? { ...status.detection, state: "not_installed" as const, auth: "unknown" as const }
                        : null,
                      managedRuntime: undefined,
                    }
                  : status,
              ),
        );
      }
      return null;
    };

    const form = await openNewThread(h.user);
    const task = form.getByRole("textbox", { name: "Task" });
    await h.user.type(task, "keep this draft while Codex warms");
    await h.user.selectOptions(workspace(form), h.beta.id);
    expect(form.getByRole("combobox", { name: "Provider" })).not.toHaveDisplayValue("Codex");

    ready = true;
    act(() => {
      (
        window as unknown as {
          __kalcodeMemory: {
            simulate: (event: {
              type: "provider.health_changed";
              payload: { providerId: "codex"; from: "unavailable"; to: "healthy"; reason: string };
            }) => void;
          };
        }
      ).__kalcodeMemory.simulate({
        type: "provider.health_changed",
        payload: { providerId: "codex", from: "unavailable", to: "healthy", reason: "managed_runtime_ready" },
      });
    });

    await waitFor(() =>
      expect(form.getByRole("combobox", { name: "Provider" }).querySelector('option[value="codex"]')).not.toBeNull(),
    );
    expect(task).toHaveValue("keep this draft while Codex warms");
    expect(workspace(form)).toHaveValue(h.beta.id);
  });

  it("blocks a removed selected provider without changing its account, model or draft", async () => {
    const h = await mountStable();
    const readyOptions = await h.raw<Awaited<ReturnType<KalCodeClient["threadOptions"]>>>("thread_options");
    let removeClaude = false;
    let selectedAccountModelProbes = 0;
    intercept = (command, args) => {
      if (command === "thread_options") {
        return Promise.resolve(
          removeClaude
            ? { ...readyOptions, providers: readyOptions.providers.filter((provider) => provider.id !== "claude-code") }
            : readyOptions,
        );
      }
      if (command === "provider_account_models" && args?.accountId === h.claudeWork) {
        selectedAccountModelProbes += 1;
        return Promise.resolve({
          accountId: h.claudeWork,
          providerId: "claude-code",
          source: "runtime",
          supportedEfforts: [],
          models: [
            {
              id: "claude-account-model",
              displayName: "Claude Account Model",
              isDefault: false,
              defaultEffort: null,
              supportedEfforts: [],
            },
          ],
        });
      }
      return null;
    };

    const form = await openNewThread(h.user);
    await h.user.selectOptions(workspace(form), h.alpha.id);
    await h.user.selectOptions(account(form), h.claudeWork);
    const model = form.getByRole("combobox", { name: "Model" });
    await within(model).findByRole("option", { name: "Claude Account Model · claude-account-model" });
    await h.user.selectOptions(model, "claude-account-model");
    await h.user.type(form.getByRole("textbox", { name: "Task" }), "Keep the whole provider draft");
    await h.user.type(form.getByRole("textbox", { name: /^Name/ }), "Provider recovery");
    await h.user.click(
      within(form.getByRole("radiogroup", { name: "Permissions" })).getByRole("radio", { name: "Plan" }),
    );

    removeClaude = true;
    act(simulateClaudeHealthChange);

    expect(await form.findByRole("alert")).toHaveTextContent(
      "The selected provider is no longer available. Choose another provider to continue.",
    );
    const provider = form.getByRole("combobox", { name: "Provider" });
    expect(provider).toHaveValue("claude-code");
    expect(account(form)).toHaveValue(h.claudeWork);
    expect(model).toHaveValue("claude-account-model");
    expect(workspace(form)).toHaveValue(h.alpha.id);
    expect(form.getByRole("textbox", { name: "Task" })).toHaveValue("Keep the whole provider draft");
    expect(form.getByRole("textbox", { name: /^Name/ })).toHaveValue("Provider recovery");
    expect(
      within(form.getByRole("radiogroup", { name: "Permissions" })).getByRole("radio", { name: "Plan" }),
    ).toBeChecked();
    expect(form.getByRole("button", { name: "Start thread" })).toBeDisabled();

    const probesBeforeFocus = selectedAccountModelProbes;
    await h.user.click(model);
    expect(selectedAccountModelProbes).toBe(probesBeforeFocus);
    fireEvent.submit(form.getByRole("button", { name: "Start thread" }).closest("form") as HTMLFormElement);
    await Promise.resolve();
    expect(
      h.calls.some((call) => call.command === "thread_review_create_prompt" || call.command === "thread_create"),
    ).toBe(false);

    await h.user.selectOptions(provider, "codex");
    expect(form.queryByText(/The selected provider is no longer available/)).not.toBeInTheDocument();
    expect(model).toHaveValue("");
    expect(workspace(form)).toHaveValue(h.alpha.id);
    expect(form.getByRole("textbox", { name: "Task" })).toHaveValue("Keep the whole provider draft");
    expect(form.getByRole("textbox", { name: /^Name/ })).toHaveValue("Provider recovery");
    expect(
      within(form.getByRole("radiogroup", { name: "Permissions" })).getByRole("radio", { name: "Plan" }),
    ).toBeChecked();
    await waitFor(() => expect(form.getByRole("button", { name: "Start thread" })).toBeEnabled());
  });

  it("keeps the form mounted when its selected provider was the last available provider", async () => {
    const h = await mountStable();
    const readyOptions = await h.raw<Awaited<ReturnType<KalCodeClient["threadOptions"]>>>("thread_options");
    let offered: "all" | "none" | "codex" = "all";
    intercept = (command, args) => {
      if (command === "thread_options") {
        return Promise.resolve({
          ...readyOptions,
          providers:
            offered === "all"
              ? readyOptions.providers
              : offered === "codex"
                ? readyOptions.providers.filter((provider) => provider.id === "codex")
                : [],
        });
      }
      if (command === "provider_account_models" && args?.accountId === h.claudeWork) {
        return Promise.resolve({
          accountId: h.claudeWork,
          providerId: "claude-code",
          source: "runtime",
          supportedEfforts: [],
          models: [
            {
              id: "claude-last-model",
              displayName: "Claude Last Model",
              isDefault: false,
              defaultEffort: null,
              supportedEfforts: [],
            },
          ],
        });
      }
      return null;
    };

    const form = await openNewThread(h.user);
    await h.user.selectOptions(workspace(form), h.alpha.id);
    await h.user.selectOptions(account(form), h.claudeWork);
    const model = form.getByRole("combobox", { name: "Model" });
    await within(model).findByRole("option", { name: "Claude Last Model · claude-last-model" });
    await h.user.selectOptions(model, "claude-last-model");
    await h.user.type(form.getByRole("textbox", { name: "Task" }), "Keep the last-provider draft");
    await h.user.type(form.getByRole("textbox", { name: /^Name/ }), "Last provider recovery");
    await h.user.click(
      within(form.getByRole("radiogroup", { name: "Permissions" })).getByRole("radio", { name: "Plan" }),
    );

    offered = "none";
    act(simulateClaudeHealthChange);

    expect(await form.findByRole("alert")).toHaveTextContent(
      "The selected provider is no longer available. Choose another provider to continue.",
    );
    expect(form.getByRole("combobox", { name: "Provider" })).toHaveValue("claude-code");
    expect(account(form)).toHaveValue(h.claudeWork);
    expect(model).toHaveValue("claude-last-model");
    expect(workspace(form)).toHaveValue(h.alpha.id);
    expect(form.getByRole("textbox", { name: "Task" })).toHaveValue("Keep the last-provider draft");
    expect(form.getByRole("textbox", { name: /^Name/ })).toHaveValue("Last provider recovery");
    expect(
      within(form.getByRole("radiogroup", { name: "Permissions" })).getByRole("radio", { name: "Plan" }),
    ).toBeChecked();
    expect(form.getByRole("button", { name: "Start thread" })).toBeDisabled();

    offered = "codex";
    act(simulateClaudeHealthChange);
    const provider = form.getByRole("combobox", { name: "Provider" });
    await waitFor(() => expect(within(provider).getByRole("option", { name: "Codex" })).toBeInTheDocument());
    expect(provider).toHaveValue("claude-code");
    await h.user.selectOptions(provider, "codex");
    expect(form.getByRole("textbox", { name: "Task" })).toHaveValue("Keep the last-provider draft");
    expect(form.getByRole("textbox", { name: /^Name/ })).toHaveValue("Last provider recovery");
    expect(workspace(form)).toHaveValue(h.alpha.id);
    expect(
      within(form.getByRole("radiogroup", { name: "Permissions" })).getByRole("radio", { name: "Plan" }),
    ).toBeChecked();
    await waitFor(() => expect(form.getByRole("button", { name: "Start thread" })).toBeEnabled());
  });

  it("keeps a saved read-only Plan default", async () => {
    const h = await mountStable(async ({ client }) => {
      await client.updatePermissionSettings("plan");
    });
    const form = await openNewThread(h.user);
    await waitFor(() => expect(modes(form).getByRole("radio", { name: "Plan" })).toBeChecked());
    expect(form.queryByRole("note")).not.toBeInTheDocument();

    await h.user.type(form.getByRole("textbox", { name: "Task" }), "summarize the README");
    await h.user.click(form.getByRole("button", { name: "Start thread" }));
    await waitFor(() => expect(h.calls.some((c) => c.command === "thread_create")).toBe(true));
    expect(h.calls.find((c) => c.command === "thread_create")?.args?.permissionMode).toBe("plan");
  });

  it("starts a saved Approve default in Bypass and says why", async () => {
    const h = await mountStable(async ({ client }) => {
      await client.updatePermissionSettings("approve");
    });
    const form = await openNewThread(h.user);
    await waitFor(() => expect(modes(form).getByRole("radio", { name: "Bypass" })).toBeChecked());
    expect(form.getByRole("note")).toHaveTextContent(
      "KalCode runs without approval prompts, so this thread starts in Bypass.",
    );

    // A mode the person picks is their own choice: the note goes away.
    await h.user.click(modes(form).getByRole("radio", { name: "Plan" }));
    expect(form.queryByRole("note")).not.toBeInTheDocument();
  });
});
