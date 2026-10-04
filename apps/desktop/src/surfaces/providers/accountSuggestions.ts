import type { ProviderAccount, ThreadSummary } from "@kalcode/protocol";
import { accountName } from "./accountIdentity.ts";
import { type AccountUsageState, LOW_USAGE_PERCENT, notChecked, type UsageWindow } from "./accountUsage.ts";
import { USAGE_STALE_AFTER_MS } from "./accountUsageReader.ts";

/** A mismatched response must never borrow another account's usage or plan. */
export function usageForAccount(usage: ReadonlyMap<string, AccountUsageState>, accountId: string): AccountUsageState {
  const state = usage.get(accountId);
  return state?.accountId === accountId ? state : notChecked(accountId);
}

function currentWindow(state: AccountUsageState, model: string | null, now: number): UsageWindow | null {
  const checked = state.checkedAt ? Date.parse(state.checkedAt) : Number.NaN;
  if (state.status !== "fresh" || !Number.isFinite(checked) || checked > now || now - checked > USAGE_STALE_AFTER_MS)
    return null;
  const windows = state.windows.filter((window) => {
    if (!Number.isFinite(window.remainingPercent) || window.remainingPercent < 0 || window.remainingPercent > 100)
      return false;
    if (window.resetsAt !== null && !(Date.parse(window.resetsAt) > now)) return false;
    // Model-specific quotas are meaningful only for the model this agent is using.
    if (window.id.includes("opus") && !model?.toLowerCase().includes("opus")) return false;
    if (window.id.includes("sonnet") && !model?.toLowerCase().includes("sonnet")) return false;
    return true;
  });
  return windows.reduce<UsageWindow | null>(
    (best, window) => (!best || window.remainingPercent < best.remainingPercent ? window : best),
    null,
  );
}

export interface SuggestedAccount {
  account: ProviderAccount;
  detail: string;
  /** Known headroom ranks ahead of unknown usage; never compare invented quota values. */
  availability: number;
}

export interface AccountSuggestion {
  reason: string;
  alternatives: SuggestedAccount[];
}

/** Pure advice. Never selects an account, writes a preference, or changes a live runtime. */
export function suggestAccounts(
  thread: ThreadSummary,
  accounts: readonly ProviderAccount[],
  usage: ReadonlyMap<string, AccountUsageState>,
  checking: ReadonlySet<string>,
  validationErrors: ReadonlyMap<string, string>,
  now = Date.now(),
): AccountSuggestion | null {
  if (!thread.providerAccountId || thread.archivedAt !== null || thread.permissionMode === "custom") return null;
  const current = accounts.find((account) => account.id === thread.providerAccountId);
  const window = currentWindow(usageForAccount(usage, thread.providerAccountId), thread.model, now);
  let reason: string;
  if (!current || current.archivedAt !== null) reason = "This session's account is no longer available.";
  else if (current.providerId !== thread.providerId) return null;
  else if (current.authenticationState === "not_authenticated") reason = `${accountName(current)} needs sign-in.`;
  else if (current.lastErrorCode || validationErrors.has(current.id))
    reason = `${accountName(current)} has an account connection error.`;
  else if (window && window.remainingPercent < LOW_USAGE_PERCENT)
    reason = `${accountName(current)} has ${Math.round(window.remainingPercent)}% left in its ${window.label.toLowerCase()} limit.`;
  else return null;

  const alternatives: SuggestedAccount[] = [];
  for (const account of accounts) {
    if (
      account.id === thread.providerAccountId ||
      account.providerId !== thread.providerId ||
      account.archivedAt !== null ||
      account.authenticationState !== "authenticated" ||
      account.lastErrorCode ||
      checking.has(account.id) ||
      validationErrors.has(account.id)
    )
      continue;
    const available = currentWindow(usageForAccount(usage, account.id), thread.model, now);
    if (available && available.remainingPercent < LOW_USAGE_PERCENT) continue;
    alternatives.push({
      account,
      availability: available ? 0 : 1,
      detail: [
        "Signed in",
        available
          ? `${Math.round(available.remainingPercent)}% ${available.label.toLowerCase()} remaining`
          : "Usage unavailable",
        account.isDefault ? "Your default" : null,
      ]
        .filter(Boolean)
        .join(" · "),
    });
  }
  alternatives.sort(
    (a, b) =>
      a.availability - b.availability ||
      Number(b.account.isDefault) - Number(a.account.isDefault) ||
      a.account.displayName.localeCompare(b.account.displayName, undefined, { numeric: true, sensitivity: "base" }) ||
      a.account.id.localeCompare(b.account.id),
  );
  return { reason, alternatives };
}
