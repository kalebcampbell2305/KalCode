import type { ProviderAccount, ThreadSummary } from "@kalcode/protocol";
import { ACCOUNT_PROVIDER_NAMES } from "../../shell/accountCommands.ts";

export type IdentityFact = {
  value: string | null;
  source: "provider" | "configured" | "unavailable";
  label: string;
};

export type SessionIdentityInput = Pick<
  ThreadSummary,
  "providerId" | "providerName" | "providerAccountId" | "accountLabel" | "model" | "effort"
> & { activeModel?: string | null; activeEffort?: string | null };

function fact(active: string | null | undefined, configured: string | null, unavailable: string): IdentityFact {
  if (active?.trim()) return { value: active, source: "provider", label: active };
  if (configured?.trim()) return { value: configured, source: "configured", label: `${configured} (selected)` };
  return { value: null, source: "unavailable", label: unavailable };
}

/**
 * One identity projection for all session surfaces. Launch choices are never evidence of the
 * provider's active model. Account lookup requires both stable account ID and provider ID;
 * an unavailable or expired binding never falls back to a different account.
 */
export function sessionIdentity(thread: SessionIdentityInput, accounts?: readonly ProviderAccount[] | null) {
  const account =
    accounts?.find(
      (candidate) => candidate.id === thread.providerAccountId && candidate.providerId === thread.providerId,
    ) ?? null;
  const providerName =
    (Object.hasOwn(ACCOUNT_PROVIDER_NAMES, thread.providerId)
      ? ACCOUNT_PROVIDER_NAMES[thread.providerId]
      : undefined) ??
    (thread.providerName?.trim() || thread.providerId);
  const accountName = account?.displayName.trim() || thread.accountLabel?.trim() || "Account unavailable";
  const needsReconnect = account?.authenticationState === "not_authenticated" && account.archivedAt === null;
  const model = fact(thread.activeModel, thread.model, "Model controlled by provider");
  const effort = fact(thread.activeEffort, thread.effort, "Reasoning controlled by provider");
  const compact = [providerName, accountName, model.label, effort.label].join(" · ");
  const detail = [
    compact,
    model.source === "provider" ? "Model reported by provider." : "Provider has not reported the active model.",
    effort.source === "provider" ? "Reasoning reported by provider." : "Provider has not reported active reasoning.",
    thread.model && model.source === "provider" ? `Selected model: ${thread.model}.` : null,
    thread.effort && effort.source === "provider" ? `Selected reasoning: ${thread.effort}.` : null,
    needsReconnect ? "Reconnect this account to start new work." : null,
    account?.archivedAt ? "Account removed; this session retains its original binding." : null,
    !account && accounts && thread.providerAccountId ? "Account unavailable; original identity preserved." : null,
  ]
    .filter(Boolean)
    .join(" ");
  return { providerName, accountName, account, needsReconnect, model, effort, compact, detail };
}
