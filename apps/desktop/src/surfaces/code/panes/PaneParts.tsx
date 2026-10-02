import type { ProviderAccount, StatusTone, ThreadStatus, ThreadSummary } from "@kalcode/protocol";
import { Badge, ProviderGlyph as SharedProviderGlyph } from "@kalcode/ui/components";
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

/** Shared identity mark: a published mark for supported providers and a generic fallback otherwise. */
export function ProviderGlyph({ providerId }: { providerId: string; providerName?: string }) {
  return <SharedProviderGlyph provider={providerId} size="lg" />;
}

export type PaneAccountState = "active" | "snapshot" | "archived_or_unavailable" | "status_unavailable" | "unmanaged";

export interface PaneAccountIdentity {
  label: string;
  state: PaneAccountState;
}

/** Resolve display metadata only. Pane routing continues to use the thread's exact account id. */
export function resolvePaneAccount(
  thread: Pick<ThreadSummary, "providerId" | "providerAccountId" | "accountLabel">,
  accounts: readonly ProviderAccount[] | null,
  loadFailed: boolean,
): PaneAccountIdentity | null {
  const snapshot = thread.accountLabel?.trim() || null;
  if (!thread.providerAccountId) {
    return snapshot ? { label: snapshot, state: "unmanaged" } : null;
  }
  if (loadFailed) {
    return { label: snapshot ?? "Unknown account", state: "status_unavailable" };
  }
  if (accounts === null) {
    return { label: snapshot ?? "Unknown account", state: "snapshot" };
  }
  const active = accounts.find(
    (account) =>
      account.id === thread.providerAccountId &&
      account.providerId === thread.providerId &&
      account.archivedAt === null,
  );
  return active
    ? { label: accountName(active), state: "active" }
    : { label: snapshot ?? "Unknown account", state: "archived_or_unavailable" };
}

export function paneAccountLabel(account: PaneAccountIdentity): string {
  if (account.state === "snapshot") return `${account.label} (checking status)`;
  if (account.state === "archived_or_unavailable") return `${account.label} (archived or unavailable)`;
  if (account.state === "status_unavailable") return `${account.label} (status unavailable)`;
  if (account.state === "unmanaged") return `${account.label} (not managed)`;
  return account.label;
}

export function PaneAccountChip({ account }: { account: PaneAccountIdentity }) {
  const label = paneAccountLabel(account);
  return (
    <Badge tone="outline" title={`Provider account: ${label}`}>
      <span className="visually-hidden">Provider </span>
      Account · {label}
    </Badge>
  );
}

/** The display status: glyph + UPPERCASE words, tone as a reinforcement only. */
export function PaneStatusChip({ status }: { status: ThreadStatus }) {
  const view = paneStatus(status);
  const Icon = ICONS[status];
  const tone: StatusTone = view.tone;
  return (
    <span className={styles.meta}>
      <span className={styles.chip} data-tone={tone} data-pane-status={view.display}>
        <Icon aria-hidden="true" />
        {view.label}
      </span>
      {view.qualifier ? <span className={styles.qualifier}>{view.qualifier}</span> : null}
    </span>
  );
}
