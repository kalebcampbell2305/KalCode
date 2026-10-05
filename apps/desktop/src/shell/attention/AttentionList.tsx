import { Button, IconButton, Skeleton } from "@kalcode/ui/components";
import {
  CircleCheckBig,
  CircleX,
  GitPullRequestArrow,
  Hourglass,
  type LucideIcon,
  MessageCircleQuestion,
  PlugZap,
  ShieldAlert,
  X,
} from "lucide-react";
import { memo, useState } from "react";
import { type KalActions, useKalActions } from "../../runtime/actions.ts";
import { formatAbsolute, formatRelative } from "../../runtime/describeEvent.ts";
import { useNow } from "../../surfaces/dashboard/useNow.ts";
import styles from "./AttentionList.module.css";
import type { AttentionAction, AttentionItem, AttentionKind } from "./model.ts";
import { dismissAttention } from "./useAttention.ts";

const KIND: Record<AttentionKind, { icon: LucideIcon; tone: string; label: string }> = {
  question: { icon: MessageCircleQuestion, tone: "waiting", label: "Question" },
  approval: { icon: ShieldAlert, tone: "waiting", label: "Approval" },
  failed: { icon: CircleX, tone: "failed", label: "Failed" },
  auth: { icon: PlugZap, tone: "waiting", label: "Sign-in" },
  stalled: { icon: Hourglass, tone: "recovering", label: "Stalled" },
  review: { icon: GitPullRequestArrow, tone: "done", label: "Review" },
};

interface AttentionListProps {
  items: readonly AttentionItem[];
  ready: boolean;
  /** Fewer details per card (the side sheet). */
  compact?: boolean;
  /** Shown when nothing needs the person. */
  emptyHint?: string;
}

/**
 * The Needs You items as cards: who, what happened, why it needs the person, and the next actions.
 * Every button runs a canonical KalCode action, so "Open agent" here is the same as clicking the
 * agent anywhere else: it focuses the agent's real coding terminal.
 */
export function AttentionList({ items, ready, compact = false, emptyHint }: AttentionListProps) {
  const actions = useKalActions();
  const now = useNow(30_000);
  if (!ready) {
    return (
      <div className={styles.loading} role="status" aria-busy="true">
        <span className="visually-hidden">Checking what needs you</span>
        <Skeleton width="72%" />
        <Skeleton width="54%" />
      </div>
    );
  }
  if (items.length === 0) {
    return (
      <div className={styles.empty} data-compact={compact || undefined}>
        <span className={styles.emptyGlyph} aria-hidden="true">
          <CircleCheckBig />
        </span>
        <div>
          <p className={styles.emptyTitle}>Nothing needs you</p>
          <p className={styles.emptyText}>
            {emptyHint ??
              "Questions, failures, sign-outs, stalled agents and finished work to review show up here, and only those."}
          </p>
        </div>
      </div>
    );
  }
  return (
    <ul className={styles.list} data-compact={compact || undefined}>
      {items.map((item) => (
        <AttentionCard key={item.key} item={item} actions={actions} now={now} />
      ))}
    </ul>
  );
}

const AttentionCard = memo(function AttentionCard({
  item,
  actions,
  now,
}: {
  item: AttentionItem;
  actions: KalActions;
  now: number;
}) {
  const meta = KIND[item.kind];
  const Icon = meta.icon;
  const [busy, setBusy] = useState<string | null>(null);
  const titleId = `attention-${item.key}`;
  const run = (action: AttentionAction) => {
    setBusy(action.id);
    void actions.runAttention(item, action).finally(() => setBusy(null));
  };
  const visible = item.actions.filter((a) => a.id !== "dismiss");
  const dismiss = item.actions.find((a) => a.id === "dismiss");
  return (
    <li className={styles.card} data-tone={meta.tone} data-kind={item.kind} aria-labelledby={titleId}>
      <span className={styles.glyph} data-tone={meta.tone} aria-hidden="true">
        <Icon />
      </span>
      <div className={styles.content}>
        <p className={styles.head}>
          <span className={styles.source}>{item.source}</span>
          {item.workspaceName ? <span className={styles.workspace}>{item.workspaceName}</span> : null}
          <time className={styles.time} dateTime={item.at} title={formatAbsolute(item.at)}>
            {formatRelative(item.at, now)}
          </time>
        </p>
        <p id={titleId} className={styles.what}>
          <span className="visually-hidden">{meta.label}: </span>
          {item.what}
        </p>
        <p className={styles.why}>{item.why}</p>
        <div className={styles.actions}>
          {visible.map((action, index) => (
            <Button
              key={action.id}
              size="sm"
              variant={index === 0 ? "primary" : "secondary"}
              busy={busy === action.id}
              onClick={() => run(action)}
              aria-label={`${action.label}: ${item.source}`}
            >
              {action.label}
            </Button>
          ))}
          {dismiss && dismiss.label !== "Dismiss" ? (
            <Button size="sm" variant="ghost" onClick={() => run(dismiss)}>
              {dismiss.label}
            </Button>
          ) : null}
        </div>
      </div>
      {item.dismissible && !(dismiss && dismiss.label !== "Dismiss") ? (
        <IconButton
          size="sm"
          className={styles.close}
          label={`Dismiss: ${item.source}, ${item.what}`}
          icon={<X />}
          onClick={() => dismissAttention(item.key)}
        />
      ) : null}
    </li>
  );
});
