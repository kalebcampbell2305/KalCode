import type { ProviderAccount, ProviderAccountBinding } from "@kalcode/protocol";
import type { PaneProviderId } from "./paneChannel.ts";

/**
 * Launching coding agents from Code's + (owner rule, AGENTS.md): an agent is a real Claude Code,
 * Codex or Gemini CLI session in a terminal pane, so "six Claude Code agents" is six panes.
 */

/** Provider-native efforts each pane CLI accepts (mirrors native `pane_effort`). */
export const AGENT_EFFORTS: Record<PaneProviderId, readonly string[]> = {
  "claude-code": ["low", "medium", "high", "xhigh", "max"],
  codex: ["minimal", "low", "medium", "high", "xhigh"],
  "gemini-cli": [],
};

/** The most agents one launch starts; plan limits are enforced natively on top of this. */
export const MAX_AGENTS_PER_LAUNCH = 10;

export function clampAgentCount(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.min(MAX_AGENTS_PER_LAUNCH, Math.max(1, Math.round(value)));
}

/** Accounts an agent can start with: this provider's, not removed from KalCode. */
export function launchAccounts(accounts: readonly ProviderAccount[], providerId: string): ProviderAccount[] {
  return accounts.filter((account) => account.providerId === providerId && account.archivedAt === null);
}

/**
 * The account a new agent starts with, in the order the runtime resolves one: the workspace's
 * remembered account, then the provider default, then the only signed-in account. Empty when
 * the person has to choose (or there is none, and native says what to add).
 */
export function preselectLaunchAccount(
  accounts: readonly ProviderAccount[],
  bindings: readonly ProviderAccountBinding[],
  providerId: string,
  workspaceId: string,
): string {
  const candidates = launchAccounts(accounts, providerId);
  const bound = bindings.find(
    (b) => b.kind === "workspace" && b.providerId === providerId && b.scopeId === workspaceId,
  );
  if (bound && candidates.some((account) => account.id === bound.accountId)) return bound.accountId;
  const preferred = candidates.find((account) => account.isDefault);
  if (preferred) return preferred.id;
  const signedIn = candidates.filter((account) => account.authenticationState !== "not_authenticated");
  return signedIn.length === 1 ? (signedIn[0]?.id ?? "") : (candidates[0]?.id ?? "");
}

/** "Launch agent", "Launch 6 Claude Code agents". */
export function launchLabel(count: number, providerName: string): string {
  return count === 1 ? `Launch ${providerName} agent` : `Launch ${count} ${providerName} agents`;
}
