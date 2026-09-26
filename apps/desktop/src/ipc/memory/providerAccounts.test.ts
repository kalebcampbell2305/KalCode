import { describe, expect, it } from "vitest";
import { KalCodeClient } from "../client.ts";
import { createMemoryTransport } from "../memoryTransport.ts";

const client = () => new KalCodeClient(createMemoryTransport("default", { detectDelayMs: 0 }));

describe("provider account memory contract", () => {
  it("lists active accounts and supports the credential-free metadata lifecycle", async () => {
    const api = client();
    const initial = await api.listProviderAccounts("codex");
    expect(initial.map((account) => [account.displayName, account.isDefault])).toEqual([
      ["Personal", true],
      ["Work", false],
    ]);

    const created = await api.createProviderAccount("codex", "Side project");
    expect(created).toMatchObject({
      providerId: "codex",
      displayName: "Side project",
      authenticationState: "unknown",
      isDefault: false,
    });

    const renamed = await api.renameProviderAccount(created.id, "Open source");
    expect(renamed.displayName).toBe("Open source");
    const selected = await api.setDefaultProviderAccount(created.id);
    expect(selected.isDefault).toBe(true);
    expect(
      (await api.listProviderAccounts("codex")).find((account) => account.displayName === "Personal")?.isDefault,
    ).toBe(false);

    const archived = await api.archiveProviderAccount(created.id);
    expect(archived.archivedAt).not.toBeNull();
    expect((await api.listProviderAccounts("codex")).some((account) => account.id === created.id)).toBe(false);
  });

  it("uses an opaque login handle and updates only native account metadata", async () => {
    const api = client();
    const account = (await api.listProviderAccounts("codex")).find(
      (candidate) => candidate.authenticationState === "not_authenticated",
    );
    expect(account).toBeDefined();

    const login = await api.startCodexLogin(account?.id ?? "");
    expect(login.loginHandle).toMatch(/^login-/);
    expect(Object.keys(login)).toEqual(["loginHandle"]);
    const authenticated = await api.waitForCodexLogin(login.loginHandle);
    expect(authenticated).toMatchObject({ id: account?.id, authenticationState: "authenticated" });

    const signedOut = await api.logoutCodexAccount(authenticated.id);
    expect(signedOut.authenticationState).toBe("not_authenticated");
    const refreshed = await api.refreshCodexAccount(authenticated.id);
    expect(refreshed.id).toBe(authenticated.id);

    const claude = (await api.listProviderAccounts("claude-code"))[0];
    expect(claude).toBeDefined();
    const signedOutClaude = await api.logoutClaudeAccount(claude?.id ?? "");
    expect(signedOutClaude.authenticationState).toBe("not_authenticated");
    const claudeLogin = await api.startClaudeLogin(signedOutClaude.id);
    expect(Object.keys(claudeLogin)).toEqual(["loginHandle"]);
    const signedInClaude = await api.waitForClaudeLogin(claudeLogin.loginHandle);
    expect(signedInClaude.authenticationState).toBe("authenticated");
    expect((await api.refreshClaudeAccount(signedInClaude.id)).lastCheckedAt).not.toBeNull();
  });

  it("rejects invalid providers, duplicate labels and provider-mismatched auth", async () => {
    const api = client();
    await expect(api.createProviderAccount("Bad Provider", "Personal")).rejects.toMatchObject({
      code: "provider_account_provider_invalid",
    });
    await expect(api.createProviderAccount("codex", " personal ")).rejects.toMatchObject({
      code: "provider_account_label_exists",
    });
    const claude = (await api.listProviderAccounts("claude-code"))[0];
    await expect(api.startCodexLogin(claude?.id ?? "")).rejects.toMatchObject({
      code: "provider_account_mismatch",
    });
    const codex = (await api.listProviderAccounts("codex"))[0];
    await expect(api.startClaudeLogin(codex?.id ?? "")).rejects.toMatchObject({
      code: "provider_account_mismatch",
    });
  });
});
