import type { ThreadStatus } from "@kalcode/protocol";
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
import { useEffect, useRef, useState } from "react";
import { STATUS_META } from "./data/status.ts";
import styles from "./StatusLabel.module.css";

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

/**
 * A thread status as glyph + words (never colour alone). When the status changes while mounted,
 * the label briefly highlights so the change is noticed; reduced motion removes the animation.
 */
export function StatusLabel({ status }: { status: ThreadStatus }) {
  const meta = STATUS_META[status];
  const Icon = ICONS[status];
  const previous = useRef(status);
  const [changed, setChanged] = useState(0);

  useEffect(() => {
    if (previous.current !== status) {
      previous.current = status;
      setChanged((n) => n + 1);
    }
  }, [status]);

  return (
    <span
      key={changed}
      className={styles.label}
      data-tone={meta.tone}
      data-live={meta.group === "working" || undefined}
      data-changed={changed > 0 || undefined}
    >
      <Icon className={styles.icon} aria-hidden="true" strokeWidth={2} />
      <span className={styles.text}>{meta.label}</span>
    </span>
  );
}
