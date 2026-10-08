import type { LaunchRecipe, ProviderAccount, RecipeComponent, RecipeVariable, Workspace } from "@kalcode/protocol";
import { describe, expect, it } from "vitest";
import {
  duplicateRecipe,
  launchesImmediately,
  launchValues,
  preflightRecipe,
  type RecipeEnvironment,
  referencedVariables,
  resolveRecipeQuery,
  safeRecipeUrl,
  sortRecipes,
  substitute,
} from "./model.ts";

function workspace(overrides: Partial<Workspace> = {}): Workspace {
  return {
    id: "w1",
    name: "KalCode",
    rootPath: "C:/code/kalcode",
    displayPath: "~/code/kalcode",
    createdAt: "2026-10-01T00:00:00Z",
    lastOpenedAt: "2026-10-01T00:00:00Z",
    activeTerminalId: null,
    available: true,
    ...overrides,
  };
}

function account(overrides: Partial<ProviderAccount> = {}): ProviderAccount {
  return {
    id: "a1",
    providerId: "claude-code",
    displayName: "Work",
    providerReportedIdentity: null,
    authenticationState: "authenticated",
    isDefault: false,
    createdAt: "2026-10-01T00:00:00Z",
    lastUsedAt: null,
    lastCheckedAt: null,
    lastErrorCode: null,
    archivedAt: null,
    ...overrides,
  };
}

function recipe(overrides: Partial<LaunchRecipe> = {}): LaunchRecipe {
  return {
    id: "r1",
    name: "Morning desk",
    schemaVersion: 1,
    workspaceId: null,
    pinned: false,
    position: 0,
    variables: [],
    components: [],
    layout: null,
    updatedAt: "2026-10-01T00:00:00Z",
    ...overrides,
  };
}

type AgentComponent = Extract<RecipeComponent, { kind: "agent" }>;

function agent(key: string, overrides: Partial<AgentComponent> = {}): AgentComponent {
  return {
    kind: "agent",
    key,
    providerId: "claude-code",
    providerAccountId: null,
    model: null,
    effort: null,
    name: null,
    task: null,
    ...overrides,
  };
}

function variable(key: string, defaultValue: string, askAtLaunch = false): RecipeVariable {
  return { key, label: key, defaultValue, askAtLaunch };
}

function env(overrides: Partial<RecipeEnvironment> = {}): RecipeEnvironment {
  const accounts = overrides.accounts ?? [account()];
  return {
    activeWorkspaceId: "w1",
    workspaces: [workspace()],
    accounts,
    agentProviders: ["claude-code", "codex"],
    squadIds: new Set(["s1"]),
    defaultAccount: (providerId) => accounts.find((a) => a.providerId === providerId && !a.archivedAt) ?? null,
    ...overrides,
  };
}

describe("substitute", () => {
  it("replaces known keys, including spaced braces", () => {
    expect(substitute("git checkout {{branch}}", { branch: "dev" })).toBe("git checkout dev");
    expect(substitute("hi {{ name }}", { name: "Kal" })).toBe("hi Kal");
  });

  it("keeps unknown keys visible", () => {
    expect(substitute("run {{missing}} now", { branch: "dev" })).toBe("run {{missing}} now");
  });

  it("replaces a known key with an empty value as empty", () => {
    expect(substitute("[{{task}}]", { task: "" })).toBe("[]");
  });

  it("ignores keys that are not valid variable keys", () => {
    expect(substitute("{{Branch}} {{1x}}", { Branch: "a", "1x": "b" })).toBe("{{Branch}} {{1x}}");
  });
});

