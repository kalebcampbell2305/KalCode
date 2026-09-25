import { Skeleton } from "@kalcode/ui/components";
import { Activity, CircleX, type LucideIcon, MessageCircleQuestion, ShieldAlert, SquareTerminal } from "lucide-react";
import type { RuntimeSummary } from "./data/summary.ts";
import styles from "./SummaryStrip.module.css";
import { focusSection } from "./useNow.ts";

interface Segment {
  key: string;
  count: number | null;
  label: string;
  icon: LucideIcon;
  /** Contract tone of what is counted (waiting is neutral; amber is reserved for paused). */
  tone: "working" | "waiting" | "failed" | "muted";
  target: string;
}

interface SummaryStripProps {
  summary: RuntimeSummary | null;
  /** Approvals unavailable in this build: the count is omitted rather than shown as zero. */
  approvalsAvailable: boolean;
  terminalsAvailable: boolean;
  loading: boolean;
}

/**
 * The Dashboard's KPI row. A lit proportional rule shows how open threads divide between
 * working, needing you and idle; each tile jumps to the section that explains it. Tile text is
 * "<count> <label>" in DOM order (the accessible name); CSS shows the label above the count.
 */
export function SummaryStrip({ summary, approvalsAvailable, terminalsAvailable, loading }: SummaryStripProps) {
  if (loading || !summary) {
    return (
      <div className={styles.strip} role="status" aria-busy="true">
        <span className="visually-hidden">Loading summary</span>
        <Skeleton height="2px" />
        <div className={styles.segments}>
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} width="100%" height="4.25rem" />
          ))}
        </div>
      </div>
    );
  }

  const { counts } = summary;
  const segments: Segment[] = [
    { key: "running", count: counts.running, label: "Working", icon: Activity, tone: "working", target: "threads" },
    ...(approvalsAvailable
      ? [
          {
            key: "approvals",
            count: counts.approvals,
            label: counts.approvals === 1 ? "Needs approval" : "Need approval",
            icon: ShieldAlert,
            tone: "waiting" as const,
            target: "approvals",
          },
        ]
      : []),
    {
      key: "reply",
      count: counts.waitingForUser,
      label: counts.waitingForUser === 1 ? "Needs a reply" : "Need a reply",
      icon: MessageCircleQuestion,
      tone: "waiting",
      target: "threads",
    },
    { key: "failed", count: counts.failed, label: "Failed", icon: CircleX, tone: "failed", target: "recent" },
    ...(terminalsAvailable
      ? [
          {
            key: "terminals",
            count: summary.runningTerminals,
            label: summary.runningTerminals === 1 ? "Terminal" : "Terminals",
            icon: SquareTerminal,
            tone: "muted" as const,
            target: "terminals",
          },
        ]
      : []),
  ];

  const { working, attention, resting } = summary.openByGroup;
  const total = working + attention + resting;

  return (
    <nav className={styles.strip} aria-label="Summary">
      {total > 0 ? (
        <div className={styles.meter} aria-hidden="true">
          <span data-tone="working" style={{ flexGrow: working }} />
          <span data-tone="waiting" style={{ flexGrow: attention }} />
          <span data-tone="muted" style={{ flexGrow: resting }} />
        </div>
      ) : (
        <div className={styles.meter} aria-hidden="true" />
      )}
      <ul className={styles.segments}>
        {segments.map((segment) => {
          const Icon = segment.icon;
          const zero = segment.count === 0;
          return (
            <li key={segment.key}>
              <button
                type="button"
                className={styles.segment}
                data-tone={segment.tone}
                data-zero={zero || undefined}
                onClick={() => focusSection(segment.target)}
              >
                <span className={styles.count}>{segment.count}</span>
                <span className={styles.label}>
                  <Icon className={styles.icon} aria-hidden="true" />
                  {segment.label}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
