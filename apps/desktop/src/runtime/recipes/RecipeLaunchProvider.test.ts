import type { LaunchRecipe, ProviderAccount, ProviderAccountBinding, Workspace } from "@kalcode/protocol";
import { render, waitFor } from "@testing-library/react";
import { createElement, useEffect, useRef } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LaunchMemory, RememberedLaunch } from "../../surfaces/code/panes/agentLaunch.ts";
import {
  type RecipeRequestResult,
  RecipesProvider,
  resolveRecipeDefaultAccount,
  useRecipeLaunch,
} from "./RecipeLaunchProvider.tsx";

const providerSeams = vi.hoisted(() => ({
  client: null as unknown as Record<string, unknown>,
  workspaces: null as unknown as Record<string, unknown>,
  navigation: { navigate: vi.fn() },
  toast: vi.fn(),
}));

vi.mock("@kalcode/ui/components", () => ({ useToast: () => ({ show: providerSeams.toast }) }));
vi.mock("../RuntimeProvider.tsx", () => ({ useRuntime: () => ({ client: providerSeams.client }) }));
vi.mock("../WorkspaceProvider.tsx", () => ({ useWorkspaces: () => providerSeams.workspaces }));
vi.mock("../../shell/navigation.tsx", () => ({ useNavigation: () => providerSeams.navigation }));
vi.mock("./useRecipeCapture.ts", () => ({ useRecipeCapture: () => undefined }));

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

function LaunchProbe({ onResult }: { onResult: (result: RecipeRequestResult) => void }) {
  const { request } = useRecipeLaunch();
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void request({ recipeId: "recipe-boundary" }, { quiet: true }).then(onResult);
  }, [onResult, request]);
  return null;
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

describe("RecipesProvider account binding authority", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const workspace: Workspace = {
      id: "project-b",
      name: "Project B",
      rootPath: "C:/code/project-b",
      displayPath: "~/code/project-b",
      createdAt: "2026-10-01T00:00:00Z",
      lastOpenedAt: "2026-10-01T00:00:00Z",
      activeTerminalId: null,
      available: true,
    };
    const recipe: LaunchRecipe = {
      id: "recipe-boundary",
      name: "Bound account desk",
      schemaVersion: 1,
      workspaceId: workspace.id,
      pinned: false,
      position: 0,
      variables: [],
      components: [
        {
          kind: "agent",
          key: "agent-1",
          providerId: "claude-code",
          providerAccountId: null,
          model: null,
          effort: null,
          name: null,
          task: null,
        },
      ],
      layout: null,
      updatedAt: "2026-10-01T00:00:00Z",
    };
    providerSeams.workspaces = {
      active: workspace,
      activate: vi.fn(async () => true),
      openFolder: vi.fn(async () => null),
      createTerminal: vi.fn(async () => null),
    };
    providerSeams.client = {
      recipes: {
        snapshot: vi.fn(async () => ({ recipes: [recipe], limit: null })),
      },
      listWorkspaces: vi.fn(async () => [workspace]),
      listProviderAccounts: vi.fn(async () => [account("account-a", true), account("account-b")]),
      listProviders: vi.fn(async () => []),
      listProviderAccountBindings: vi.fn(async () => {
        throw new Error("Workspace account bindings are unavailable.");
      }),
      listThreads: vi.fn(async () => []),
      squads: { snapshot: vi.fn(async () => ({ squads: [] })) },
      transport: {
        invoke: vi.fn(async (command: string) =>
          command === "provider_pane_create" ? { id: "created-with-wrong-account" } : undefined,
        ),
      },
    };
  });

  it("does not create an implicit-account agent when workspace bindings cannot be read", async () => {
    const onResult = vi.fn<(result: RecipeRequestResult) => void>();

    render(createElement(RecipesProvider, null, createElement(LaunchProbe, { onResult })));

    await waitFor(() => expect(onResult).toHaveBeenCalledTimes(1));
    expect(onResult).toHaveBeenCalledWith(
      expect.objectContaining({
        ok: false,
        launched: false,
        message: expect.stringMatching(/couldn't be prepared/i),
      }),
    );
    const invoke = (providerSeams.client as { transport: { invoke: ReturnType<typeof vi.fn> } }).transport.invoke;
    expect(invoke).not.toHaveBeenCalledWith("provider_pane_create", expect.anything());
  });
});