describe("referencedVariables", () => {
  it("collects keys from every templated field in first-use order, without duplicates", () => {
    const keys = referencedVariables(
      recipe({
        components: [
          agent("a", { name: "{{branch}}", task: "fix {{ticket}}" }),
          { kind: "terminal", key: "t", name: null, command: "git checkout {{branch}}" },
          { kind: "browser", key: "b", url: "https://example.com/{{page}}" },
          { kind: "service", key: "s", name: "api", command: "serve --port {{port}}" },
          { kind: "squad", key: "q", squadId: "s1", goal: "ship {{ticket}}" },
          { kind: "widget", key: "w", widget: "{{ignored}}" },
        ],
      }),
    );
    expect(keys).toEqual(["branch", "ticket", "page", "port"]);
  });

  it("returns an empty list when nothing is templated", () => {
    expect(referencedVariables(recipe({ components: [agent("a", { task: "plain" })] }))).toEqual([]);
  });
});

describe("launchValues", () => {
  it("uses defaults when there are no overrides", () => {
    expect(launchValues([variable("branch", "main")])).toEqual({ branch: "main" });
  });

  it("overlays per-launch overrides on defaults", () => {
    expect(launchValues([variable("branch", "main"), variable("url", "https://a.dev")], { branch: "dev" })).toEqual({
      branch: "dev",
      url: "https://a.dev",
    });
  });

  it("ignores overrides for keys the Recipe does not declare", () => {
    expect(launchValues([variable("branch", "main")], { other: "x" })).toEqual({ branch: "main" });
  });
});

describe("safeRecipeUrl", () => {
  it.each(["https://example.com", "http://localhost:3000/path?x=1"])("accepts %s", (url) => {
    expect(safeRecipeUrl(url)).not.toBeNull();
  });

  it("normalizes and trims accepted addresses", () => {
    expect(safeRecipeUrl("  https://example.com  ")).toBe("https://example.com/");
  });

  it("rejects non-HTTP(S) schemes", () => {
    expect(safeRecipeUrl("ftp://example.com/file")).toBeNull();
    expect(safeRecipeUrl("javascript:alert(1)")).toBeNull();
  });

  it("rejects unparseable input", () => {
    expect(safeRecipeUrl("not a url")).toBeNull();
    expect(safeRecipeUrl("")).toBeNull();
  });

  it("rejects embedded credentials", () => {
    expect(safeRecipeUrl("https://user:pass@example.com")).toBeNull();
    expect(safeRecipeUrl("https://user@example.com")).toBeNull();
  });

  it.each(["token", "api_key", "code"])("rejects a sign-in parameter named %s", (key) => {
    expect(safeRecipeUrl(`https://example.com/?${key}=abc`)).toBeNull();
  });
});

