import type { ProviderAccount, ThreadOptions, Workspace } from "@kalcode/protocol";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { KalCodeClient } from "../../ipc/client.ts";
import { ProviderAccountSessionsProvider } from "../providers/ProviderAccountSessions.tsx";
import { NewAgentDialog } from "./NewAgentDialog.tsx";

const runtime = vi.hoisted(() => ({ client: null as unknown as KalCodeClient }));
vi.mock("../../runtime/RuntimeProvider.tsx", () => ({ useRuntime: () => runtime }));

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

    const account = await screen.findByRole("combobox", { name: "Account" });
    expect(screen.getByRole("button", { name: "Launch Codex agent" })).toBeEnabled();
    await userEvent.setup().selectOptions(account, codexB.id);
    expect(account).toHaveValue(codexB.id);

    checks.get(codexA.id)?.resolve({ ...codexA, lastCheckedAt: "2026-10-02T00:00:00.000Z" });
    checks.get(codexB.id)?.resolve({ ...codexB, lastCheckedAt: "2026-10-02T00:00:00.000Z" });
    await waitFor(() => expect(account).toHaveValue(codexB.id));

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

    await screen.findByText(/Claude A/);
    const codexChoice = screen.getByRole("radio", { name: "Codex" });
    const form = screen.getByRole("form", { name: "New agent" }) as HTMLFormElement;
    const observer = new MutationObserver(() => {
      if (codexChoice.getAttribute("aria-checked") !== "true") return;
      observer.disconnect();
      form.requestSubmit();
    });
    observer.observe(codexChoice, { attributes: true, attributeFilter: ["aria-checked"] });

    await userEvent.setup().click(codexChoice);
    await waitFor(() =>
      expect(onLaunch).toHaveBeenCalledWith(
        expect.objectContaining({ providerId: "codex", providerAccountId: codex.id }),
      ),
    );
  });
});
