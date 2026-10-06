import type { ProviderAccount, ThreadOptions, Workspace } from "@kalcode/protocol";
import { ToastProvider } from "@kalcode/ui/components";
import { act, render as renderView, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { KalCodeClient } from "../../ipc/client.ts";
import type { AccountUsageState } from "../providers/accountUsage.ts";
import { ProviderAccountSessionsProvider } from "../providers/ProviderAccountSessions.tsx";
import { NewAgentDialog } from "./NewAgentDialog.tsx";

const render = (ui: ReactNode) => renderView(<ToastProvider>{ui}</ToastProvider>);

const runtime = vi.hoisted(() => ({ client: null as unknown as KalCodeClient }));
vi.mock("../../runtime/RuntimeProvider.tsx", () => ({ useRuntime: () => runtime }));

// Canonical usage comes from the shell's account reader; tests set it directly.
const usage = vi.hoisted(() => ({ map: new Map<string, AccountUsageState>() }));
vi.mock("../providers/accountUsage.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../providers/accountUsage.ts")>();
  return { ...actual, useAccountUsages: () => usage.map };
});

const fresh = (
  accountId: string,
  weeklyPercent: number,
  plan: string | null = null,
  fiveHourPercent: number | null = null,
): AccountUsageState => ({
  accountId,
  status: "fresh",
  windows: [
    { id: "weekly", label: "Weekly", remainingPercent: weeklyPercent, resetsAt: null },
    ...(fiveHourPercent === null
      ? []
      : [{ id: "five_hour", label: "5-hour", remainingPercent: fiveHourPercent, resetsAt: null }]),
  ],
  checkedAt: new Date().toISOString(),
  reason: null,
  plan,
});

const makeAccount = (
  id: string,
  displayName: string,
  isDefault: boolean,
  providerId: ProviderAccount["providerId"] = "claude-code",
): ProviderAccount =>
  ({
    id,
    providerId,
    displayName,
    providerReportedIdentity: null,
    authenticationState: "authenticated",
    isDefault,
    createdAt: "2026-10-01T00:00:00.000Z",
    lastUsedAt: null,
    lastCheckedAt: "2026-10-01T00:00:00.000Z",
    lastErrorCode: null,
    archivedAt: null,
  }) as ProviderAccount;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  window.localStorage.clear();
  usage.map = new Map();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

