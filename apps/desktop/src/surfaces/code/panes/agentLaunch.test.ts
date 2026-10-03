import type { ProviderAccount, ProviderAccountBinding } from "@kalcode/protocol";
import { describe, expect, it } from "vitest";
import { isCodingAgent } from "../../dashboard/data/agents.ts";
import {
  AGENT_EFFORTS,
  clampAgentCount,
  launchAccounts,
  launchLabel,
  MAX_AGENTS_PER_LAUNCH,
  preselectLaunchAccount,
  stopsOnClose,
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

  it("offers each provider's own efforts (Gemini CLI has none)", () => {
    expect(AGENT_EFFORTS["claude-code"]).toContain("max");
    expect(AGENT_EFFORTS.codex).toContain("minimal");
    expect(AGENT_EFFORTS["gemini-cli"]).toEqual([]);
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

describe("closing an agent's pane", () => {
  const entry = (status: string, running: boolean) =>
    ({ thread: { status }, info: { running } }) as unknown as Parameters<typeof stopsOnClose>[0];
  it("stops a live agent", () => {
    expect(stopsOnClose(entry("active", true))).toBe(true);
  });
  it("cancels a launch the resource governor is holding (no live PTY yet)", () => {
    expect(stopsOnClose(entry("waiting_for_dependency", false))).toBe(true);
  });
  it("leaves an agent that already ended alone", () => {
    expect(stopsOnClose(entry("interrupted", false))).toBe(false);
    expect(stopsOnClose(entry("completed", false))).toBe(false);
    expect(stopsOnClose(undefined)).toBe(false);
  });
});