describe("preflightRecipe", () => {
  it("reports a missing project as a non-skippable blocker", () => {
    const result = preflightRecipe(recipe(), env({ activeWorkspaceId: null, workspaces: [] }));
    expect(result.workspace).toBeNull();
    expect(result.blockers).toEqual([
      expect.objectContaining({
        componentKey: null,
        title: "No project to launch in",
        skippable: false,
        repair: { kind: "open-project", workspaceId: null },
      }),
    ]);
  });

  it("reports a Recipe's removed project with its id in the repair", () => {
    const result = preflightRecipe(recipe({ workspaceId: "gone" }), env());
    expect(result.blockers[0]).toEqual(
      expect.objectContaining({ skippable: false, repair: { kind: "open-project", workspaceId: "gone" } }),
    );
  });

  it("reports an unavailable project as a non-skippable blocker", () => {
    const result = preflightRecipe(recipe(), env({ workspaces: [workspace({ available: false })] }));
    expect(result.blockers).toEqual([
      expect.objectContaining({
        componentKey: null,
        title: "KalCode is unavailable",
        skippable: false,
        repair: { kind: "open-project", workspaceId: null },
      }),
    ]);
  });

  it("blocks an agent whose provider cannot run as a coding terminal, and skips it", () => {
    const result = preflightRecipe(recipe({ components: [agent("a", { providerId: "cursor" })] }), env());
    expect(result.plan).toEqual([]);
    expect(result.blockers).toEqual([
      expect.objectContaining({
        componentKey: "a",
        title: "Cursor agent can't start",
        skippable: true,
        repair: { kind: "edit" },
      }),
    ]);
  });

  it("asks to choose an account when the saved account was removed", () => {
    const result = preflightRecipe(recipe({ components: [agent("a", { providerAccountId: "gone" })] }), env());
    expect(result.blockers).toEqual([
      expect.objectContaining({
        componentKey: "a",
        title: "Claude Code agent: account removed",
        skippable: true,
        repair: { kind: "choose-account", providerId: "claude-code" },
      }),
    ]);
  });

  it("treats an archived saved account as removed", () => {
    const result = preflightRecipe(
      recipe({ components: [agent("a", { providerAccountId: "a1" })] }),
      env({ accounts: [account({ archivedAt: "2026-10-02T00:00:00Z" })] }),
    );
    expect(result.blockers[0]).toEqual(
      expect.objectContaining({ repair: { kind: "choose-account", providerId: "claude-code" } }),
    );
  });

  it("asks to choose an account when none is signed in and none is saved", () => {
    const result = preflightRecipe(recipe({ components: [agent("a")] }), env({ accounts: [] }));
    expect(result.blockers[0]).toEqual(
      expect.objectContaining({
        title: "Claude Code agent: choose an account",
        repair: { kind: "choose-account", providerId: "claude-code" },
      }),
    );
  });

  it("asks to reconnect an account the provider reported as signed out", () => {
    const result = preflightRecipe(
      recipe({ components: [agent("a")] }),
      env({ accounts: [account({ authenticationState: "not_authenticated" })] }),
    );
    expect(result.plan).toEqual([]);
    expect(result.blockers).toEqual([
      expect.objectContaining({
        componentKey: "a",
        title: "Work needs to reconnect",
        skippable: true,
        repair: { kind: "reconnect", providerId: "claude-code", accountId: "a1" },
      }),
    ]);
  });

  it("never blocks on an account whose state is unknown", () => {
    const result = preflightRecipe(
      recipe({ components: [agent("a")] }),
      env({ accounts: [account({ authenticationState: "unknown" })] }),
    );
    expect(result.blockers).toEqual([]);
    expect(result.plan).toHaveLength(1);
  });

  it("uses the default account when providerAccountId is null", () => {
    const fallback = account({ id: "fallback", displayName: "Fallback", isDefault: true });
    const result = preflightRecipe(
      recipe({ components: [agent("a")] }),
      env({ accounts: [fallback], defaultAccount: () => fallback }),
    );
    expect(result.plan[0]).toEqual(expect.objectContaining({ kind: "agent", account: fallback }));
  });

  it("uses a per-launch account override over the saved account", () => {
    const saved = account({ id: "saved" });
    const chosen = account({ id: "chosen", displayName: "Chosen" });
    const result = preflightRecipe(
      recipe({ components: [agent("a", { providerAccountId: "saved" })] }),
      env({ accounts: [saved, chosen] }),
      { accounts: { a: "chosen" } },
    );
    expect(result.plan[0]).toEqual(expect.objectContaining({ account: chosen }));
  });

  it("ignores a per-launch account override that belongs to another provider", () => {
    const codex = account({ id: "codex-1", providerId: "codex" });
    const result = preflightRecipe(recipe({ components: [agent("a")] }), env({ accounts: [account(), codex] }), {
      accounts: { a: "codex-1" },
    });
    expect(result.blockers[0]).toEqual(
      expect.objectContaining({ repair: { kind: "choose-account", providerId: "claude-code" } }),
    );
  });

  it("leaves skipped components out of the plan and the blockers", () => {
    const result = preflightRecipe(
      recipe({
        components: [
          agent("a", { providerAccountId: "gone" }),
          { kind: "terminal", key: "t", name: null, command: "npm test" },
        ],
      }),
      env(),
      { skip: ["a"] },
    );
    expect(result.blockers).toEqual([]);
    expect(result.plan.map((part) => part.key)).toEqual(["t"]);
  });

  it("reports a squad as unavailable when squads are not on this plan", () => {
    const result = preflightRecipe(
      recipe({ components: [{ kind: "squad", key: "q", squadId: "s1", goal: null }] }),
      env({ squadIds: null }),
    );
    expect(result.blockers[0]).toEqual(expect.objectContaining({ title: "Squads aren't available", skippable: true }));
    expect(result.plan).toEqual([]);
  });

  it("reports a squad as removed when its id is missing", () => {
    const result = preflightRecipe(
      recipe({ components: [{ kind: "squad", key: "q", squadId: "nope", goal: null }] }),
      env(),
    );
    expect(result.blockers[0]).toEqual(expect.objectContaining({ title: "Squad removed", repair: { kind: "edit" } }));
    expect(result.plan).toEqual([]);
  });

  it("plans a squad that exists, with its goal filled", () => {
    const result = preflightRecipe(
      recipe({
        variables: [variable("ticket", "KC-1")],
        components: [{ kind: "squad", key: "q", squadId: "s1", goal: "Ship {{ticket}}" }],
      }),
      env(),
    );
    expect(result.blockers).toEqual([]);
    expect(result.plan).toEqual([{ kind: "squad", key: "q", label: "Squad", squadId: "s1", goal: "Ship KC-1" }]);
  });

  it("blocks a service with an empty command, and does not plan it", () => {
    const result = preflightRecipe(
      recipe({ components: [{ kind: "service", key: "s", name: "API", command: "   " }] }),
      env(),
    );
    expect(result.plan).toEqual([]);
    expect(result.blockers).toEqual([
      expect.objectContaining({
        componentKey: "s",
        title: "API has no command",
        skippable: true,
        repair: { kind: "edit" },
      }),
    ]);
  });

  it("fills variable templates in agent, terminal, service and browser parts", () => {
    const result = preflightRecipe(
      recipe({
        variables: [variable("branch", "main"), variable("port", "3000"), variable("page", "docs")],
        components: [
          agent("a", { name: "{{branch}} agent", task: "  review {{branch}}  " }),
          { kind: "terminal", key: "t", name: "shell", command: " git checkout {{branch}} " },
          { kind: "service", key: "s", name: "API {{port}}", command: "serve --port {{port}}" },
          { kind: "browser", key: "b", url: "https://example.com/{{page}}" },
        ],
      }),
      env(),
      { values: { branch: "dev", port: "8080" } },
    );
    expect(result.blockers).toEqual([]);
    expect(result.plan).toEqual([
      expect.objectContaining({ kind: "agent", name: "dev agent", task: "review dev" }),
      expect.objectContaining({ kind: "terminal", name: "shell", command: "git checkout dev" }),
      expect.objectContaining({ kind: "service", name: "API 8080", command: "serve --port 8080" }),
      expect.objectContaining({ kind: "browser", url: "https://example.com/docs" }),
    ]);
  });

  it("blocks a browser part whose filled address is unsafe", () => {
    const result = preflightRecipe(
      recipe({
        variables: [variable("token", "")],
        components: [{ kind: "browser", key: "b", url: "https://example.com/?token={{token}}" }],
      }),
      env(),
    );
    expect(result.plan).toEqual([]);
    expect(result.blockers[0]).toEqual(
      expect.objectContaining({ componentKey: "b", title: "example.com can't open", repair: { kind: "edit" } }),
    );
  });

  it("lists the variables the person is asked for", () => {
    const asked = variable("branch", "main", true);
    const result = preflightRecipe(recipe({ variables: [asked, variable("quiet", "x")], components: [] }), env());
    expect(result.ask).toEqual([asked]);
  });

  it("describes the consequences of six agents, a squad and services", () => {
    const components: RecipeComponent[] = [
      agent("a1"),
      agent("a2"),
      agent("a3"),
      agent("a4"),
      agent("a5"),
      agent("a6"),
      { kind: "squad", key: "q", squadId: "s1", goal: null },
      { kind: "service", key: "s1", name: "API", command: "serve" },
      { kind: "service", key: "s2", name: "Web", command: "dev" },
    ];
    const result = preflightRecipe(recipe({ components }), env());
    expect(result.consequences).toEqual([
      "Starts 6 coding agents",
      "Launches a Squad that queues its own agents",
      "Starts 2 Services",
    ]);
    expect(launchesImmediately(result)).toBe(false);
  });

  it("describes a single Service in the singular", () => {
    const result = preflightRecipe(
      recipe({ components: [{ kind: "service", key: "s", name: "API", command: "serve" }] }),
      env(),
    );
    expect(result.consequences).toEqual(["Starts a Service"]);
  });

  it("does not count five agents as a large launch", () => {
    const components = Array.from({ length: 5 }, (_, i) => agent(`a${i}`));
    const result = preflightRecipe(recipe({ components }), env());
    expect(result.plan).toHaveLength(5);
    expect(result.consequences).toEqual([]);
  });

  it("reports a newer schemaVersion as a non-skippable blocker", () => {
    const result = preflightRecipe(recipe({ schemaVersion: 2 }), env());
    expect(result.blockers).toEqual([
      expect.objectContaining({
        componentKey: null,
        title: "Made by a newer KalCode",
        skippable: false,
        repair: { kind: "edit" },
      }),
    ]);
  });
});

