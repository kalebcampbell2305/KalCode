import type { ProviderAccount, StatusTone, ThreadStatus, ThreadSummary } from "@kalcode/protocol";
import {
  Brain,
  Circle,
  CircleCheck,
  CirclePause,
  CircleStop,
  CircleX,
  CloudOff,
  Eye,
  FlaskConical,
  Hourglass,
  type LucideIcon,
  MessageCircleQuestion,
  PencilLine,
  Play,
  RotateCw,
  ShieldAlert,
  Sparkles,
  SquareTerminal,
  Wrench,
} from "lucide-react";
import { accountName } from "../../providers/accountIdentity.ts";
import styles from "./Panes.module.css";
import { paneStatus } from "./paneLabels.ts";

const ICONS: Record<ThreadStatus, LucideIcon> = {
  starting: Play,
  active: Sparkles,
  thinking: Brain,
  running_tool: Wrench,
  running_command: SquareTerminal,
  editing: PencilLine,
  testing: FlaskConical,
  reviewing: Eye,
  recovering: RotateCw,
  waiting_for_permission: ShieldAlert,
  waiting_for_user: MessageCircleQuestion,
  waiting_for_dependency: Hourglass,
  idle: Circle,
  paused: CirclePause,
  offline: CloudOff,
  completed: CircleCheck,
  failed: CircleX,
  interrupted: CircleStop,
};

export type PaneAccountState = "active" | "snapshot" | "archived_or_unavailable" | "status_unavailable" | "unmanaged";

export interface PaneAccountIdentity {
  label: string;
  state: PaneAccountState;
  /**
   * The pane's own provider account, for its usage badge. Only ever this thread's exact account
   * id (never another account's usage); absent when the account is unmanaged or gone.
   */
  usageAccount?: Pick<ProviderAccount, "id" | "displayName" | "providerId">;
}

/** Resolve display metadata only. Pane routing continues to use the thread's exact account id. */
export function resolvePaneAccount(
  thread: Pick<ThreadSummary, "providerId" | "providerAccountId" | "accountLabel">,
  accounts: readonly ProviderAccount[] | null,
  loadFailed: boolean,
): PaneAccountIdentity | null {
  const snapshot = thread.accountLabel?.trim() || null;
  const accountId = thread.providerAccountId;
  if (!accountId) {
    return snapshot ? { label: snapshot, state: "unmanaged" } : null;
  }
  const usageAccount = (label: string) => ({ id: accountId, displayName: label, providerId: thread.providerId });
  if (loadFailed) {
    const label = snapshot ?? "Unknown account";
    return { label, state: "status_unavailable", usageAccount: usageAccount(label) };
  }
  if (accounts === null) {
    const label = snapshot ?? "Unknown account";
    return { label, state: "snapshot", usageAccount: usageAccount(label) };
  }
  const active = accounts.find(
    (account) =>
      account.id === thread.providerAccountId &&
      account.providerId === thread.providerId &&
      account.archivedAt === null,
  );
  if (!active) return { label: snapshot ?? "Unknown account", state: "archived_or_unavailable" };
  const label = accountName(active);
  return { label, state: "active", usageAccount: usageAccount(label) };
}

export function paneAccountLabel(account: PaneAccountIdentity): string {
  if (account.state === "snapshot") return `${account.label} (checking status)`;
  if (account.state === "archived_or_unavailable") return `${account.label} (archived or unavailable)`;
  if (account.state === "status_unavailable") return `${account.label} (status unavailable)`;
  if (account.state === "unmanaged") return `${account.label} (not managed)`;
  return account.label;
}

/** True when two resolved identities render the same (resolution makes a new object per render). */
export function samePaneAccount(a: PaneAccountIdentity | null, b: PaneAccountIdentity | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.label === b.label &&
    a.state === b.state &&
    a.usageAccount?.id === b.usageAccount?.id &&
    a.usageAccount?.displayName === b.usageAccount?.displayName &&
    a.usageAccount?.providerId === b.usageAccount?.providerId
  );
}

/** The account nickname in the pane header ("Personal", "Claude A"); state qualifiers in words. */
export function PaneAccountChip({ account }: { account: PaneAccountIdentity }) {
  const label = paneAccountLabel(account);
  return (
    <span
      className={`${styles.seg} ${styles.accountName}`}
      title={`Provider account: ${label}`}
      data-account-state={account.state}
      data-pane-account
    >
      <span className="visually-hidden">Provider account </span>
      {label}
    </span>
  );
}

/** The display status: glyph + UPPERCASE words, tone as a reinforcement only. */
export function PaneStatusChip({ status }: { status: ThreadStatus }) {
  const view = paneStatus(status);
  const Icon = ICONS[status];
  const tone: StatusTone = view.tone;
  return (
    <span className={styles.statusGroup}>
      <span className={styles.chip} data-tone={tone} data-pane-status={view.display}>
        <Icon aria-hidden="true" />
        <span className={styles.chipLabel}>{view.label}</span>
      </span>
      {view.qualifier ? <span className={styles.qualifier}>{view.qualifier}</span> : null}
    </span>
  );
}
