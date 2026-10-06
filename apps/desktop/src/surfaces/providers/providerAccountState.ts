import type { ProviderAccount, ProviderAccountModel } from "@kalcode/protocol";
import { accountSessionState } from "./accountIdentity.ts";
import type { AccountUsageState } from "./accountUsage.ts";

export interface AccountModels {
  status: "checking" | "available" | "unavailable";
  items: readonly ProviderAccountModel[];
  reason: string | null;
}

/** One account identity with independent facts. Informational failures never revoke authentication. */
export interface ProviderAccountState {
  account: ProviderAccount;
  health: ReturnType<typeof accountSessionState>;
  usage: AccountUsageState;
  plan: { status: "known" | "unavailable"; name: string | null };
  models: AccountModels | null;
}

export function providerAccountState(
  account: ProviderAccount,
  usage: AccountUsageState,
  checking: boolean,
  validationError: string | undefined,
  models: AccountModels | null,
): ProviderAccountState {
  return {
    account,
    health: accountSessionState(account, checking, validationError),
    usage,
    plan: { status: usage.plan ? "known" : "unavailable", name: usage.plan ?? null },
    models: account.authenticationState === "not_authenticated" ? null : models,
  };
}