describe("launchesImmediately", () => {
  it("is true for a plain Recipe with nothing to ask, block or preview", () => {
    const result = preflightRecipe(
      recipe({ components: [{ kind: "terminal", key: "t", name: null, command: "npm test" }] }),
      env(),
    );
    expect(launchesImmediately(result)).toBe(true);
  });

  it("is false when a variable is asked at launch", () => {
    const result = preflightRecipe(recipe({ variables: [variable("branch", "main", true)] }), env());
    expect(launchesImmediately(result)).toBe(false);
  });

  it("is false when there is a blocker", () => {
    const result = preflightRecipe(recipe({ workspaceId: "gone" }), env());
    expect(launchesImmediately(result)).toBe(false);
  });

  it("is false when there is a consequence to preview", () => {
    const result = preflightRecipe(
      recipe({ components: [{ kind: "service", key: "s", name: "API", command: "serve" }] }),
      env(),
    );
    expect(launchesImmediately(result)).toBe(false);
  });
});

describe("sortRecipes", () => {
  it("orders pinned first, then position, then name", () => {
    const sorted = sortRecipes([
      recipe({ id: "1", name: "a", position: 1 }),
      recipe({ id: "2", name: "c", position: 0 }),
      recipe({ id: "3", name: "Z", pinned: true, position: 5 }),
      recipe({ id: "4", name: "b", position: 0 }),
    ]);
    expect(sorted.map((item) => item.name)).toEqual(["Z", "b", "c", "a"]);
  });

  it("breaks name ties case-insensitively", () => {
    const sorted = sortRecipes([
      recipe({ id: "1", name: "banana", position: 0 }),
      recipe({ id: "2", name: "Apple", position: 0 }),
    ]);
    expect(sorted.map((item) => item.name)).toEqual(["Apple", "banana"]);
  });

  it("does not mutate the input", () => {
    const input = [recipe({ id: "1", name: "b" }), recipe({ id: "2", name: "a" })];
    sortRecipes(input);
    expect(input.map((item) => item.id)).toEqual(["1", "2"]);
  });
});

