import type { ProviderAccount, ThreadOptions, Workspace } from "@kalcode/protocol";
import { ToastProvider } from "@kalcode/ui/components";
import { render as renderView, screen, waitFor, within } from "@testing-library/react";
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

const fresh = (accountId: string, remainingPercent: number, plan: string | null = null): AccountUsageState => ({
  accountId,
  status: "fresh",
  windows: [{ id: "five_hour", label: "5-hour", remainingPercent, resetsAt: null }],
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
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
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
    expect(within(options[0] as HTMLElement).getByText("owner@kalcode.dev")).toBeVisible();
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
    expect(optionA).toHaveTextContent(/Low/);
    expect(screen.getByRole("option", { name: /Claude B/ })).toHaveTextContent(/91% left.*Ready/);
    expect(screen.getByText("Claude A is running low. Use Claude B instead?")).toBeVisible();
    expect(optionA).toHaveAttribute("aria-selected", "true");
    await userEvent.setup().click(screen.getByRole("button", { name: "Use Claude B" }));
    expect(screen.getByRole("option", { name: /Claude B/ })).toHaveAttribute("aria-selected", "true");
  });

  it("never invents usage: unknown accounts say so", async () => {
    const a = makeAccount("claude-a", "Claude A", true);
    runtime.client = clientWith([a], async () => threadOptions(["claude-code"]));
    render(dialog({}));
    expect(await screen.findByRole("option", { name: /Claude A/ })).toHaveTextContent(/Not checked/);
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
  return {
    listProviderAccounts: vi.fn(async () => accounts),
    refreshClaudeAccount: vi.fn(),
    refreshCodexAccount: vi.fn(async (id: string) => accounts.find((a) => a.id === id)),
    refreshGeminiAccount: vi.fn(),
    listProviderAccountBindings: vi.fn(async () => bindings),
    threadOptions: vi.fn(options),
  } as unknown as KalCodeClient;
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
