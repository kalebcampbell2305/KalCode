import type { ProviderAccount, ProviderAccountBinding } from "@kalcode/protocol";
import { describe, expect, it } from "vitest";
import type { LaunchMemory, RememberedLaunch } from "../../surfaces/code/panes/agentLaunch.ts";
import { resolveRecipeDefaultAccount } from "./RecipeLaunchProvider.tsx";

function account(id: string, isDefault = false): ProviderAccount {
  return {
    id,
    providerId: "claude-code",
    displayName: id,
    providerReportedIdentity: null,
    authenticationState: "authenticated",
    isDefault,
    createdAt: "2026-10-01T00:00:00Z",
    lastUsedAt: null,
    lastCheckedAt: null,
    lastErrorCode: null,
    archivedAt: null,
  };
}

function remembered(workspaceId: string, accountId: string, boundAccountId: string | null = null): RememberedLaunch {
  return {
    providerId: "claude-code",
    workspaceId,
    accountId,
    boundAccountId,
    model: null,
    modelName: null,
    effort: null,
    count: 1,
    at: `2026-10-01T00:00:0${workspaceId === "project-a" ? "1" : "2"}Z`,
  };
}

function memory(...entries: RememberedLaunch[]): LaunchMemory {
  return {
    last: entries.at(-1) ?? null,
    byProvider: entries[0] ? { "claude-code": entries[0] } : {},
    byContext: Object.fromEntries(entries.map((entry, index) => [`entry-${index}`, entry])),
  };
}

describe("resolveRecipeDefaultAccount", () => {
  it("uses the Recipe target project's remembered account instead of the active project's", () => {
    const projectA = account("account-a", true);
    const projectB = account("account-b");
    const launchMemory = memory(remembered("project-a", projectA.id), remembered("project-b", projectB.id));

    expect(resolveRecipeDefaultAccount([projectA, projectB], [], launchMemory, "claude-code", "project-b")?.id).toBe(
      "account-b",
    );
  });

  it("does not replace a removed remembered account with another default", () => {
    const fallback = account("fallback", true);
    const launchMemory = memory(remembered("project-b", "removed-account"));

    expect(resolveRecipeDefaultAccount([fallback], [], launchMemory, "claude-code", "project-b")).toBeNull();
  });

  it("honors a newer explicit project binding over remembered launch state", () => {
    const oldAccount = account("old-account", true);
    const selectedAccount = account("selected-account");
    const bindings: ProviderAccountBinding[] = [
      {
        providerId: "claude-code",
        kind: "workspace",
        scopeId: "project-b",
        accountId: selectedAccount.id,
      },
    ];
    const launchMemory = memory(remembered("project-b", oldAccount.id, oldAccount.id));

    expect(
      resolveRecipeDefaultAccount([oldAccount, selectedAccount], bindings, launchMemory, "claude-code", "project-b")
        ?.id,
    ).toBe("selected-account");
  });
});
