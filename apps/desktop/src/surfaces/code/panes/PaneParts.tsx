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
import { useEffect, useState } from "react";
import { accountName } from "../../providers/accountIdentity.ts";
import styles from "./Panes.module.css";
import { type PaneToolView, paneStatus, paneToolActivity } from "./paneLabels.ts";

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

/**
 * The shared agent state: glyph + UPPERCASE words, tone as a reinforcement only. `qualifier`
 * replaces the shared one when the pane knows more (a held launch's real reason: "memory is
 * critically low").
 */
export function PaneStatusChip({
  thread,
  qualifier,
}: {
  thread: Pick<ThreadSummary, "status" | "currentActivity" | "pendingApprovals">;
  qualifier?: string | null;
}) {
  const view = paneStatus(thread);
  const shownQualifier = qualifier ?? view.qualifier;
  const Icon = ICONS[thread.status];
  const tone: StatusTone = view.tone;
  return (
    <span className={styles.statusGroup}>
      <span className={styles.chip} data-tone={tone} data-pane-status={view.display}>
        <Icon aria-hidden="true" />
        <span className={styles.chipLabel}>{view.label}</span>
      </span>
      {shownQualifier ? <span className={styles.qualifier}>{shownQualifier}</span> : null}
    </span>
  );
}

/** How long a finished tool stays visible before the indicator steps aside. */
const TOOL_LINGER_MS = 2400;

type ToolPhase = "running" | "done" | "failed";

/**
 * A compact "TOOL · Search web · Running…" indicator for the call the agent is making, then
 * "Completed" for a moment. Reads only structured status; never adds noise to the terminal.
 */
export function PaneToolChip({ status, activity }: { status: ThreadStatus; activity: string | null }) {
  const [shown, setShown] = useState<(PaneToolView & { phase: ToolPhase }) | null>(null);
  useEffect(() => {
    const live = paneToolActivity(status, activity);
    if (live) {
      setShown({ ...live, phase: "running" });
      return;
    }
    setShown((prev) =>
      prev?.phase === "running" ? { ...prev, phase: status === "failed" ? "failed" : "done" } : prev,
    );
    const timer = window.setTimeout(
      () => setShown((prev) => (prev?.phase === "running" ? prev : null)),
      TOOL_LINGER_MS,
    );
    return () => window.clearTimeout(timer);
  }, [status, activity]);
  if (!shown) return null;
  const phaseLabel = shown.phase === "running" ? "Running…" : shown.phase === "failed" ? "Failed" : "Completed";
  return (
    <span className={styles.tool} data-phase={shown.phase} data-pane-tool={shown.label} title={shown.detail}>
      <span className={styles.toolEyebrow}>Tool</span>
      <span className={styles.toolLabel}>{shown.label}</span>
      <span className={styles.toolPhase} role="status">
        {phaseLabel}
      </span>
    </span>
  );
}
