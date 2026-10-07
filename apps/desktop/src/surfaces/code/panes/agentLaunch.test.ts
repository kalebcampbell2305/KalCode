import type { ProviderAccount, ProviderAccountBinding } from "@kalcode/protocol";
import { describe, expect, it } from "vitest";
import { isCodingAgent } from "../../dashboard/data/agents.ts";
import {
  clampAgentCount,
  effortForModel,
  effortLabel,
  effortsForModel,
  LAUNCH_MEMORY_KEY,
  launchAccounts,
  launchLabel,
  MAX_AGENTS_PER_LAUNCH,
  preselectLaunchAccount,
  type RememberedLaunch,
  readLaunchMemory,
  rememberedLaunch,
  rememberLaunch,
  resolveLaunchAccount,
  sameSignIns,
} from "./agentLaunch.ts";

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

describe("launching coding agents", () => {
  it("launches between 1 and the per-launch maximum", () => {
    expect(clampAgentCount(6)).toBe(6);
    expect(clampAgentCount(0)).toBe(1);
    expect(clampAgentCount(-3)).toBe(1);
    expect(clampAgentCount(Number.NaN)).toBe(1);
    expect(clampAgentCount(99)).toBe(MAX_AGENTS_PER_LAUNCH);
  });

  it("names the launch by count and provider", () => {
    expect(launchLabel(1, "Claude Code")).toBe("Launch Claude Code agent");
    expect(launchLabel(6, "Claude Code")).toBe("Launch 6 Claude Code agents");
    expect(launchLabel(3, "Codex")).toBe("Launch 3 Codex agents");
  });

  it("uses model effort metadata first, then account catalog metadata, with no provider guess", () => {
    const none = { id: "fixed", displayName: "Fixed", isDefault: false, supportedEfforts: [] };
    expect(effortsForModel("codex", none, ["high"])).toEqual([]);
    expect(effortForModel("codex", none, "high", ["high"])).toBe("");

    const absent = { id: "legacy", displayName: "Legacy", isDefault: false };
    expect(effortsForModel("codex", absent)).toEqual([]);
    expect(effortsForModel("codex", absent, [])).toEqual([]);
    expect(effortsForModel("codex", absent, ["medium"])).toEqual(["medium"]);
    expect(effortForModel("codex", absent, "medium", ["medium"])).toBe("medium");
  });

  it("offers only this provider's accounts that are still in KalCode", () => {
    const accounts = [
      account("work"),
      account("gone", { archivedAt: "2026-01-01T00:00:00Z" }),
      account("codex", { providerId: "codex" }),
    ];
    expect(launchAccounts(accounts, "claude-code").map((a) => a.id)).toEqual(["work"]);
  });

  it("starts with the workspace's account, then the default, then the only signed-in one", () => {
    const accounts = [
      account("a", { authenticationState: "not_authenticated" }),
      account("b"),
      account("c", { authenticationState: "not_authenticated" }),
    ];
    const bound: ProviderAccountBinding[] = [
      { providerId: "claude-code", kind: "workspace", scopeId: "ws", accountId: "c" },
    ];
    expect(preselectLaunchAccount(accounts, bound, "claude-code", "ws")).toBe("c");
    expect(preselectLaunchAccount(accounts, [], "claude-code", "ws")).toBe("b");
    const withDefault = [...accounts, account("d", { isDefault: true })];
    expect(preselectLaunchAccount(withDefault, [], "claude-code", "ws")).toBe("d");
    expect(preselectLaunchAccount([], [], "claude-code", "ws")).toBe("");
  });
});

describe("what counts as an agent", () => {
  const base = { runtimeKind: null, terminalId: null } as const;
  it("is a provider CLI in a Code terminal pane, never a chat thread", () => {
    expect(isCodingAgent({ ...base, runtimeKind: "interactive_pty" } as never)).toBe(true);
    expect(isCodingAgent({ ...base, terminalId: "t-1" } as never)).toBe(true);
    expect(isCodingAgent({ ...base, runtimeKind: "headless" } as never)).toBe(false);
    expect(isCodingAgent({ ...base } as never)).toBe(false);
  });
});

