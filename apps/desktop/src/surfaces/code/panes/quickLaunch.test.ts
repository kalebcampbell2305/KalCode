import type { ProviderAccount, ProviderAccountBinding } from "@kalcode/protocol";
import { describe, expect, it } from "vitest";
import type { LaunchMemory, ModelEffortInfo, RememberedLaunch } from "./agentLaunch.ts";
import type { PaneProviderId } from "./paneChannel.ts";
import { type QuickLaunchContext, resolveQuickLaunch } from "./quickLaunch.ts";

const account = (id: string, partial: Partial<ProviderAccount> = {}): ProviderAccount =>
  ({
    id,
    providerId: "claude-code",
    displayName: id,
    isDefault: false,
    authenticationState: "authenticated",
    archivedAt: null,
    ...partial,
  }) as ProviderAccount;

const remembered = (partial: Partial<RememberedLaunch> = {}): RememberedLaunch => ({
  providerId: "claude-code",
  accountId: "work",
  model: null,
  modelName: null,
  effort: null,
  count: 6,
  workspaceId: "ws",
  boundAccountId: null,
  at: "2026-10-05T00:00:00Z",
  ...partial,
});

const memoryOf = (...entries: RememberedLaunch[]): LaunchMemory => ({
  last: entries.at(-1) ?? null,
  byProvider: Object.fromEntries(entries.map((e) => [e.providerId, e])),
  byContext: Object.fromEntries(entries.map((e, index) => [String(index), e])),
});

const MODELS: Record<string, ModelEffortInfo[]> = {
  "claude-code": [
    {
      id: "claude-opus-5-5",
      displayName: "Opus 5.5",
      isDefault: true,
      supportedEfforts: ["low", "medium", "high", "xhigh", "max"],
    },
    {
      id: "claude-sonnet-5-5",
      displayName: "Sonnet 5.5",
      isDefault: false,
      supportedEfforts: ["low", "medium", "high", "xhigh", "max"],
    },
  ],
  codex: [
    {
      id: "gpt-6-codex",
      displayName: "GPT-6 Codex",
      isDefault: true,
      supportedEfforts: ["minimal", "low", "medium", "high", "xhigh"],
    },
  ],
};

function context(partial: Partial<QuickLaunchContext> = {}): QuickLaunchContext {
  return {
    accounts: [account("work")],
    bindings: [],
    workspaceId: "ws",
    memory: memoryOf(),
    providers: ["claude-code", "codex", "cursor"],
    usable: (a) => a.authenticationState !== "not_authenticated",
    modelsOf: (providerId: PaneProviderId) => MODELS[providerId] ?? null,
    ...partial,
  };
}

