import { Button, Panel } from "@kalcode/ui/components";
import { LogOut, UserRound } from "lucide-react";
import { useAccount } from "../../account/AccountProvider.tsx";
import type { AccountUiError } from "../../account/accountState.ts";
import { type AccountSnapshot, type AccountTier, type AccountUsageSnapshot, tierName } from "../../ipc/account.ts";
import { usageLine } from "../../kalvoice/assistantState.ts";
import styles from "./SettingsAccount.module.css";

/** Plan names for Account Hub and Settings, from the canonical catalog. */
export const TIER_NAMES: Record<AccountTier, string> = {
  free: tierName("free"),
  pro: tierName("pro"),
  max: tierName("max"),
  max2x: tierName("max2x"),
  owner: tierName("owner"),
};

export interface SettingsAccountViewProps {
  account: AccountSnapshot;
  usage: AccountUsageSnapshot | null;
  busy: boolean;
  error: AccountUiError | null;
  onManage(): Promise<void>;
  onLogout(): Promise<void>;
}

export function SettingsAccount() {
  const { snapshot, usage, busy, error, actions } = useAccount();
  return (
    <SettingsAccountView
      account={snapshot}
      usage={usage}
      busy={busy}
      error={error}
      onManage={actions.portal}
      onLogout={actions.logout}
    />
  );
}

export function SettingsAccountView({ account, usage, busy, error, onManage, onLogout }: SettingsAccountViewProps) {
  const paid = account.tier === "pro" || account.tier === "max" || account.tier === "max2x";
  const usageLabel = usage?.allowance === null ? "Unlimited requests" : usage ? usageLine(usage) : "Usage unavailable";
  return (
    <Panel
      id="kalcode-account"
      title="KalCode account"
      icon={<UserRound />}
      description="Your identity, verified plan, and KalVoice request allowance."
      padding="none"
      footer={
        <div className={styles.actions}>
          {paid ? (
            <Button disabled={busy} onClick={() => void onManage()}>
              Manage plan
            </Button>
          ) : null}
          <Button variant="ghost" icon={<LogOut />} disabled={busy} onClick={() => void onLogout()}>
            Sign out
          </Button>
        </div>
      }
    >
      <dl className={styles.details}>
        <div>
          <dt>Email</dt>
          <dd data-selectable>{account.account?.email ?? "Not signed in"}</dd>
        </div>
        <div>
          <dt>Plan</dt>
          <dd>{account.tier ? tierName(account.tier) : "Not activated"}</dd>
        </div>
        <div>
          <dt>KalVoice</dt>
          <dd>{usageLabel}</dd>
        </div>
        <div>
          <dt>Dictation</dt>
          <dd>Unlimited</dd>
        </div>
        {account.tier === "free" ? (
          <div>
            <dt>Billing</dt>
            <dd>
              No subscription. Pro, Max and Max 2X add more KalVoice requests; compare plans at{" "}
              <span data-selectable>kalcoded.com/pricing</span>.
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
