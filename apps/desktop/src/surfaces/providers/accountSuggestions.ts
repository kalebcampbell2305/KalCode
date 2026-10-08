import type { ProviderAccount, ThreadSummary } from "@kalcode/protocol";
import { accountName } from "./accountIdentity.ts";
import {
  type AccountUsageState,
  LOW_USAGE_PERCENT,
  notChecked,
  type UsageWindow,
  usagePercent,
  windowAppliesToModel,
} from "./accountUsage.ts";
import { USAGE_STALE_AFTER_MS } from "./accountUsageReader.ts";
import { sessionIdentity } from "./sessionIdentity.ts";

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
    return windowAppliesToModel(window, model);
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
  condition: "missing" | "sign-in" | "low" | "provider-limit" | "billing";
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
  const model = sessionIdentity(thread, accounts).model.value;
  const window = currentWindow(usageForAccount(usage, thread.providerAccountId), model, now);
  // A native provider can report a failed turn without exposing numeric quota. Do not infer
  // account limits from prose or retain a previous turn's failure after work has resumed.
  const failure =
    thread.status === "failed" || (thread.status === "idle" && thread.currentActivity === "Last turn failed")
      ? thread.error?.code
      : null;
  let reason: string;
  let condition: AccountSuggestion["condition"];
  if (!current || current.archivedAt !== null) {
    condition = "missing";
    reason = "This session's account is no longer available.";
  } else if (current.providerId !== thread.providerId) return null;
  else if (current.authenticationState === "not_authenticated") {
    condition = "sign-in";
    reason = `${accountName(current)} needs sign-in.`;
  } else if (failure === "provider_authentication_failed" || failure === "provider_oauth_org_not_allowed") {
    condition = "sign-in";
    reason = `${accountName(current)} could not authenticate this session.`;
  } else if (failure === "provider_billing_error" || failure === "provider_account_on_hold") {
    condition = "billing";
    reason = `${accountName(current)} has a provider-reported billing or account hold.`;
  } else if (
    failure === "provider_rate_limit" ||
    (thread.providerId === "gemini-cli" && (failure === "rate_limited" || failure === "quota_exhausted"))
  ) {
    condition = "provider-limit";
    reason = `${accountName(current)} reached a provider-reported limit.`;
  } else if (window && window.remainingPercent < LOW_USAGE_PERCENT) {
    condition = "low";
    reason = `${accountName(current)} has ${usagePercent(window.remainingPercent)}% left in its ${window.label.toLowerCase()} limit.`;
  } else return null;

  const alternatives: SuggestedAccount[] = [];
  for (const account of accounts) {
    if (
      account.id === thread.providerAccountId ||
      account.providerId !== thread.providerId ||
      account.archivedAt !== null ||
      account.authenticationState !== "authenticated"
    )
      continue;
    const available = currentWindow(usageForAccount(usage, account.id), model, now);
    if (available && available.remainingPercent < LOW_USAGE_PERCENT) continue;
    alternatives.push({
      account,
      availability: available ? 0 : 1,
      detail: [
        "Signed in",
        available
          ? `${usagePercent(available.remainingPercent)}% ${available.label.toLowerCase()} remaining`
          : "Usage unavailable",
        checking.has(account.id)
          ? "Checking account"
          : validationErrors.has(account.id) || account.lastErrorCode
            ? "Account check incomplete"
            : null,
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
  return { condition, reason, alternatives };
}