describe("one-click New agent", () => {
  it("launches the only valid configuration at once, as one agent", () => {
    const result = resolveQuickLaunch(context());
    expect(result).toEqual({
      kind: "ready",
      spec: { providerId: "claude-code", count: 1, providerAccountId: "work", model: null, effort: null },
      summary: "Claude Code · work · Opus 5.5 · claude-opus-5-5",
    });
  });

  it("repeats the remembered account, exact model and effort, but never the remembered count", () => {
    const ctx = context({
      accounts: [account("work"), account("personal")],
      memory: memoryOf(remembered({ accountId: "personal", model: "claude-sonnet-5-5", effort: "xhigh", count: 6 })),
    });
    const result = resolveQuickLaunch(ctx);
    expect(result.kind).toBe("ready");
    if (result.kind !== "ready") return;
    expect(result.spec).toEqual({
      providerId: "claude-code",
      count: 1,
      providerAccountId: "personal",
      model: "claude-sonnet-5-5",
      effort: "xhigh",
    });
    expect(result.summary).toBe("Claude Code · personal · Sonnet 5.5 · claude-sonnet-5-5 · Extra high");
  });

  it("uses only the exact project's account-specific model and effort preference", () => {
    const ctx = context({
      accounts: [account("work"), account("personal")],
      memory: memoryOf(
        remembered({
          workspaceId: "other-project",
          accountId: "work",
          model: "claude-opus-5-5",
          effort: "high",
        }),
        remembered({ accountId: "personal", model: "claude-sonnet-5-5", effort: "xhigh" }),
      ),
    });

    const result = resolveQuickLaunch(ctx);
    expect(result.kind === "ready" && result.spec).toMatchObject({
      providerAccountId: "personal",
      model: "claude-sonnet-5-5",
      effort: "xhigh",
    });
  });

  it("keeps an explicitly selected model id even when the account reports it as default", () => {
    const result = resolveQuickLaunch(
      context({ memory: memoryOf(remembered({ model: "claude-opus-5-5", modelName: "Opus 5.5" })) }),
    );
    expect(result.kind === "ready" && result.spec.model).toBe("claude-opus-5-5");
  });

  it("starts an explicit count of an explicit provider", () => {
    const ctx = context({ accounts: [account("work"), account("cx", { providerId: "codex" })] });
    const result = resolveQuickLaunch(ctx, { providerId: "codex", count: 6 });
    expect(result.kind === "ready" && result.spec).toEqual({
      providerId: "codex",
      count: 6,
      providerAccountId: "cx",
      model: null,
      effort: null,
    });
    expect(result.kind === "ready" && result.summary).toBe("6 × Codex · cx · GPT-6 Codex · gpt-6-codex");
  });

  it("never guesses between several accounts", () => {
    const ctx = context({ accounts: [account("work"), account("personal")] });
    expect(resolveQuickLaunch(ctx)).toEqual({
      kind: "choose",
      providerId: "claude-code",
      reason: "Choose which Claude Code account to use.",
    });
    // A default or the workspace's account is not a guess.
    const withDefault = context({ accounts: [account("work"), account("personal", { isDefault: true })] });
    expect(resolveQuickLaunch(withDefault).kind === "ready").toBe(true);
    const bindings: ProviderAccountBinding[] = [
      { providerId: "claude-code", kind: "workspace", scopeId: "ws", accountId: "work" },
    ];
    const bound = resolveQuickLaunch(context({ accounts: [account("work"), account("personal")], bindings }));
    expect(bound.kind === "ready" && bound.spec.providerAccountId).toBe("work");
  });

  it("never guesses between providers when nothing is remembered", () => {
    const ctx = context({ accounts: [account("work"), account("cx", { providerId: "codex" })] });
    expect(resolveQuickLaunch(ctx)).toEqual({ kind: "choose", reason: "Choose a provider and account." });
    const last = resolveQuickLaunch({ ...ctx, memory: memoryOf(remembered({ providerId: "codex", accountId: "cx" })) });
    expect(last.kind === "ready" && last.spec.providerId).toBe("codex");
  });

  it("asks when the remembered account signed out instead of switching accounts", () => {
    const ctx = context({
      accounts: [account("work", { authenticationState: "not_authenticated" }), account("personal")],
      memory: memoryOf(remembered({ accountId: "work" })),
    });
    expect(resolveQuickLaunch(ctx)).toEqual({
      kind: "choose",
      providerId: "claude-code",
      reason: "Claude Code · work needs to sign in again.",
    });
  });

  it.each([
    ["removed", [account("personal", { isDefault: true })]],
    ["archived", [account("work", { archivedAt: "2026-10-07T12:00:00Z" }), account("personal", { isDefault: true })]],
  ])("asks for an account when the remembered account was %s instead of switching identities", (_state, accounts) => {
    const ctx = context({ accounts, memory: memoryOf(remembered({ accountId: "work" })) });
    expect(resolveQuickLaunch(ctx)).toEqual({
      kind: "choose",
      providerId: "claude-code",
      reason: "The saved Claude Code account is no longer available. Choose another account.",
    });
  });

  it("asks when the remembered model is no longer offered, or the models aren't known yet", () => {
    const gone = context({
      memory: memoryOf(remembered({ model: "claude-retired-1", modelName: "Retired 1" })),
    });
    expect(resolveQuickLaunch(gone)).toMatchObject({
      kind: "choose",
      reason: "Retired 1 · claude-retired-1 isn't offered by this account any more.",
    });
    const unknown = context({ memory: memoryOf(remembered({ model: "claude-sonnet-5-5" })), modelsOf: () => null });
    expect(resolveQuickLaunch(unknown).kind).toBe("choose");
    expect(resolveQuickLaunch(context({ modelsOf: () => null }))).toMatchObject({
      kind: "choose",
      reason: "Checking which Claude Code models this account offers.",
    });
  });

  it("opens the chooser when the exact model no longer accepts the remembered effort", () => {
    const ctx = context({
      memory: memoryOf(remembered({ model: "claude-opus-5-5", effort: "high" })),
      modelsOf: () => [
        {
          id: "claude-opus-5-5",
          displayName: "Opus 5.5",
          isDefault: true,
          supportedEfforts: [],
        },
      ],
    });
    expect(resolveQuickLaunch(ctx)).toMatchObject({
      kind: "choose",
      reason: "High effort isn't available for Opus 5.5 · claude-opus-5-5.",
    });
  });

  it("preserves an exact remembered model when a documented alias list cannot verify its absence", () => {
    const exact = "custom/provider-model-v9";
    const result = resolveQuickLaunch(
      context({
        memory: memoryOf(remembered({ model: exact, modelName: exact, effort: "future" })),
        modelCatalogOf: () => ({
          models: MODELS["claude-code"] ?? [],
          source: "documented_aliases",
          supportedEfforts: ["medium"],
        }),
      }),
    );
    expect(result.kind === "ready" && result.spec).toMatchObject({ model: exact, effort: "future" });
  });

  it("uses catalog effort fallback including an explicitly empty capability", () => {
    const result = resolveQuickLaunch(
      context({
        memory: memoryOf(remembered({ model: "claude-opus-5-5", effort: "high" })),
        modelCatalogOf: () => ({
          models: [{ id: "claude-opus-5-5", displayName: "Opus 5.5", isDefault: true }],
          source: "runtime",
          status: "available",
          supportedEfforts: [],
        }),
      }),
    );
    expect(result).toMatchObject({
      kind: "choose",
      reason: "High effort isn't available for Opus 5.5 · claude-opus-5-5.",
    });
  });

  it("launches the provider default when the adapter reports models are not discoverable", () => {
    const result = resolveQuickLaunch(
      context({
        modelCatalogOf: () => ({ models: null, source: "not_discoverable", supportedEfforts: [] }),
      }),
    );
    expect(result.kind === "ready" && result.spec).toMatchObject({ model: null, effort: null });
  });

  it.each(["stale", "checking"] as const)("preserves exact choices while a runtime catalog is %s", (status) => {
    const exact = "provider/model-from-last-refresh";
    const result = resolveQuickLaunch(
      context({
        memory: memoryOf(remembered({ model: exact, modelName: exact, effort: "future" })),
        modelCatalogOf: () => ({
          models: MODELS["claude-code"] ?? [],
          source: "runtime",
          status,
          supportedEfforts: ["low"],
        }),
      }),
    );
    expect(result.kind === "ready" && result.spec).toMatchObject({ model: exact, effort: "future" });
  });

  it("rejects a disappeared effort only from a fresh runtime account catalog", () => {
    const result = resolveQuickLaunch(
      context({
        memory: memoryOf(remembered({ model: "claude-opus-5-5", effort: "future" })),
        modelCatalogOf: () => ({
          models: [
            {
              id: "claude-opus-5-5",
              displayName: "Opus 5.5",
              isDefault: true,
              supportedEfforts: ["low"],
            },
          ],
          source: "runtime",
          status: "available",
        }),
      }),
    );
    expect(result).toMatchObject({
      kind: "choose",
      reason: "Future effort isn't available for Opus 5.5 · claude-opus-5-5.",
    });
  });

  it("asks for an account when a provider has none, and refuses providers this build can't run", () => {
    expect(resolveQuickLaunch(context(), { providerId: "codex", count: 3 })).toEqual({
      kind: "choose",
      providerId: "codex",
      count: 3,
      reason: "Add a Codex account.",
    });
    expect(resolveQuickLaunch(context(), { providerId: "gemini-cli" })).toMatchObject({ kind: "choose" });
    expect(resolveQuickLaunch(context(), { providerId: "gemini-cli" })).not.toHaveProperty("providerId");
  });

  it("never launches any provider before its account's models are known", () => {
    const ctx = context({ accounts: [account("cur", { providerId: "cursor" })], modelsOf: () => null });
    expect(resolveQuickLaunch(ctx, { providerId: "cursor" })).toMatchObject({ kind: "choose", providerId: "cursor" });
  });
});