describe("resolveRecipeQuery", () => {
  const recipes = [
    recipe({ id: "r1", name: "Morning desk" }),
    recipe({ id: "r2", name: "Frontend setup" }),
    recipe({ id: "r3", name: "Dev" }),
    recipe({ id: "r4", name: "dev" }),
    recipe({ id: "r5", name: "Desk two" }),
  ];

  it("finds a Recipe by exact id", () => {
    expect(resolveRecipeQuery(recipes, "r2")).toEqual({ kind: "found", recipe: recipes[1] });
  });

  it("finds a unique exact name case-insensitively", () => {
    expect(resolveRecipeQuery(recipes, "FRONTEND SETUP")).toEqual({ kind: "found", recipe: recipes[1] });
  });

  it("reports ambiguous exact names rather than guessing", () => {
    expect(resolveRecipeQuery(recipes, "dev")).toEqual({ kind: "ambiguous", matches: [recipes[2], recipes[3]] });
  });

  it("finds a unique partial name", () => {
    expect(resolveRecipeQuery(recipes, "frontend")).toEqual({ kind: "found", recipe: recipes[1] });
  });

  it("reports ambiguous partial names", () => {
    expect(resolveRecipeQuery(recipes, "desk")).toEqual({ kind: "ambiguous", matches: [recipes[0], recipes[4]] });
  });

  it("reports a missing Recipe, and treats a blank query as missing", () => {
    expect(resolveRecipeQuery(recipes, "nothing")).toEqual({ kind: "missing" });
    expect(resolveRecipeQuery(recipes, "   ")).toEqual({ kind: "missing" });
  });
});

