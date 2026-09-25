import type { StatusTone, ThreadStatus } from "@kalcode/protocol";
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
import { paneStatus, providerIdentity } from "./paneLabels.ts";
import styles from "./Panes.module.css";

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

/** A neutral KalCode glyph (shape + initial) for a provider. Never a provider's own mark. */
export function ProviderGlyph({ providerId, providerName }: { providerId: string; providerName?: string }) {
  const identity = providerIdentity(providerId, providerName);
  return (
    <span className={styles.glyph} data-shape={identity.shape} aria-hidden="true">
      {identity.initial}
    </span>
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
