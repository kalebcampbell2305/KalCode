import { formatLimit, getPlan, limitsFor, PLAN_FEATURE_GROUPS } from "@kalcode/protocol";
import { Button, Panel } from "@kalcode/ui/components";
import { LogOut, UserRound } from "lucide-react";
import { useEffect, useState } from "react";
import { useAccount } from "../../account/AccountProvider.tsx";
import type { AccountUiError } from "../../account/accountState.ts";
import {
  type AccountSnapshot,
  type AccountTier,
  type AccountUsageSnapshot,
  PLAN_CATALOG,
  tierName,
} from "../../ipc/account.ts";
import { usageLine } from "../../kalvoice/assistantState.ts";
import { createBrowserBridge } from "../browser/browserBridge.ts";
import { AccountDisplayName } from "./AccountDisplayName.tsx";
import styles from "./SettingsAccount.module.css";

/** Plan names for Account Hub and Settings, from the canonical catalog. */
export const TIER_NAMES: Record<AccountTier, string> = {
  free: tierName("free"),
  pro: tierName("pro"),
  max: tierName("max"),
  max2x: tierName("max2x"),
  owner: tierName("owner"),
};

/** "Pro, MAX and MAX 2X": every paid plan, named and ordered as the canonical catalog has them. */
const PAID_PLAN_NAMES = (() => {
  const names = PLAN_CATALOG.filter((plan) => plan.tier !== "free").map((plan) => plan.name);
  return names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}` : (names[0] ?? "");
})();

export interface SettingsAccountViewProps {
  account: AccountSnapshot;
  usage: AccountUsageSnapshot | null;
  busy: boolean;
  error: AccountUiError | null;
  onManage(): Promise<void>;
  onComparePlans?(): Promise<void>;
  onLogout(): Promise<void>;
  /** Saves the account display name; without it the panel shows no name editor. */
  onSaveDisplayName?(displayName: string): Promise<AccountUiError | null>;
}

export function SettingsAccount() {
  const { snapshot, usage, busy, error, actions } = useAccount();
  const [compareError, setCompareError] = useState<AccountUiError | null>(null);
  const comparePlans = async () => {
    setCompareError(null);
    try {
      await createBrowserBridge().openExternal("https://kalcoded.com/pricing");
    } catch {
      setCompareError({
        code: "browser_unavailable",
        message: "Open kalcoded.com/pricing in your browser to compare plans, or try again.",
        retryable: true,
      });
    }
  };
  // Requests used since the last account action: read fresh usage whenever this section opens.
  const { refreshUsage } = actions;
  useEffect(() => {
    void refreshUsage();
  }, [refreshUsage]);
  return (
    <SettingsAccountView
      account={snapshot}
      usage={usage}
      busy={busy}
      error={compareError ?? error}
      onComparePlans={comparePlans}
      onManage={actions.portal}
      onLogout={actions.logout}
      onSaveDisplayName={actions.setDisplayName}
    />
  );
}

export function SettingsAccountView({
  account,
  usage,
  busy,
  error,
  onManage,
  onComparePlans,
  onLogout,
  onSaveDisplayName,
}: SettingsAccountViewProps) {
  const limits = limitsFor(account.tier ?? "free");
  const billingInterval = usage?.billingInterval ?? account.billingInterval;
  const plan = getPlan(account.tier === "owner" ? "max2x" : (account.tier ?? "free"));
  const highlights = PLAN_FEATURE_GROUPS.flatMap((group) => group.features).filter((feature) =>
    plan.cardFeatures.includes(feature.id),
  );
  const paid = account.tier === "pro" || account.tier === "max" || account.tier === "max2x";
  const usageLabel = usage?.allowance === null ? "Unlimited requests" : usage ? usageLine(usage) : "Usage unavailable";
  // Share of this period's allowance used, for the meter beside the numbers (null when unlimited/unknown).
  const usedShare =
    usage && usage.allowance !== null && usage.allowance > 0 ? Math.min(1, usage.used / usage.allowance) : null;
  return (
    <Panel
      id="kalcode-account"
      title="KalCode account"
      icon={<UserRound />}
      description="Your verified plan and KalVoice cloud allowance."
      padding="none"
      footer={
        <div className={styles.actions}>
          {paid ? (
            <Button disabled={busy} onClick={() => void onManage()}>
              Manage plan
            </Button>
          ) : null}
          {onComparePlans && account.tier !== "owner" ? (
            <Button variant={paid ? "ghost" : "primary"} disabled={busy} onClick={() => void onComparePlans()}>
              {paid ? "Compare plans" : "Upgrade plan"}
            </Button>
          ) : null}
          <Button variant="ghost" icon={<LogOut />} disabled={busy} onClick={() => void onLogout()}>
            Sign out
          </Button>
        </div>
      }
    >
      {account.account && onSaveDisplayName ? (
        <AccountDisplayName account={account.account} onSave={onSaveDisplayName} />
      ) : null}
      <dl className={styles.details}>
        <div>
          <dt>Email</dt>
          <dd data-selectable>{account.account?.email ?? "Not signed in"}</dd>
        </div>
        <div>
          <dt>Plan</dt>
          <dd>
            <span className={styles.plan} data-tier={account.tier ?? undefined}>
              {account.tier ? tierName(account.tier) : "Not activated"}
            </span>
          </dd>
        </div>
        <div>
          <dt>KalVoice</dt>
          <dd className={styles.usage}>
            <span>{usageLabel}</span>
            {usedShare !== null ? (
              <span
                className={styles.meter}
                data-level={usedShare >= 1 ? "full" : usedShare >= 0.8 ? "high" : undefined}
                aria-hidden="true"
              >
                <span style={{ transform: `scaleX(${usedShare})` }} />
              </span>
            ) : null}
          </dd>
        </div>
        <div>
          <dt>Local coding</dt>
          <dd>Unlimited local terminals and coding agents</dd>
        </div>
        <div>
          <dt>Workspaces</dt>
          <dd>{formatLimit(limits.workspaces)}</dd>
        </div>
        <div>
          <dt>Provider accounts</dt>
          <dd>{formatLimit(limits.providerAccounts)} · All supported providers</dd>
        </div>
        <div>
          <dt>Integrations</dt>
          <dd>{formatLimit(limits.externalIntegrations)}</dd>
        </div>
        <div>
          <dt>Operations history</dt>
          <dd>
            {limits.runHistory !== null
              ? `Recent ${limits.runHistory} runs`
              : limits.operationsHistoryDays !== null
                ? `${limits.operationsHistoryDays}-day history`
                : "Full history"}
          </dd>
        </div>
        <div>
          <dt>Included capabilities</dt>
          <dd>
            {highlights
              .map((feature) => `${feature.label}${feature.status === "coming_soon" ? " (Coming soon)" : ""}`)
              .join(" · ")}
          </dd>
        </div>
        <div>
          <dt>Dictation</dt>
          <dd>Unlimited on-device · No cloud requests used</dd>
        </div>
        {paid ? (
          <div>
            <dt>Billing</dt>
            <dd>
              {billingInterval === "year"
                ? "Yearly"
                : billingInterval === "month"
                  ? "Monthly"
                  : "View billing interval in Manage plan"}
            </dd>
          </div>
        ) : null}
        {account.tier === "free" ? (
          <div>
            <dt>Billing</dt>
            <dd>
              No subscription. {PAID_PLAN_NAMES} add more accounts, cloud requests and premium workflows; compare plans
              at <span data-selectable>kalcoded.com/pricing</span>.
            </dd>
          </div>
        ) : null}
        {account.tier === "owner" ? (
          <div>
            <dt>Billing</dt>
            <dd>No subscription payment required</dd>
          </div>
        ) : null}
      </dl>
      {error ? (
        <p className={styles.error} role="alert">
          {error.message}
        </p>
      ) : null}
    </Panel>
  );
}