describe("duplicateRecipe", () => {
  const original = recipe({
    id: "r1",
    name: "Morning",
    pinned: true,
    position: 3,
    components: [{ kind: "terminal", key: "t", name: null, command: "npm test" }],
    updatedAt: "2026-10-01T00:00:00Z",
  });

  it("names the copy 'X copy' with a fresh id, unpinned, at the given position", () => {
    const copy = duplicateRecipe(original, "r9", [original], 7);
    expect(copy).toEqual(
      expect.objectContaining({ id: "r9", name: "Morning copy", pinned: false, position: 7, updatedAt: "" }),
    );
    expect(copy.components).toEqual(original.components);
    expect(copy.components).not.toBe(original.components);
  });

  it("uses 'X copy 2' when 'X copy' is taken, case-insensitively", () => {
    const copy = duplicateRecipe(original, "r9", [original, recipe({ id: "r2", name: "MORNING COPY" })], 1);
    expect(copy.name).toBe("Morning copy 2");
  });

  it("keeps counting until the name is free", () => {
    const existing = [original, recipe({ id: "a", name: "Morning copy" }), recipe({ id: "b", name: "Morning copy 2" })];
    expect(duplicateRecipe(original, "r9", existing, 1).name).toBe("Morning copy 3");
  });

  it("does not modify the original Recipe", () => {
    duplicateRecipe(original, "r9", [original], 1);
    expect(original.name).toBe("Morning");
    expect(original.pinned).toBe(true);
  });

  it("appends ' copy' without truncating a name that still fits in 120 characters", () => {
    const long = recipe({ id: "r1", name: "x".repeat(100) });
    expect(duplicateRecipe(long, "r9", [long], 0).name).toBe(`${"x".repeat(100)} copy`);
  });
});

describe("recipe regressions", () => {
  it("never resolves inherited Object properties as variables", () => {
    expect(substitute("x {{constructor}} {{tostring}} y", {})).toBe("x {{constructor}} {{tostring}} y");
    const values = launchValues([{ key: "constructor", label: "c", defaultValue: "d", askAtLaunch: false }], {});
    expect(values.constructor).toBe("d");
  });

  it("duplicates a 120-character name to a distinct name that still fits", () => {
    const long = recipe({ id: "r1", name: "x".repeat(120) });
    const first = duplicateRecipe(long, "r2", [long], 1);
    expect(first.name).toHaveLength(120);
    expect(first.name.endsWith(" copy")).toBe(true);
    const second = duplicateRecipe(long, "r3", [long, first], 2);
    expect(second.name).toHaveLength(120);
    expect(second.name.endsWith(" copy 2")).toBe(true);
  });
});
