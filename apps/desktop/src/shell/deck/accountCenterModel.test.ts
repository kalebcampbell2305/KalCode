import type { ProviderAccount, ThreadSummary } from "@kalcode/protocol";
import { describe, expect, it } from "vitest";
import { accountCenterStatus, focusedAccountSession, selectedLaunchAccount } from "./accountCenterModel.ts";

const account = (id: string, extra: Partial<ProviderAccount> = {}): ProviderAccount => ({
  id,
  providerId: "codex",
  displayName: id,
  providerReportedIdentity: null,
  authenticationState: "authenticated",
  isDefault: false,
  createdAt: "2026-10-03",
  lastUsedAt: null,
  lastCheckedAt: null,
  lastErrorCode: null,
  archivedAt: null,
  ...extra,
});

describe("account center truth", () => {
  it("never derives quota or plan from local activity or sign-in", () => {
    expect(accountCenterStatus(account("A"))).toEqual({ label: "Ready", tone: "healthy" });
    expect(accountCenterStatus(account("A", { authenticationState: "not_authenticated" }))).toEqual({
      label: "Signed out",
      tone: "danger",
    });
    expect(accountCenterStatus(account("A", { authenticationState: "unknown" }))).toEqual({
      label: "Not checked",
      tone: "attention",
    });
    expect(accountCenterStatus(account("A"), false, "Network unavailable")).toEqual({
      label: "Needs attention",
      tone: "attention",
    });
  });

  it("uses workspace selection before provider default without inventing a global active account", () => {
    const accounts = [account("A", { isDefault: true }), account("B")];
    const bindings = [{ providerId: "codex", kind: "workspace" as const, scopeId: "w", accountId: "B" }];
    expect(selectedLaunchAccount(accounts, bindings, "codex", "w")?.id).toBe("B");
    expect(selectedLaunchAccount(accounts, bindings, "codex", "other")?.id).toBe("A");
    expect(selectedLaunchAccount([account("A"), account("B")], [], "codex", "w")?.id).toBe("A");
    expect(
      selectedLaunchAccount(
        [account("A", { authenticationState: "not_authenticated" }), account("B")],
        [],
        "codex",
        "w",
      )?.id,
    ).toBe("B");
    expect(selectedLaunchAccount(accounts, bindings, "claude-code", "w")).toBeNull();
  });

  it("does not describe another workspace or a shell as the selected agent", () => {
    const agent = {
      id: "a",
      runtimeKind: "interactive_pty",
      workspaceId: "w",
      terminalId: "pty",
      providerAccountId: "A",
    } as ThreadSummary;
    const code = { workspaceId: "w", content: { kind: "agent" as const, agentId: "a" } };
    expect(focusedAccountSession([agent], "code", "w", code, null)).toBe(agent);
    expect(focusedAccountSession([agent], "code", "other", code, null)).toBeNull();
    expect(
      focusedAccountSession(
        [agent],
        "code",
        "w",
        { workspaceId: "w", content: { kind: "terminal", terminalId: "shell" } },
        null,
      ),
    ).toBeNull();
    expect(focusedAccountSession([agent], "dashboard", "w", code, null)).toBeNull();
    expect(focusedAccountSession([agent], "code", "w", { workspaceId: "w", content: null }, null)).toBeNull();
  });
});
