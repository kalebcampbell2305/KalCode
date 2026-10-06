import type { Notification, NotificationKind, StatusTone } from "@kalcode/protocol";
import {
  Bell,
  CircleCheck,
  CircleX,
  Flag,
  type LucideIcon,
  PlugZap,
  RotateCw,
  ShieldAlert,
  Stethoscope,
  Workflow,
} from "lucide-react";
import type { FocusTarget } from "../../runtime/uiIntents.tsx";

/**
 * Notification kinds as the center shows them: a glyph and a contract tone (never colour alone —
 * the title always says what happened). Tones follow the status palette: done high-contrast
 * neutral, failed red, needs-you amber, recovery blue.
 */
export const KIND_META: Record<NotificationKind, { icon: LucideIcon; tone: StatusTone; label: string }> = {
  thread_completed: { icon: CircleCheck, tone: "done", label: "Completed" },
  thread_failed: { icon: CircleX, tone: "failed", label: "Failed" },
  permission_required: { icon: ShieldAlert, tone: "waiting", label: "Permission required" },
  mission_done: { icon: Flag, tone: "done", label: "Mission done" },
  provider_disconnected: { icon: PlugZap, tone: "waiting", label: "Provider signed out" },
  recovery_available: { icon: RotateCw, tone: "recovering", label: "Recovery available" },
  automation_finished: { icon: Workflow, tone: "muted", label: "Automation finished" },
  doctor_finding: { icon: Stethoscope, tone: "waiting", label: "Environment finding" },
  health_changed: { icon: Bell, tone: "muted", label: "Provider health" },
};

/** Where opening a notification takes the person: its entity, focused. */
export function targetOf(notification: Notification): FocusTarget {
  // Recovered agents are Interrupted (STOPPED in the shared agent state), which the Fleet shows in Done.
  if (notification.kind === "recovery_available") return { kind: "dashboard", chip: "done" };
  switch (notification.entityKind) {
    case "thread":
      return notification.entityId
        ? { kind: "thread", threadId: notification.entityId, workspaceId: notification.workspaceId }
        : { kind: "dashboard" };
    case "workspace":
      return notification.entityId ? { kind: "workspace", workspaceId: notification.entityId } : { kind: "dashboard" };
    case "provider":
      return { kind: "provider", providerId: notification.entityId ?? "" };
    case "approval":
      return { kind: "approvals" };
    default:
      return { kind: "dashboard" };
  }
}

export type DayGroup = "Today" | "Yesterday" | "Earlier";

function startOfDay(time: number): number {
  const d = new Date(time);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function dayGroupOf(iso: string, now: number): DayGroup {
  const t = Date.parse(iso);
  const today = startOfDay(now);
  if (t >= today) return "Today";
  if (t >= today - 86_400_000) return "Yesterday";
  return "Earlier";
}

export type NotificationRow =
  | { kind: "day"; key: string; label: DayGroup }
  | { kind: "item"; key: string; notification: Notification };

/** Flattens a newest-first list into day headings and items (for the virtualized list). */
export function withDayHeadings(list: readonly Notification[], now: number): NotificationRow[] {
  const rows: NotificationRow[] = [];
  let current: DayGroup | null = null;
  for (const notification of list) {
    const group = dayGroupOf(notification.updatedAt, now);
    if (group !== current) {
      rows.push({ kind: "day", key: `day:${group}`, label: group });
      current = group;
    }
    rows.push({ kind: "item", key: notification.id, notification });
  }
  return rows;
}
