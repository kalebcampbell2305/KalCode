import type { ProviderAccount, ThreadSummary } from "@kalcode/protocol";
import { describe, expect, it } from "vitest";
import {
  accountHue,
  accountMonogram,
  activityShare,
  alternativesFor,
  alternativesHint,
  chipLabel,
  chipParts,
  compatibility,
  DOCK_HUES,
  dockAccounts,
  dockHealth,
  usageLine,
} from "./dockModel.ts";

function account(id: string, providerId: string, displayName: string, extra: Partial<ProviderAccount> = {}) {
  return {
    id,
    providerId,
    displayName,
    providerReportedIdentity: null,
    authenticationState: "authenticated",
    isDefault: false,
    createdAt: "2026-10-01T00:00:00Z",
    lastUsedAt: null,
    lastCheckedAt: "2026-10-01T00:00:00Z",
    lastErrorCode: null,
    archivedAt: null,
    ...extra,
  } satisfies ProviderAccount;
}

function thread(id: string, providerId: string, accountId: string | null, extra: Partial<ThreadSummary> = {}) {
  return {
    id,
    name: `Thread ${id}`,
    providerId,
    providerName: providerId === "codex" ? "Codex" : "Claude Code",
    providerAccountId: accountId,
    accountLabel: null,
    status: "idle",
    pendingApprovals: 0,
    archivedAt: null,
    error: null,
    runtimeKind: null,
    terminalId: null,
    ...extra,
  } as unknown as ThreadSummary;
}

const claudeA = account("c-a", "claude-code", "Claude A", { isDefault: true });
const claudeB = account("c-b", "claude-code", "Claude B");
const codexA = account("x-a", "codex", "A");
const codexB = account("x-b", "codex", "B", { authenticationState: "not_authenticated" });

describe("dock accounts", () => {
  it("orders Claude, Codex, Gemini, default first, and drops removed accounts", () => {
    const gemini = account("g", "gemini-cli", "Personal");
    const removed = account("c-z", "claude-code", "Old", { archivedAt: "2026-10-01T00:00:00Z" });
    const entries = dockAccounts([gemini, codexB, claudeB, removed, codexA, claudeA], []);
    expect(entries.map((entry) => entry.account.id)).toEqual(["c-a", "c-b", "x-a", "x-b", "g"]);
  });

  it("counts the open threads each account carries, running and waiting ones too", () => {
    const entries = dockAccounts(
      [claudeA, claudeB],
      [
        thread("1", "claude-code", "c-a", { status: "running_command" }),
        thread("2", "claude-code", "c-a", { status: "waiting_for_permission", pendingApprovals: 1 }),
        thread("3", "claude-code", "c-a"),
        thread("4", "claude-code", "c-a", { archivedAt: "2026-10-01T00:00:00Z" }),
      ],
    );
    const [a, b] = entries;
    if (!a || !b) throw new Error("expected two accounts");
    expect(a).toMatchObject({ agents: 0, threads: 3, running: 1, waiting: 1 });
    expect(b).toMatchObject({ agents: 0, threads: 0, running: 0, waiting: 0 });
    expect(usageLine(a)).toBe("1 needs you · 1 running · 3 threads");
    expect(usageLine(b)).toBe("No agents or threads");
    expect(usageLine({ agents: 0, threads: 2, running: 0, waiting: 0 })).toBe("Idle · 2 threads");
    expect(activityShare(a)).toBeCloseTo(1 / 3);
    expect(activityShare(b)).toBe(0);
  });

  it("counts coding agents as agents, never as threads", () => {
    const [a] = dockAccounts(
      [claudeA],
      [
        thread("1", "claude-code", "c-a", { runtimeKind: "interactive_pty", status: "editing" }),
        thread("2", "claude-code", "c-a", { runtimeKind: "interactive_pty" }),
        thread("3", "claude-code", "c-a"),
      ],
    );
    if (!a) throw new Error("expected an account");
    expect(a).toMatchObject({ agents: 2, threads: 1, running: 1 });
    expect(usageLine(a)).toBe("1 running · 2 agents · 1 thread");
    expect(usageLine({ agents: 1, threads: 0, running: 0, waiting: 0 })).toBe("Idle · 1 agent");
    expect(activityShare(a)).toBeCloseTo(1 / 3);
  });

  it("names chips without repeating the provider", () => {
    expect(chipLabel(claudeA)).toBe("Claude A");
    expect(chipLabel(codexA)).toBe("Codex A");
    expect(chipLabel(account("w", "claude-code", "Work"))).toBe("Claude Work");
    expect(chipParts(claudeA)).toEqual({ provider: "Claude", name: "A" });
    expect(chipParts(account("w", "claude-code", "Work"))).toEqual({ provider: "Claude", name: "Work" });
  });

  it("gives every account a monogram and a stable colour", () => {
    expect(accountMonogram({ displayName: "Work" })).toBe("W");
    expect(accountMonogram({ displayName: "Claude B" })).toBe("CB");
    expect(accountMonogram({ displayName: "  " })).toBe("UA");
    expect(accountHue("c-a")).toBe(accountHue("c-a"));
    expect(accountHue("c-a")).toBeGreaterThanOrEqual(0);
    expect(accountHue("c-a")).toBeLessThan(DOCK_HUES);
  });

  it("reads health only from what KalCode checked", () => {
    expect(dockHealth(claudeA)).toBe("healthy");
    expect(dockHealth(codexB)).toBe("signed_out");
    expect(dockHealth({ ...claudeA, lastErrorCode: "auth_expired" })).toBe("attention");
    expect(dockHealth({ ...claudeA, authenticationState: "unknown", lastCheckedAt: null })).toBe("unchecked");
  });
});