describe("the launcher's memory", () => {
  const memoryStore = () => {
    const data = new Map<string, string>();
    return {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => void data.set(key, value),
    } as unknown as Storage;
  };
  const entry = (partial: Partial<RememberedLaunch> = {}): RememberedLaunch => ({
    providerId: "claude-code",
    accountId: "b",
    model: "opus",
    modelName: "Opus",
    effort: "high",
    count: 3,
    workspaceId: "ws",
    boundAccountId: null,
    at: "2026-10-03T00:00:00.000Z",
    ...partial,
  });

  it("round-trips the last launch per provider and ignores malformed data", () => {
    const store = memoryStore();
    expect(readLaunchMemory(store)).toEqual({ last: null, byProvider: {}, byContext: {} });
    rememberLaunch(entry(), store);
    rememberLaunch(entry({ providerId: "codex", accountId: "x", model: null, effort: null, count: 1 }), store);
    const memory = readLaunchMemory(store);
    expect(memory.last?.providerId).toBe("codex");
    expect(memory.byProvider["claude-code"]).toMatchObject({ accountId: "b", model: "opus", effort: "high", count: 3 });
    store.setItem(LAUNCH_MEMORY_KEY, "{not json");
    expect(readLaunchMemory(store)).toEqual({ last: null, byProvider: {}, byContext: {} });
    store.setItem(
      LAUNCH_MEMORY_KEY,
      JSON.stringify({ last: { providerId: "nope", accountId: "a", workspaceId: "ws" } }),
    );
    expect(readLaunchMemory(store).last).toBeNull();
    expect(readLaunchMemory(null)).toEqual({ last: null, byProvider: {}, byContext: {} });
  });

  it("keeps exact model and effort choices separate per project and account", () => {
    const store = memoryStore();
    rememberLaunch(entry({ workspaceId: "project-a", accountId: "work", model: "opus", effort: "high" }), store);
    rememberLaunch(
      entry({ workspaceId: "project-a", accountId: "personal", model: "sonnet", effort: "medium" }),
      store,
    );
    rememberLaunch(entry({ workspaceId: "project-b", accountId: "work", model: "haiku", effort: "low" }), store);

    const memory = readLaunchMemory(store);
    expect(rememberedLaunch(memory, "project-a", "claude-code", "work")).toMatchObject({
      model: "opus",
      effort: "high",
    });
    expect(rememberedLaunch(memory, "project-a", "claude-code", "personal")).toMatchObject({
      model: "sonnet",
      effort: "medium",
    });
    expect(rememberedLaunch(memory, "project-b", "claude-code", "work")).toMatchObject({
      model: "haiku",
      effort: "low",
    });
  });

  it("round-trips a provider model id at the supported 512-byte boundary", () => {
    const store = memoryStore();
    const exact = `vendor/${"m".repeat(505)}`;
    rememberLaunch(entry({ model: exact, modelName: exact }), store);
    expect(rememberedLaunch(readLaunchMemory(store), "ws", "claude-code", "b")?.model).toBe(exact);
  });

  it("migrates a legacy provider entry only into its recorded project and account", () => {
    const store = memoryStore();
    const legacy = entry({ workspaceId: "project-a", accountId: "work", model: "opus", effort: "high" });
    store.setItem(LAUNCH_MEMORY_KEY, JSON.stringify({ last: legacy, byProvider: { "claude-code": legacy } }));

    const memory = readLaunchMemory(store);
    expect(rememberedLaunch(memory, "project-a", "claude-code", "work")).toMatchObject({ model: "opus" });
    expect(rememberedLaunch(memory, "project-a", "claude-code", "personal")).toBeNull();
    expect(rememberedLaunch(memory, "project-b", "claude-code", "work")).toBeNull();
  });

  it("starts with the remembered account unless the workspace binding changed since that launch", () => {
    const accounts = [account("a", { isDefault: true }), account("b"), account("c")];
    const bindTo = (accountId: string): ProviderAccountBinding[] => [
      { providerId: "claude-code", kind: "workspace", scopeId: "ws", accountId },
    ];
    expect(resolveLaunchAccount(accounts, [], "claude-code", "ws", entry())).toBe("b");
    expect(resolveLaunchAccount(accounts, null, "claude-code", "ws", entry())).toBe("b");
    // Bound to "a" when "b" was launched: the remembered choice still wins.
    expect(resolveLaunchAccount(accounts, bindTo("a"), "claude-code", "ws", entry({ boundAccountId: "a" }))).toBe("b");
    // Account Center then chose "c" for this workspace: that newer explicit choice wins.
    expect(resolveLaunchAccount(accounts, bindTo("c"), "claude-code", "ws", entry({ boundAccountId: "a" }))).toBe("c");
    // A removed or archived remembered account never falls through to another account.
    expect(resolveLaunchAccount([accounts[0] as ProviderAccount], [], "claude-code", "ws", entry())).toBe("");
    expect(
      resolveLaunchAccount(
        [accounts[0] as ProviderAccount, account("b", { archivedAt: "2026-10-07T12:00:00Z" })],
        [],
        "claude-code",
        "ws",
        entry(),
      ),
    ).toBe("");
    // A newer explicit Account Center binding still replaces the unavailable remembered account.
    expect(resolveLaunchAccount([accounts[0] as ProviderAccount], bindTo("a"), "claude-code", "ws", entry())).toBe("a");
    expect(resolveLaunchAccount(accounts, [], "claude-code", "ws", undefined)).toBe("a");
  });

  it("flags later accounts that are the same provider sign-in", () => {
    const same = sameSignIns([
      account("kc", { displayName: "KalCode", providerReportedIdentity: "owner@kalcode.dev" }),
      account("kc2", { displayName: "KalCode 2", providerReportedIdentity: " OWNER@kalcode.dev " }),
      account("other", { displayName: "Other", providerReportedIdentity: "other@kalcode.dev" }),
      account("codex", { providerId: "codex", displayName: "Codex", providerReportedIdentity: "owner@kalcode.dev" }),
      account("none", { displayName: "None", providerReportedIdentity: null }),
    ]);
    expect([...same]).toEqual([["kc2", "KalCode"]]);
  });

  it("names efforts the way people say them", () => {
    expect(effortLabel("xhigh")).toBe("Extra high");
    expect(effortLabel("max")).toBe("Max");
    expect(effortLabel("turbo")).toBe("Turbo");
  });
});