describe("restored accounts in the Code launcher", () => {
  it("opens reusable Squads directly from the launcher's Other actions", async () => {
    const personal = makeAccount("personal", "Personal", true);
    runtime.client = {
      listProviderAccounts: vi.fn(async () => [personal]),
      listProviderAccountBindings: vi.fn(async () => []),
      threadOptions: vi.fn(() => new Promise<ThreadOptions>(() => {})),
    } as unknown as KalCodeClient;
    const onOpenSquads = vi.fn();
    const onClose = vi.fn();
    render(
      <NewAgentDialog
        workspace={{ id: "ws", name: "Project" } as Workspace}
        offered={[]}
        initialProvider="claude-code"
        busy={false}
        error={null}
        onLaunch={vi.fn(async () => true)}
        onClose={onClose}
        onOpenSquads={onOpenSquads}
      />,
    );

    await userEvent.setup().click(screen.getByRole("button", { name: "Squads" }));
    expect(onOpenSquads).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("uses the sole account without a picker and launches its exact identity", async () => {
    const personal = makeAccount("personal", "Personal", true);
    runtime.client = {
      listProviderAccounts: vi.fn(async () => [personal]),
      listProviderAccountBindings: vi.fn(async () => []),
      threadOptions: vi.fn(() => new Promise<ThreadOptions>(() => {})),
    } as unknown as KalCodeClient;
    const onLaunch = vi.fn(async () => true);
    render(
      <NewAgentDialog
        workspace={{ id: "ws", name: "Project" } as Workspace}
        offered={[]}
        initialProvider="claude-code"
        busy={false}
        error={null}
        onLaunch={onLaunch}
        onClose={vi.fn()}
      />,
    );
    const option = await screen.findByRole("option", { name: /Personal/ });
    expect(option).toHaveAttribute("aria-selected", "true");
    expect(screen.queryByRole("combobox", { name: "Account" })).not.toBeInTheDocument();
    const launch = screen.getByRole("button", { name: "Launch Claude Code agent" });
    await waitFor(() => expect(launch).toBeEnabled());
    await userEvent.setup().click(launch);
    expect(onLaunch).toHaveBeenCalledWith(expect.objectContaining({ providerAccountId: personal.id }));
  });

  it("offers accounts and launches the chosen one without waiting for model detection", async () => {
    const personal = makeAccount("personal", "Personal", true);
    const work = makeAccount("work", "Work", false);
    runtime.client = {
      listProviderAccounts: vi.fn(async () => [personal, work]),
      listProviderAccountBindings: vi.fn(async () => []),
      threadOptions: vi.fn(() => new Promise<ThreadOptions>(() => {})),
    } as unknown as KalCodeClient;
    const onLaunch = vi.fn(async () => true);
    render(
      <NewAgentDialog
        workspace={{ id: "ws", name: "Project" } as Workspace}
        offered={[]}
        initialProvider="claude-code"
        busy={false}
        error={null}
        onLaunch={onLaunch}
        onClose={vi.fn()}
      />,
    );
    const choice = await screen.findByRole("option", { name: /Work/ });
    const user = userEvent.setup();
    await user.click(choice);
    expect(choice).toHaveAttribute("aria-selected", "true");
    await user.click(screen.getByRole("button", { name: "Launch Claude Code agent" }));
    expect(onLaunch).toHaveBeenCalledWith(expect.objectContaining({ providerAccountId: work.id }));
  });

  it("reports a failed account read instead of launching an implicit account", async () => {
    runtime.client = {
      listProviderAccounts: vi.fn(async () => {
        throw new Error("Account registry unavailable");
      }),
      listProviderAccountBindings: vi.fn(async () => []),
      threadOptions: vi.fn(async () => ({ providers: [] })),
    } as unknown as KalCodeClient;
    const onLaunch = vi.fn(async () => true);
    render(
      <NewAgentDialog
        workspace={{ id: "ws", name: "Project" } as Workspace}
        offered={[]}
        initialProvider="claude-code"
        busy={false}
        error={null}
        onLaunch={onLaunch}
        onClose={vi.fn()}
      />,
    );
    expect(await screen.findByText("Accounts unavailable")).toBeVisible();
    expect(screen.getByRole("button", { name: "Launch Claude Code agent" })).toBeDisabled();
    expect(onLaunch).not.toHaveBeenCalled();
  });

  it("shows a truthful recovery action when startup restore exhausts its quiet retries", async () => {
    const claude = makeAccount("claude-a", "Claude A", true);
    runtime.client = {
      listProviderAccounts: vi
        .fn<() => Promise<ProviderAccount[]>>()
        .mockRejectedValueOnce({ category: "internal", code: "starting", message: "Runtime starting", retryable: true })
        .mockRejectedValueOnce({ category: "internal", code: "starting", message: "Runtime starting", retryable: true })
        .mockRejectedValueOnce({
          category: "internal",
          code: "account_registry",
          message: "Account registry unavailable",
          retryable: true,
        })
        .mockResolvedValueOnce([claude]),
      refreshClaudeAccount: vi.fn(async () => claude),
      refreshCodexAccount: vi.fn(),
      refreshGeminiAccount: vi.fn(),
      providerAccountModels: vi.fn(async (accountId: string) => ({
        accountId,
        providerId: "claude-code" as const,
        models: [],
      })),
      listProviderAccountBindings: vi.fn(async () => []),
      threadOptions: vi.fn(
        async () =>
          ({
            providers: [{ id: "claude-code", displayName: "Claude Code", models: [] }],
            workspaces: [],
            permissionModes: [],
            defaultPermissionMode: "approve",
          }) as unknown as ThreadOptions,
      ),
    } as unknown as KalCodeClient;

    render(
      <ProviderAccountSessionsProvider>
        <NewAgentDialog
          workspace={{ id: "workspace-1", name: "KalCode" } as Workspace}
          offered={[]}
          initialProvider="claude-code"
          busy={false}
          error={null}
          onLaunch={vi.fn(async () => true)}
          onClose={vi.fn()}
        />
      </ProviderAccountSessionsProvider>,
    );

    expect(await screen.findByText("Accounts unavailable", {}, { timeout: 2_000 })).toBeVisible();
    await userEvent.setup().click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(runtime.client.listProviderAccounts).toHaveBeenCalledTimes(4));
    await waitFor(() => expect(screen.getByText(/Claude A/)).toBeVisible());
    expect(runtime.client.listProviderAccounts).toHaveBeenCalledTimes(4);
    expect(runtime.client.refreshClaudeAccount).not.toHaveBeenCalled();
  });

  it("keeps the user's account selection while background checks settle and launches it immediately", async () => {
    const codexA = makeAccount("codex-a", "Codex A", true, "codex");
    const codexB = makeAccount("codex-b", "Codex B", false, "codex");
    const checks = new Map([
      [codexA.id, deferred<ProviderAccount>()],
      [codexB.id, deferred<ProviderAccount>()],
    ]);
    runtime.client = {
      listProviderAccounts: vi.fn(async () => [codexA, codexB]),
      refreshClaudeAccount: vi.fn(),
      refreshCodexAccount: vi.fn((id: string) => {
        const check = checks.get(id);
        if (!check) throw new Error(`Missing check for ${id}`);
        return check.promise;
      }),
      refreshGeminiAccount: vi.fn(),
      providerAccountModels: vi.fn(async (accountId: string) => ({
        accountId,
        providerId: "codex" as const,
        models: [],
      })),
      listProviderAccountBindings: vi.fn(async () => []),
      threadOptions: vi.fn(
        async () =>
          ({
            providers: [{ id: "codex", displayName: "Codex", models: [] }],
            workspaces: [],
            permissionModes: [],
            defaultPermissionMode: "approve",
          }) as unknown as ThreadOptions,
      ),
    } as unknown as KalCodeClient;
    const onLaunch = vi.fn(async () => true);

    render(
      <ProviderAccountSessionsProvider>
        <NewAgentDialog
          workspace={{ id: "workspace-1", name: "KalCode" } as Workspace}
          offered={["codex"]}
          initialProvider="codex"
          busy={false}
          error={null}
          onLaunch={onLaunch}
          onClose={vi.fn()}
        />
      </ProviderAccountSessionsProvider>,
    );

    const choiceB = await screen.findByRole("option", { name: /Codex B/ });
    await waitFor(() => expect(screen.getByRole("button", { name: "Launch Codex agent" })).toBeEnabled());
    await userEvent.setup().click(choiceB);
    expect(choiceB).toHaveAttribute("aria-selected", "true");

    checks.get(codexA.id)?.resolve({ ...codexA, lastCheckedAt: "2026-10-02T00:00:00.000Z" });
    checks.get(codexB.id)?.resolve({ ...codexB, lastCheckedAt: "2026-10-02T00:00:00.000Z" });
    await waitFor(() =>
      expect(screen.getByRole("option", { name: /Codex B/ })).toHaveAttribute("aria-selected", "true"),
    );

    await userEvent.setup().click(screen.getByRole("button", { name: "Launch Codex agent" }));
    expect(onLaunch).toHaveBeenCalledWith(expect.objectContaining({ providerAccountId: codexB.id }));
  });

  it("submits the new provider's restored account on its first rendered frame", async () => {
    const claude = makeAccount("claude-a", "Claude A", true);
    const codex = makeAccount("codex-a", "Codex A", true, "codex");
    runtime.client = {
      listProviderAccounts: vi.fn(async () => [claude, codex]),
      refreshClaudeAccount: vi.fn(),
      refreshCodexAccount: vi.fn(async () => codex),
      refreshGeminiAccount: vi.fn(),
      providerAccountModels: vi.fn(async (accountId: string) => ({
        accountId,
        providerId: accountId === claude.id ? ("claude-code" as const) : ("codex" as const),
        models: [],
      })),
      listProviderAccountBindings: vi.fn(async () => []),
      threadOptions: vi.fn(
        async () =>
          ({
            providers: [{ id: "codex", displayName: "Codex", models: [] }],
            workspaces: [],
            permissionModes: [],
            defaultPermissionMode: "approve",
          }) as unknown as ThreadOptions,
      ),
    } as unknown as KalCodeClient;
    const onLaunch = vi.fn(async () => false);

    render(
      <ProviderAccountSessionsProvider>
        <NewAgentDialog
          workspace={{ id: "workspace-1", name: "KalCode" } as Workspace}
          offered={["codex"]}
          initialProvider="claude-code"
          busy={false}
          error={null}
          onLaunch={onLaunch}
          onClose={vi.fn()}
        />
      </ProviderAccountSessionsProvider>,
    );

    await screen.findByRole("option", { name: /Claude A/ });
    await waitFor(() => expect(screen.getByRole("button", { name: "Launch Claude Code agent" })).toBeEnabled());
    const codexChoice = screen.getByRole("option", { name: /Codex A/ });
    const form = screen.getByRole("form", { name: "New agent" }) as HTMLFormElement;
    const observer = new MutationObserver(() => {
      if (codexChoice.getAttribute("aria-selected") !== "true") return;
      observer.disconnect();
      form.requestSubmit();
    });
    observer.observe(codexChoice, { attributes: true, attributeFilter: ["aria-selected"] });

    await userEvent.setup().click(codexChoice);
    await waitFor(() =>
      expect(onLaunch).toHaveBeenCalledWith(
        expect.objectContaining({ providerId: "codex", providerAccountId: codex.id }),
      ),
    );
  });

  it("keeps a Codex request while providers are still detected, then resolves to Codex", async () => {
    const claude = makeAccount("claude-a", "Claude A", true);
    const codex = makeAccount("codex-a", "Codex A", true, "codex");
    const options = deferred<ThreadOptions>();
    runtime.client = clientWith([claude, codex], () => options.promise);
    const onLaunch = vi.fn(async () => true);
    render(dialog({ offered: [], initialProvider: "codex", onLaunch }));
    expect(await screen.findByText("Checking Codex…")).toBeVisible();
    expect(screen.getByRole("button", { name: "Launch Codex agent" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: /Launch Claude Code/ })).not.toBeInTheDocument();
    options.resolve(threadOptions(["claude-code", "codex"]));
    const launch = await screen.findByRole("button", { name: "Launch Codex agent" });
    await waitFor(() => expect(launch).toBeEnabled());
    expect(screen.getByRole("option", { name: /Codex A/ })).toHaveAttribute("aria-selected", "true");
    await userEvent.setup().click(launch);
    expect(onLaunch).toHaveBeenCalledWith(
      expect.objectContaining({ providerId: "codex", providerAccountId: codex.id }),
    );
  });

  it("remembers the last launch per provider and repeats it from Recent in one click", async () => {
    const personal = makeAccount("personal", "Personal", true);
    const work = makeAccount("work", "Work", false);
    runtime.client = clientWith([personal, work], async () => threadOptions(["claude-code"]));
    const first = vi.fn(async () => true);
    const user = userEvent.setup();
    const view = render(dialog({ onLaunch: first }));
    await user.click(await screen.findByRole("option", { name: /Work/ }));
    await user.click(await screen.findByRole("radio", { name: "Opus" }));
    await user.click(screen.getByRole("radio", { name: "High" }));
    await user.click(screen.getByRole("button", { name: "One more agent" }));
    await user.click(screen.getByRole("button", { name: "Launch 2 Claude Code agents" }));
    expect(first).toHaveBeenCalledWith({
      providerId: "claude-code",
      count: 2,
      providerAccountId: work.id,
      model: "opus",
      effort: "high",
    });
    view.unmount();

    // Reopened (as after a restart): the same choices are already made.
    const second = vi.fn(async () => true);
    render(dialog({ onLaunch: second }));
    expect(await screen.findByRole("option", { name: /Work/ })).toHaveAttribute("aria-selected", "true");
    expect(await screen.findByRole("radio", { name: "Opus" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("radio", { name: "High" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByLabelText("Agents", { exact: true })).toHaveValue(2);
    const recent = screen.getByRole("button", { name: "Repeat last: Claude Code · Work · Opus · High · 2 agents" });
    await user.click(recent);
    expect(second).toHaveBeenCalledWith({
      providerId: "claude-code",
      count: 2,
      providerAccountId: work.id,
      model: "opus",
      effort: "high",
    });
  });

  it("lets an Account Center binding made after the last launch win over the remembered account", async () => {
    const personal = makeAccount("personal", "Personal", true);
    const studio = makeAccount("studio", "Studio", false);
    window.localStorage.setItem(
      "kalcode.agentLauncher.v1",
      JSON.stringify({
        last: null,
        byProvider: {
          "claude-code": {
            providerId: "claude-code",
            accountId: personal.id,
            count: 1,
            workspaceId: "ws",
            boundAccountId: null,
          },
        },
      }),
    );
    runtime.client = clientWith([personal, studio], async () => threadOptions(["claude-code"]), [
      { providerId: "claude-code", kind: "workspace", scopeId: "ws", accountId: studio.id },
    ]);
    render(dialog({}));
    await waitFor(() =>
      expect(screen.getByRole("option", { name: /Studio/ })).toHaveAttribute("aria-selected", "true"),
    );
  });

  it("flags a second account that is the same provider sign-in", async () => {
    const first = { ...makeAccount("kc", "KalCode", true), providerReportedIdentity: "owner@kalcode.dev" };
    const second = { ...makeAccount("kc2", "KalCode 2", false), providerReportedIdentity: "Owner@kalcode.dev" };
    runtime.client = clientWith([first, second], async () => threadOptions(["claude-code"]));
    render(dialog({}));
    const options = await screen.findAllByRole("option");
    expect(within(options[0] as HTMLElement).getByText(/owner@kalcode.dev/)).toBeVisible();
    expect(within(options[1] as HTMLElement).getByText("Same sign-in as KalCode")).toBeVisible();
  });

  it("shows real usage and suggests (never switches to) a fuller account when running low", async () => {
    const a = makeAccount("claude-a", "Claude A", true);
    const b = makeAccount("claude-b", "Claude B", false);
    usage.map = new Map([
      [a.id, fresh(a.id, 8, "Max")],
      [b.id, fresh(b.id, 91, "Max")],
    ]);
    runtime.client = clientWith([a, b], async () => threadOptions(["claude-code"]));
    render(dialog({}));
    const optionA = await screen.findByRole("option", { name: /Claude A/ });
    expect(optionA).toHaveTextContent(/Max/);
    expect(optionA).toHaveTextContent(/8% left/);
    expect(optionA).toHaveTextContent(/Ready/);
    expect(screen.getByRole("option", { name: /Claude B/ })).toHaveTextContent(/91% left.*Ready/);
    expect(screen.getByText("Claude A is running low on its weekly limit. Use Claude B instead?")).toBeVisible();
    expect(optionA).toHaveAttribute("aria-selected", "true");
    await userEvent.setup().click(screen.getByRole("button", { name: "Use Claude B" }));
    expect(screen.getByRole("option", { name: /Claude B/ })).toHaveAttribute("aria-selected", "true");
  });

  it("shows weekly remaining on rows but names the 5-hour limit when that one runs low", async () => {
    const a = makeAccount("claude-a", "Claude A", true);
    const b = makeAccount("claude-b", "Claude B", false);
    usage.map = new Map([
      [a.id, fresh(a.id, 73, "Max", 4)],
      [b.id, fresh(b.id, 40, "Max", 90)],
    ]);
    runtime.client = clientWith([a, b], async () => threadOptions(["claude-code"]));
    render(dialog({}));
    const optionA = await screen.findByRole("option", { name: /Claude A/ });
    expect(optionA).toHaveTextContent(/73% left/);
    expect(optionA).not.toHaveTextContent(/4% left/);
    expect(screen.getByRole("option", { name: /Claude B/ })).toHaveTextContent(/40% left/);
    expect(screen.getByText("Claude A is running low on its 5-hour limit. Use Claude B instead?")).toBeVisible();
  });

  it("never invents usage: unknown accounts say so", async () => {
    const a = makeAccount("claude-a", "Claude A", true);
    runtime.client = clientWith([a], async () => threadOptions(["claude-code"]));
    render(dialog({}));
    expect(await screen.findByRole("option", { name: /Claude A/ })).toHaveTextContent(/Usage unavailable/);
    expect(screen.queryByText(/% left/)).not.toBeInTheDocument();
  });

  it("is keyboard-first: arrows choose, digits set the count, Enter launches", async () => {
    const a = makeAccount("claude-a", "Claude A", true);
    const codex = makeAccount("codex-a", "Codex A", true, "codex");
    runtime.client = clientWith([a, codex], async () => threadOptions(["claude-code", "codex"]));
    const onLaunch = vi.fn(async () => true);
    render(dialog({ offered: ["codex"], onLaunch }));
    const list = await screen.findByRole("listbox", { name: "Account" });
    await waitFor(() => expect(screen.getByRole("button", { name: "Launch Claude Code agent" })).toBeEnabled());
    list.focus();
    const user = userEvent.setup();
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("option", { name: /Codex A/ })).toHaveAttribute("aria-selected", "true");
    await user.keyboard("3");
    expect(screen.getByLabelText("Agents", { exact: true })).toHaveValue(3);
    await user.keyboard("{Enter}");
    expect(onLaunch).toHaveBeenCalledWith(
      expect.objectContaining({ providerId: "codex", providerAccountId: codex.id, count: 3 }),
    );
  });

  it("launches exactly one recipient for a handoff and offers no Recent repeat", async () => {
    const a = makeAccount("claude-a", "Claude A", true);
    rememberAnything(a.id);
    runtime.client = clientWith([a], async () => threadOptions(["claude-code"]));
    const onLaunch = vi.fn(async () => true);
    render(dialog({ fixedCount: 1, purpose: "handoff", onLaunch }));
    expect(await screen.findByRole("dialog", { name: "New recipient agent" })).toBeVisible();
    expect(screen.getByText("One agent · draft returns for review before sending")).toBeVisible();
    expect(screen.queryByRole("button", { name: /^Repeat last/ })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Agents", { exact: true })).not.toBeInTheDocument();
    const launch = screen.getByRole("button", { name: "Launch Claude Code agent" });
    await waitFor(() => expect(launch).toBeEnabled());
    await userEvent.setup().click(launch);
    expect(onLaunch).toHaveBeenCalledWith(expect.objectContaining({ count: 1 }));
  });

  it("offers Other actions only when the host wires them", async () => {
    const a = makeAccount("claude-a", "Claude A", true);
    runtime.client = clientWith([a], async () => threadOptions(["claude-code"]));
    const onNewTerminal = vi.fn();
    const onClose = vi.fn();
    const view = render(dialog({ onNewTerminal, onClose }));
    await userEvent.setup().click(await screen.findByRole("button", { name: "Terminal" }));
    expect(onNewTerminal).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalled();
    view.unmount();
    render(dialog({}));
    await screen.findByRole("option", { name: /Claude A/ });
    expect(screen.queryByRole("group", { name: "Other" })).not.toBeInTheDocument();
  });
});

function threadOptions(providers: readonly string[]): ThreadOptions {
  return {
    providers: providers.map((id) => ({
      id,
      displayName: id,
      models:
        id === "claude-code"
          ? [
              { id: "default", displayName: "Account default", isDefault: true },
              { id: "opus", displayName: "Opus", isDefault: false },
              { id: "sonnet", displayName: "Sonnet", isDefault: false },
            ]
          : [],
    })),
    workspaces: [],
    permissionModes: [],
    defaultPermissionMode: "approve",
  } as unknown as ThreadOptions;
}

function clientWith(
  accounts: ProviderAccount[],
  options: () => Promise<ThreadOptions>,
  bindings: unknown[] = [],
): KalCodeClient {
  const client = {
    listProviderAccounts: vi.fn(async () => accounts),
    refreshClaudeAccount: vi.fn(),
    refreshCodexAccount: vi.fn(async (id: string) => accounts.find((a) => a.id === id)),
    refreshGeminiAccount: vi.fn(),
    listProviderAccountBindings: vi.fn(async () => bindings),
    threadOptions: vi.fn(options),
    providerAccountModels: vi.fn(async (accountId: string) => {
      const available = await options();
      const providerId = accounts.find((account) => account.id === accountId)?.providerId ?? available.providers[0]?.id;
      if (!providerId) throw new Error("Provider unavailable");
      const provider = available.providers.find((candidate) => candidate.id === providerId);
      return {
        accountId,
        providerId,
        models:
          provider?.models.map((model) => ({
            ...model,
            defaultEffort: null,
            supportedEfforts: [],
          })) ?? [],
      };
    }),
  } as unknown as KalCodeClient;
  return client;
}

function rememberAnything(accountId: string) {
  const entry = { providerId: "claude-code", accountId, count: 4, workspaceId: "ws", boundAccountId: null };
  window.localStorage.setItem(
    "kalcode.agentLauncher.v1",
    JSON.stringify({ last: entry, byProvider: { "claude-code": entry } }),
  );
}

function dialog(props: Partial<Parameters<typeof NewAgentDialog>[0]>) {
  return (
    <NewAgentDialog
      workspace={{ id: "ws", name: "Project" } as Workspace}
      offered={[]}
      initialProvider="claude-code"
      busy={false}
      error={null}
      onLaunch={vi.fn(async () => true)}
      onClose={vi.fn()}
      {...props}
    />
  );
}

describe("independent authentication and metadata in agent creation", () => {
  it.each([false, true])(
    "keeps provider-default model and effort native when account models arrive before launch=%s",
    async (resolveBeforeLaunch) => {
      const account = makeAccount("codex-default", "Codex Default", true, "codex");
      const discovered = deferred<{
        accountId: string;
        providerId: "codex";
        models: {
          id: string;
          displayName: string;
          isDefault: boolean;
          defaultEffort: string;
          supportedEfforts: string[];
        }[];
      }>();
      window.localStorage.setItem(
        "kalcode.agentLauncher.v1",
        JSON.stringify({
          last: null,
          byProvider: {
            codex: {
              providerId: "codex",
              accountId: account.id,
              model: null,
              modelName: null,
              effort: null,
              count: 1,
              workspaceId: "ws",
              boundAccountId: null,
              at: "2026-10-05T00:00:00Z",
            },
          },
        }),
      );
      runtime.client = {
        ...clientWith([account], async () => threadOptions(["codex"])),
        providerAccountModels: vi.fn(() => discovered.promise),
      } as unknown as KalCodeClient;
      const onLaunch = vi.fn(async () => true);
      render(
        <ProviderAccountSessionsProvider>
          {dialog({ offered: ["codex"], initialProvider: "codex", onLaunch })}
        </ProviderAccountSessionsProvider>,
      );
      const launch = await screen.findByRole("button", { name: "Launch Codex agent" });
      await waitFor(() => expect(launch).toBeEnabled());
      if (resolveBeforeLaunch) {
        await act(async () => {
          discovered.resolve({
            accountId: account.id,
            providerId: "codex",
            models: [
              {
                id: "model-a",
                displayName: "Model A",
                isDefault: true,
                defaultEffort: "high",
                supportedEfforts: ["high"],
              },
            ],
          });
        });
        expect(await screen.findByRole("radio", { name: /Provider default.*Model A/ })).toBeChecked();
        expect(screen.getByRole("radio", { name: "Default" })).toBeChecked();
      }
      await userEvent.setup().click(launch);
      expect(onLaunch).toHaveBeenCalledExactlyOnceWith({
        providerId: "codex",
        providerAccountId: account.id,
        model: null,
        effort: null,
        count: 1,
      });
    },
  );

  it("uses account-reported efforts and applies a concrete model's default only after explicit selection", async () => {
    const account = makeAccount("codex-models", "Codex Models", true, "codex");
    runtime.client = {
      ...clientWith([account], async () => threadOptions(["codex"])),
      providerAccountModels: vi.fn(async () => ({
        accountId: account.id,
        providerId: "codex" as const,
        models: [
          {
            id: "model-a",
            displayName: "Model A",
            isDefault: true,
            defaultEffort: "high",
            supportedEfforts: ["high"],
          },
          {
            id: "model-b",
            displayName: "Model B",
            isDefault: false,
            defaultEffort: "medium",
            supportedEfforts: ["medium", "xhigh"],
          },
        ],
      })),
    } as unknown as KalCodeClient;
    const onLaunch = vi.fn(async () => true);
    render(
      <ProviderAccountSessionsProvider>
        {dialog({ offered: ["codex"], initialProvider: "codex", onLaunch })}
      </ProviderAccountSessionsProvider>,
    );
    const user = userEvent.setup();
    await user.click(await screen.findByRole("radio", { name: "Model B" }));
    expect(screen.getByRole("radio", { name: "Medium" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "Extra high" })).toBeVisible();
    expect(screen.queryByRole("radio", { name: "High" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Launch Codex agent" }));
    expect(onLaunch).toHaveBeenCalledExactlyOnceWith({
      providerId: "codex",
      providerAccountId: account.id,
      model: "model-b",
      effort: "medium",
      count: 1,
    });
  });

  it("routes an incompatible recent provider-default effort into the picker instead of launching it", async () => {
    const account = makeAccount("codex-recent", "Codex Recent", true, "codex");
    const recent = {
      providerId: "codex",
      accountId: account.id,
      model: null,
      modelName: null,
      effort: "high",
      count: 1,
      workspaceId: "ws",
      boundAccountId: null,
      at: "2026-10-05T00:00:00Z",
    };
    window.localStorage.setItem(
      "kalcode.agentLauncher.v1",
      JSON.stringify({ last: recent, byProvider: { codex: recent } }),
    );
    runtime.client = {
      ...clientWith([account], async () => threadOptions(["codex"])),
      providerAccountModels: vi.fn(async () => ({
        accountId: account.id,
        providerId: "codex" as const,
        models: [
          {
            id: "model-b",
            displayName: "Model B",
            isDefault: true,
            defaultEffort: "medium",
            supportedEfforts: ["medium", "xhigh"],
          },
        ],
      })),
    } as unknown as KalCodeClient;
    const onLaunch = vi.fn(async () => true);
    render(
      <ProviderAccountSessionsProvider>
        {dialog({ offered: ["codex"], initialProvider: "codex", onLaunch })}
      </ProviderAccountSessionsProvider>,
    );
    expect(await screen.findByText(/High effort is unavailable for Model B/)).toBeVisible();
    await userEvent.setup().click(screen.getByRole("button", { name: /^Repeat last/ }));
    expect(onLaunch).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Launch Codex agent" })).toBeDisabled();
  });

  it("finishes account-model checking truthfully when discovery fails and keeps provider default launchable", async () => {
    const account = makeAccount("codex-model-error", "Codex Models", true, "codex");
    runtime.client = {
      ...clientWith([account], async () => threadOptions(["codex"])),
      providerAccountModels: vi.fn(async () => {
        throw {
          category: "provider",
          code: "provider_models_unavailable",
          message: "Exact models are unavailable.",
          retryable: true,
        };
      }),
    } as unknown as KalCodeClient;
    const onLaunch = vi.fn(async () => true);
    render(
      <ProviderAccountSessionsProvider>
        {dialog({ offered: ["codex"], initialProvider: "codex", onLaunch })}
      </ProviderAccountSessionsProvider>,
    );
    expect(await screen.findByText("Exact models are unavailable. Provider default remains available.")).toBeVisible();
    expect(screen.getByRole("radiogroup", { name: "Model" })).not.toHaveAttribute("aria-busy");
    const launch = screen.getByRole("button", { name: "Launch Codex agent" });
    expect(launch).toBeEnabled();
    await userEvent.setup().click(launch);
    expect(onLaunch).toHaveBeenCalledWith(expect.objectContaining({ model: null, effort: null }));
  });

  it.each(["claude-code", "codex", "cursor", "gemini-cli"] as const)(
    "%s launches its selected account when usage and plan are unavailable",
    async (providerId) => {
      const account = makeAccount(`${providerId}-b`, "Coding B", true, providerId);
      runtime.client = clientWith([account], async () => threadOptions([providerId]));
      runtime.client.refreshCursorAccount = vi.fn(async () => ({
        account,
        models: [],
        modelsError: "Models unavailable",
      }));
      const onLaunch = vi.fn(async () => true);
      render(dialog({ offered: [providerId], initialProvider: providerId, onLaunch }));
      const row = await screen.findByRole("option", { name: /Coding B/ });
      expect(row).toHaveTextContent("Plan unavailable");
      expect(row).toHaveTextContent("Usage unavailable");
      expect(row).toHaveTextContent("Ready");
      expect(row).not.toHaveTextContent(/0%|Low|Exhausted/);
      expect(screen.queryByRole("button", { name: "Reconnect" })).not.toBeInTheDocument();
      const launch = screen.getByRole("button", { name: /^Launch .* agent$/ });
      await waitFor(() => expect(launch).toBeEnabled());
      await userEvent.setup().click(launch);
      expect(onLaunch).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ providerId, providerAccountId: account.id }),
      );
    },
  );

  it.each(["Pro", null])("Codex shows reported usage independently of plan %s and launches", async (plan) => {
    const account = makeAccount("codex-b", "Codex B", true, "codex");
    usage.map.set(account.id, fresh(account.id, 62, plan));
    runtime.client = clientWith([account], async () => threadOptions(["codex"]));
    const onLaunch = vi.fn(async () => true);
    render(dialog({ offered: ["codex"], initialProvider: "codex", onLaunch }));
    const row = await screen.findByRole("option", { name: /Codex B/ });
    expect(row).toHaveTextContent("62% left");
    expect(row).toHaveTextContent(plan ?? "Plan unavailable");
    expect(row).toHaveTextContent("Ready");
    await userEvent.setup().click(screen.getByRole("button", { name: "Launch Codex agent" }));
    expect(onLaunch).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ providerAccountId: account.id }));
  });

  function expiredLauncher(onLaunch = vi.fn(async () => 3), shared = false) {
    let account = {
      ...makeAccount("codex-b", "Codex B", true, "codex"),
      authenticationState: "not_authenticated" as ProviderAccount["authenticationState"],
    };
    const login = deferred<ProviderAccount>();
    runtime.client = {
      ...clientWith(
        [],
        async () =>
          ({
            ...threadOptions(["codex"]),
            providers: [
              {
                id: "codex",
                displayName: "Codex",
                models: [{ id: "gpt-code", displayName: "GPT Code", isDefault: false }],
              },
            ],
          }) as ThreadOptions,
      ),
      listProviderAccounts: vi.fn(async () => [account]),
      refreshCodexAccount: vi.fn(async () => account),
      startCodexLogin: vi.fn(async () => ({ loginHandle: "codex-b-login" })),
      waitForCodexLogin: vi.fn(async () => {
        const connected = await login.promise;
        account = connected;
        return connected;
      }),
      cancelCodexLogin: vi.fn(async () => undefined),
    } as unknown as KalCodeClient;
    const onClose = vi.fn();
    const node = dialog({ offered: ["codex"], initialProvider: "codex", onLaunch, onClose });
    const view = render(shared ? <ProviderAccountSessionsProvider>{node}</ProviderAccountSessionsProvider> : node);
    return { login, onLaunch, onClose, view, connected: { ...account, authenticationState: "authenticated" as const } };
  }

  it.each([false, true])(
    "reconnects inline then automatically launches the exact three-agent request (shared=%s)",
    async (shared) => {
      const { login, onLaunch, onClose, connected } = expiredLauncher(undefined, shared);
      const user = userEvent.setup();
      await user.click(await screen.findByRole("radio", { name: "GPT Code" }));
      await user.click(screen.getByRole("radio", { name: "High" }));
      await user.clear(screen.getByRole("spinbutton", { name: "Agents" }));
      await user.type(screen.getByRole("spinbutton", { name: "Agents" }), "3");
      expect(screen.getByText("Codex B needs to reconnect.")).toBeVisible();
      expect(screen.getByRole("button", { name: "Launch 3 Codex agents" })).toBeDisabled();
      expect(screen.getByRole("dialog")).not.toHaveTextContent(/thread/i);
      await user.click(screen.getByRole("button", { name: "Reconnect" }));
      expect(screen.getByRole("spinbutton", { name: "Agents" })).toBeDisabled();
      expect(screen.getByRole("radio", { name: "GPT Code" })).toBeDisabled();
      await act(async () => login.resolve(connected));
      await waitFor(() =>
        expect(onLaunch).toHaveBeenCalledExactlyOnceWith({
          providerId: "codex",
          providerAccountId: "codex-b",
          model: "gpt-code",
          effort: "high",
          count: 3,
        }),
      );
      expect(onClose).toHaveBeenCalledOnce();
    },
  );

  it("does not launch when a cancelled provider wait resolves successfully", async () => {
    const { login, connected, onLaunch } = expiredLauncher();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Reconnect" }));
    await user.click(await screen.findByRole("button", { name: "Cancel sign-in" }));
    await act(async () => login.resolve(connected));
    expect(onLaunch).not.toHaveBeenCalled();
    expect(runtime.client.cancelCodexLogin).toHaveBeenCalledWith("codex-b-login");
  });

  it("keeps reconnect available after provider authentication fails", async () => {
    const { login, onLaunch } = expiredLauncher();
    await userEvent.setup().click(await screen.findByRole("button", { name: "Reconnect" }));
    await act(async () =>
      login.reject({
        category: "authentication",
        code: "login_failed",
        message: "Provider rejected this sign-in",
        retryable: true,
      }),
    );
    expect(onLaunch).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByRole("button", { name: "Reconnect" })).toBeEnabled());
    expect(screen.getByText("Provider rejected this sign-in")).toBeVisible();
  });

  it("does not launch after the launcher closes during authentication", async () => {
    const { login, connected, onLaunch, view } = expiredLauncher();
    await userEvent.setup().click(await screen.findByRole("button", { name: "Reconnect" }));
    await screen.findByRole("button", { name: "Cancel sign-in" });
    view.unmount();
    await act(async () => login.resolve(connected));
    expect(onLaunch).not.toHaveBeenCalled();
    expect(runtime.client.cancelCodexLogin).toHaveBeenCalledWith("codex-b-login");
  });

  it("does not launch if provider authentication returns a different account", async () => {
    const { login, connected, onLaunch } = expiredLauncher();
    await userEvent.setup().click(await screen.findByRole("button", { name: "Reconnect" }));
    await act(async () => login.resolve({ ...connected, id: "codex-a" }));
    expect(onLaunch).not.toHaveBeenCalled();
    expect(screen.getByText(/The connected account did not match/)).toBeVisible();
  });

  it("retries only the unfinished agents after a partial batch", async () => {
    const account = makeAccount("codex-b", "Codex B", true, "codex");
    runtime.client = clientWith([account], async () => threadOptions(["codex"]));
    const onLaunch = vi.fn().mockResolvedValueOnce(1).mockResolvedValueOnce(2);
    const onClose = vi.fn();
    render(dialog({ offered: ["codex"], initialProvider: "codex", onLaunch, onClose }));
    const user = userEvent.setup();
    await screen.findByRole("option", { name: /Codex B/ });
    await user.clear(screen.getByRole("spinbutton", { name: "Agents" }));
    await user.type(screen.getByRole("spinbutton", { name: "Agents" }), "3");
    await user.click(screen.getByRole("button", { name: "Launch 3 Codex agents" }));
    expect(onClose).not.toHaveBeenCalled();
    await user.click(await screen.findByRole("button", { name: "Launch 2 Codex agents" }));
    expect(onLaunch.mock.calls.map(([spec]) => spec.count)).toEqual([3, 2]);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("reconnects after genuine expiry in a partial batch and creates only its remaining agents", async () => {
    const connected = makeAccount("codex-b", "Codex B", true, "codex");
    let current = connected;
    runtime.client = {
      ...clientWith([current], async () => threadOptions(["codex"])),
      listProviderAccounts: vi.fn(async () => [current]),
      startCodexLogin: vi.fn(async () => ({ loginHandle: "reconnect-b" })),
      waitForCodexLogin: vi.fn(async () => {
        current = connected;
        return connected;
      }),
      cancelCodexLogin: vi.fn(async () => undefined),
    } as unknown as KalCodeClient;
    const onLaunch = vi
      .fn()
      .mockImplementationOnce(async () => {
        current = { ...connected, authenticationState: "not_authenticated" };
        return 1;
      })
      .mockResolvedValueOnce(2);
    const onClose = vi.fn();
    render(dialog({ offered: ["codex"], initialProvider: "codex", onLaunch, onClose }));
    const user = userEvent.setup();
    await screen.findByRole("option", { name: /Codex B/ });
    await user.clear(screen.getByRole("spinbutton", { name: "Agents" }));
    await user.type(screen.getByRole("spinbutton", { name: "Agents" }), "3");
    await user.click(screen.getByRole("button", { name: "Launch 3 Codex agents" }));
    await user.click(await screen.findByRole("button", { name: "Reconnect" }));
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(onLaunch.mock.calls.map(([spec]) => [spec.providerAccountId, spec.count])).toEqual([
      ["codex-b", 3],
      ["codex-b", 2],
    ]);
  });
});

describe("Cursor native runtime models", () => {
  const cursor = makeAccount("cursor-native", "Cursor A", true, "cursor");
  const mountCursor = (discovery: () => Promise<unknown>, initial = cursor, shared = false) => {
    const discover = vi.fn(discovery);
    runtime.client = {
      listProviderAccounts: vi.fn(async () => [initial]),
      listProviderAccountBindings: vi.fn(async () => []),
      threadOptions: vi.fn(async () => ({ providers: [] })),
      refreshCursorAccount: discover,
      providerAccountModels: vi.fn(async (accountId: string) => {
        const state = (await discover()) as {
          account: ProviderAccount;
          models: { id: string; displayName: string; isDefault: boolean }[];
          modelsError: string | null;
        };
        if (state.modelsError) throw new Error(state.modelsError);
        return {
          accountId,
          providerId: state.account.providerId,
          models: state.models.map((model) => ({ ...model, defaultEffort: null, supportedEfforts: [] })),
        };
      }),
    } as unknown as KalCodeClient;
    const onLaunch = vi.fn(async () => true);
    const launcher = (
      <NewAgentDialog
        workspace={{ id: "ws", name: "Project" } as Workspace}
        offered={[]}
        initialProvider="cursor"
        busy={false}
        error={null}
        onLaunch={onLaunch}
        onClose={vi.fn()}
      />
    );
    render(shared ? <ProviderAccountSessionsProvider>{launcher}</ProviderAccountSessionsProvider> : launcher);
    return onLaunch;
  };

  it.each([false, true])(
    "keeps restored native sign-in launchable during model discovery (shared=%s)",
    async (shared) => {
      const pending = deferred<unknown>();
      const onLaunch = mountCursor(() => pending.promise, cursor, shared);
      const launch = await screen.findByRole("button", { name: "Launch Cursor agent" });
      await waitFor(() => expect(launch).toBeEnabled());
      pending.resolve({ account: { ...cursor }, models: [], modelsError: null });
      await waitFor(() => expect(launch).toBeEnabled());
      await userEvent.setup().click(launch);
      expect(onLaunch).toHaveBeenCalledWith(
        expect.objectContaining({ providerAccountId: cursor.id, providerId: "cursor" }),
      );
      if (shared) expect(runtime.client.providerAccountModels).toHaveBeenCalledTimes(1);
      else expect(runtime.client.refreshCursorAccount).toHaveBeenCalledTimes(1);
    },
  );

  it("disables launch when native discovery confirms the saved sign-in expired", async () => {
    mountCursor(async () => ({
      account: { ...cursor, authenticationState: "not_authenticated" },
      models: [],
      modelsError: "Cursor session expired. Reconnect.",
    }));
    await waitFor(() => expect(screen.getByRole("option", { name: /Cursor A/ })).toHaveTextContent("Signed out"));
    expect(screen.getByRole("button", { name: "Launch Cursor agent" })).toBeDisabled();
    expect(runtime.client.refreshCursorAccount).toHaveBeenCalledTimes(1);
  });

  it("launches a real Cursor pane request with the exact runtime model id and account", async () => {
    const exact = "custom/deepseek-v9?reasoning=high";
    const onLaunch = mountCursor(async () => ({
      account: cursor,
      models: [{ id: exact, displayName: exact, isDefault: false }],
      modelsError: null,
    }));
    const user = userEvent.setup();
    await user.click(await screen.findByRole("radio", { name: exact }));
    expect(screen.queryByRole("radiogroup", { name: "Effort" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Launch Cursor agent" }));
    expect(onLaunch).toHaveBeenCalledWith({
      providerId: "cursor",
      providerAccountId: cursor.id,
      model: exact,
      effort: null,
      count: 1,
    });
  });

  it("does not invent models when discovery fails and keeps native default launch available", async () => {
    const onLaunch = mountCursor(async () => {
      throw {
        code: "cursor_models_unavailable",
        category: "provider",
        message: "Cursor model discovery unavailable.",
        retryable: true,
      };
    });
    expect(await screen.findByText(/Cursor model discovery unavailable/)).toBeVisible();
    expect(screen.getAllByRole("radio")).toHaveLength(1);
    await userEvent.setup().click(screen.getByRole("button", { name: "Launch Cursor agent" }));
    expect(onLaunch).toHaveBeenCalledWith(expect.objectContaining({ providerId: "cursor", model: null }));
  });

  it("preserves the exact remembered Cursor model when model metadata is unavailable", async () => {
    const entry = {
      providerId: "cursor",
      accountId: cursor.id,
      model: "custom/code-v9",
      count: 1,
      workspaceId: "ws",
      boundAccountId: null,
    };
    window.localStorage.setItem(
      "kalcode.agentLauncher.v1",
      JSON.stringify({ last: entry, byProvider: { cursor: entry } }),
    );
    const onLaunch = mountCursor(async () => ({ account: cursor, models: [], modelsError: "Models unavailable" }));
    const model = await screen.findByRole("radio", { name: "custom/code-v9" });
    expect(model).toBeChecked();
    await userEvent.setup().click(screen.getByRole("button", { name: "Launch Cursor agent" }));
    expect(onLaunch).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ providerAccountId: cursor.id, model: "custom/code-v9" }),
    );
  });

  it("refuses a remembered model that the runtime no longer offers instead of changing it silently", async () => {
    const entry = {
      providerId: "cursor",
      accountId: cursor.id,
      model: "retired-model-7",
      modelName: "retired-model-7",
      effort: null,
      count: 1,
      workspaceId: "ws",
      boundAccountId: null,
      at: "2026-10-04T00:00:00Z",
    };
    window.localStorage.setItem(
      "kalcode.agentLauncher.v1",
      JSON.stringify({ last: entry, byProvider: { cursor: entry } }),
    );
    const onLaunch = mountCursor(async () => ({
      account: cursor,
      models: [{ id: "current-model-8", displayName: "current-model-8", isDefault: false }],
      modelsError: null,
    }));
    expect(await screen.findByText(/Model unavailable for this account: retired-model-7/)).toBeVisible();
    expect(screen.getByRole("button", { name: "Launch Cursor agent" })).toBeDisabled();
    expect(onLaunch).not.toHaveBeenCalled();
    await userEvent.setup().click(screen.getByRole("radio", { name: "current-model-8" }));
    expect(screen.getByRole("button", { name: "Launch Cursor agent" })).toBeEnabled();
  });
});
