import type { ProviderAccount, StatusTone, ThreadStatus, ThreadSummary } from "@kalcode/protocol";
import { Tooltip } from "@kalcode/ui/components";
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
import { useEffect, useMemo, useState } from "react";
import { describeOverlap, needsAttention } from "../../../runtime/ownership/model.ts";
import { useOptionalUiIntents } from "../../../runtime/uiIntents.tsx";
import { useOptionalOwnership } from "../../dashboard/data/DashboardData.tsx";
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

type OwnershipChipView = {
  tone: "danger" | "waiting" | "info";
  label: string;
  /** Plain sentences for the tooltip and the accessible name. */
  lines: string[];
  files: readonly string[];
  /** The agent a click goes to. */
  otherId: string;
};

const TOOLTIP_FILES = 6;

/**
 * Where this agent stands with the others over files: an overlap worth attention (red when edits
 * can collide, amber when they may), or a quiet note about an active handoff. Renders nothing
 * otherwise, so an agent without overlaps keeps the header exactly as it was.
 */
export function PaneOwnershipChip({ thread }: { thread: Pick<ThreadSummary, "id" | "name" | "workspaceId"> }) {
  const ownership = useOptionalOwnership();
  const intents = useOptionalUiIntents();
  const view = useMemo<OwnershipChipView | null>(() => {
    if (!ownership) return null;
    const nameOf = (id: string) =>
      id === thread.id ? thread.name : (ownership.claims.get(id)?.name ?? "another agent");
    const attention = (ownership.byAgent.get(thread.id) ?? []).filter((entry) => needsAttention(entry.overlap));
    const worst = attention[0];
    if (worst) {
      const more = attention.length - 1;
      const risky = worst.overlap.risk === "live" || worst.overlap.risk === "conflict";
      const sentences = attention.slice(0, 3).map((entry) => describeOverlap(entry.overlap, nameOf));
      return {
        tone: risky ? "danger" : "waiting",
        label: `Overlaps ${worst.other.name}${more > 0 ? ` +${more}` : ""}`,
        lines: attention.length > 3 ? [...sentences, `And ${attention.length - 3} more.`] : sentences,
        files: worst.overlap.files,
        otherId: worst.other.id,
      };
    }
    const claim = ownership.claims.get(thread.id);
    if (claim?.received) {
      const from = nameOf(claim.received.from);
      return {
        tone: "info",
        label: `From ${from}`,
        lines: [`${thread.name} took over ${from}'s work through a handoff.`],
        files: claim.received.files,
        otherId: claim.received.from,
      };
    }
    if (claim?.handedTo) {
      const to = nameOf(claim.handedTo.to);
      return {
        tone: "info",
        label: `Handed to ${to}`,
        lines: [`${thread.name} handed its work to ${to}.`],
        files: claim.files,
        otherId: claim.handedTo.to,
      };
    }
    return null;
  }, [ownership, thread.id, thread.name]);
  if (!view) return null;
  const shown = view.files.slice(0, TOOLTIP_FILES);
  const rest = view.files.length - shown.length;
  const focus = intents
    ? () => void intents.focus({ kind: "agent", agentId: view.otherId, workspaceId: thread.workspaceId })
    : undefined;
  return (
    <Tooltip
      content={
        <span className={styles.ownershipTip}>
          {view.lines.map((line, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: static lines of one tooltip.
            <span key={index}>{line}</span>
          ))}
          {shown.map((file) => (
            <code key={file}>{file}</code>
          ))}
          {rest > 0 ? <span>{`and ${rest} more`}</span> : null}
        </span>
      }
    >
      <button
        type="button"
        className={styles.ownership}
        data-tone={view.tone}
        data-pane-ownership={view.tone}
        aria-label={`${view.label}. ${view.lines.join(" ")}`}
        onClick={focus}
      >
        <span className={styles.ownershipLabel}>{view.label}</span>
      </button>
    </Tooltip>
  );
}