describe("compatibility", () => {
  const entries = dockAccounts([claudeA, claudeB, codexA, codexB], []);
  const entry = (id: string) => {
    const found = entries.find((candidate) => candidate.account.id === id);
    if (!found) throw new Error(`no account ${id}`);
    return found;
  };

  it("lets a quiet thread move to another signed-in account of its provider", () => {
    expect(compatibility(thread("1", "claude-code", "c-a"), entry("c-b"))).toEqual({ ok: true });
  });

  it("refuses its own account, another provider, a signed-out account and a busy thread", () => {
    const quiet = thread("1", "codex", "x-a");
    expect(compatibility(quiet, entry("x-a"))).toMatchObject({ ok: false, reason: "current" });
    expect(compatibility(quiet, entry("c-a"))).toMatchObject({
      ok: false,
      reason: "provider",
      detail: "Not a Codex account",
    });
    expect(compatibility(quiet, entry("x-b"))).toMatchObject({ ok: false, reason: "signed_out" });
    const busy = thread("2", "claude-code", "c-a", { status: "running_command" });
    expect(compatibility(busy, entry("c-b"))).toMatchObject({ ok: false, reason: "busy" });
  });

  it("suggests alternatives only when the thread's own account is unavailable", () => {
    expect(alternativesFor(thread("1", "claude-code", "c-a"), entries)).toEqual([]);
    const stranded = thread("2", "codex", "x-b");
    expect(alternativesFor(stranded, entries).map((candidate) => candidate.account.id)).toEqual(["x-a"]);
    expect(alternativesHint(stranded, entries, alternativesFor(stranded, entries))).toBe(
      "Codex B is signed out · Codex A can take it",
    );
    expect(alternativesFor(thread("4", "claude-code", null), entries)).toEqual([]);
    const orphan = thread("3", "claude-code", "gone");
    expect(alternativesFor(orphan, entries).map((candidate) => candidate.account.id)).toEqual(["c-a", "c-b"]);
    expect(alternativesHint(orphan, entries, alternativesFor(orphan, entries))).toBe(
      "This thread's account isn't connected · 2 accounts can take it",
    );
  });
});
