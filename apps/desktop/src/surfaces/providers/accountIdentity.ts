import type { ProviderAccount } from "@kalcode/protocol";
import type { BadgeTone, LegacyStatusTone } from "@kalcode/ui/components";
import { accountProviderName } from "../../shell/accountCommands.ts";

/**
 * One account identity for every KalCode surface: the Accounts tab, Code terminal creation,
 * Threads, Agent Fleet, Squads, Runs, Queue, KalVoice routing and the account-aware + buttons all
 * name an account the same way. Labels come only from the owner-chosen name and the provider id;
 * nothing here is inferred from provider output.
 */

type Identity = Pick<ProviderAccount, "providerId" | "displayName">;

/** The owner-chosen account name, e.g. "Work". */
export function accountName(account: Pick<ProviderAccount, "displayName">): string {
  return account.displayName.trim() || "Unnamed account";
}

/** Provider then account, e.g. "Claude Code · Work". Use wherever the provider isn't already shown. */
export function accountFullLabel(account: Identity): string {
  return `${accountProviderName(account.providerId)} · ${accountName(account)}`;
}

/** "Work (Claude Code)": for running sentences such as toasts and confirmations. */
export function accountInlineLabel(account: Identity): string {
  return `${accountName(account)} (${accountProviderName(account.providerId)})`;
}

/** Sign-in state exactly as KalCode last checked it. Never claims more. */
export function accountSignIn(account: Pick<ProviderAccount, "authenticationState">): {
  label: string;
  tone: BadgeTone;
} {
  switch (account.authenticationState) {
    case "authenticated":
      return { label: "Signed in", tone: "success" };
    case "not_authenticated":
      return { label: "Signed out", tone: "danger" };
    default:
      return { label: "Not checked", tone: "outline" };
  }
}

/**
 * Overall health of one account from what KalCode actually knows: its last sign-in check and the
 * last error code. "Unknown" when it has never been checked.
 */
export function accountHealth(
  account: Pick<ProviderAccount, "authenticationState" | "lastErrorCode" | "lastCheckedAt">,
): { label: string; tone: LegacyStatusTone } {
  if (account.lastErrorCode) return { label: "Needs attention", tone: "danger" };
  if (account.authenticationState === "authenticated") return { label: "Healthy", tone: "success" };
  if (account.authenticationState === "not_authenticated") return { label: "Signed out", tone: "waiting" };
  return { label: account.lastCheckedAt ? "Unknown" : "Not checked", tone: "idle" };
}

export type AccountSessionState = "connected" | "checking" | "expired" | "error" | "not_checked";

/**
 * The restart-safe session state shown in Account Hub. A background check never turns a
 * last-known connected account into a signed-out account unless the provider actually reports it.
 */
export function accountSessionState(
  account: Pick<ProviderAccount, "authenticationState" | "lastErrorCode" | "lastCheckedAt">,
  checking = false,
  validationError: string | null = null,
): { state: AccountSessionState; label: string; tone: LegacyStatusTone; usable: boolean } {
  if (checking) {
    return {
      state: "checking",
      label: "Checking",
      tone: "waiting",
      usable: account.authenticationState !== "not_authenticated",
    };
  }
  if (account.authenticationState === "not_authenticated") {
    return { state: "expired", label: "Expired", tone: "waiting", usable: false };
  }
  if (validationError || account.lastErrorCode) {
    return {
      state: "error",
      label: "Error",
      tone: "danger",
      usable: true,
    };
  }
  if (account.authenticationState === "authenticated") {
    return { state: "connected", label: "Connected", tone: "success", usable: true };
  }
  return { state: "not_checked", label: "Not checked", tone: "idle", usable: true };
}

/** Accounts in one stable order everywhere: default first, then by name (numbers in natural order). */
export function sortAccounts<T extends Pick<ProviderAccount, "isDefault" | "displayName">>(
  accounts: readonly T[],
): T[] {
  return [...accounts].sort(
    (a, b) =>
      Number(b.isDefault) - Number(a.isDefault) ||
      a.displayName.localeCompare(b.displayName, undefined, { numeric: true, sensitivity: "base" }),
  );
}
