import type { ProviderAccount, ProviderAccountModel } from "@kalcode/protocol";
import { accountSessionState } from "./accountIdentity.ts";
import type { AccountUsageState } from "./accountUsage.ts";

export interface AccountModels {
  status: "checking" | "available" | "stale" | "unavailable";
  items: readonly ProviderAccountModel[];
  reason: string | null;
  /** Runtime discovery and documented aliases are different evidence. */
  source?: "runtime" | "documented_aliases" | "not_discoverable";
  supportedEfforts?: readonly string[];
  /** Local observation time; never a provider authentication timestamp. */
  observedAt?: number;
}

export const MODEL_CATALOG_TTL_MS = 5 * 60_000;

/** Old choices remain inspectable, but no longer prove current account availability. */
export function reconcileModelFreshness(models: AccountModels, now: number): AccountModels {
  if (models.status !== "available") return models;
  if (models.observedAt !== undefined && now >= models.observedAt && now - models.observedAt < MODEL_CATALOG_TTL_MS)
    return models;
  return { ...models, status: "stale", reason: "Model availability may have changed. Refresh models to check." };
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
