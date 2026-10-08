import { Button } from "@kalcode/ui/components";
import { CheckCircle2, CircleAlert, TriangleAlert, X } from "lucide-react";
import { useEffect } from "react";
import type { RecipeLaunchSummary as Summary } from "../../runtime/recipes/model.ts";
import { useRecipeLaunch } from "../../runtime/recipes/RecipeLaunchProvider.tsx";
import styles from "./RecipeLaunchSummary.module.css";

const AUTO_DISMISS_MS = 12_000;

export function formatDuration(ms: number): string {
  return ms < 1000 ? `${Math.max(0, Math.round(ms))} ms` : `${(ms / 1000).toFixed(1)} s`;
}

export function summaryHeadline(summary: Summary): string {
  const total = summary.started.length + summary.failed.length + summary.skipped.length;
  if (summary.started.length === 0 && summary.notice) return summary.recipeName;
  return `Started ${summary.started.length} of ${total} in KalCode · ${formatDuration(summary.durationMs)}`;
}

/** Non-modal result card: bottom-right, never takes focus, auto-dismisses only when all went well. */
export function RecipeLaunchSummary() {
  const launch = useRecipeLaunch();
  const { phase } = launch;
  const summary = phase.kind === "done" ? phase.summary : null;
  const clean = summary
    ? summary.failed.length === 0 &&
      summary.skipped.length === 0 &&
      !summary.notice &&
      !summary.started.some((s) => s.note)
    : false;

  useEffect(() => {
    if (!summary || !clean) return;
    const timer = window.setTimeout(() => launch.dismiss(), AUTO_DISMISS_MS);
    return () => window.clearTimeout(timer);
  }, [summary, clean, launch]);

  if (!summary) return null;
  const hasProblem = !clean;
  return (
    <section
      className={styles.card}
      data-tone={summary.failed.length > 0 ? "failed" : hasProblem ? "waiting" : "ok"}
      role="status"
      aria-live="polite"
      aria-label={`${summary.recipeName} launch result`}
    >
      <header className={styles.header}>
        {summary.failed.length > 0 ? (
          <CircleAlert className={styles.icon} aria-hidden="true" />
        ) : (
          <CheckCircle2 className={styles.icon} aria-hidden="true" />
        )}
        <div className={styles.headline}>
          <strong className={styles.title}>{summary.recipeName}</strong>
          <span className={styles.sub}>{summaryHeadline(summary)}</span>
        </div>
        <button type="button" className={styles.close} aria-label="Dismiss launch summary" onClick={launch.dismiss}>
          <X aria-hidden="true" />
        </button>
      </header>

      {summary.notice ? <p className={styles.notice}>{summary.notice}</p> : null}

      {summary.started.length > 0 ? (
        <ul className={styles.list} aria-label="Started">
          {summary.started.map((part) => (
            <li key={part.key} className={styles.item}>
              {part.link ? (
                <button
                  type="button"
                  className={styles.link}
                  onClick={() => part.link && launch.openLink(part.link)}
                  aria-label={`Open ${part.label}`}
                >
                  {part.label}
                </button>
              ) : (
                <span className={styles.plain}>{part.label}</span>
              )}
              <span className={styles.kind}>{part.reused ? "already running" : part.kind}</span>
              {part.note ? (
                <span className={styles.note}>
                  <TriangleAlert aria-hidden="true" />
                  {part.note}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}

      {summary.failed.length > 0 ? (
        <ul className={styles.list} aria-label="Failed">
          {summary.failed.map((part) => (
            <li key={part.key} className={styles.item} data-failed>
              <span className={styles.failedLabel}>{part.label}</span>
              <span className={styles.kind}>{part.kind}</span>
              <span className={styles.reason}>{part.reason}</span>
            </li>
          ))}
        </ul>
      ) : null}

      {summary.skipped.length > 0 ? (
        <ul className={styles.list} aria-label="Skipped">
          {summary.skipped.map((part) => (
            <li key={part.key} className={styles.item} data-skipped>
              <span className={styles.plain}>{part.label}</span>
              <span className={styles.kind}>skipped</span>
              <span className={styles.reason}>{part.reason}</span>
            </li>
          ))}
        </ul>
      ) : null}

      <footer className={styles.footer}>
        <Button size="sm" variant="ghost" onClick={launch.dismiss}>
          Dismiss
        </Button>
      </footer>
    </section>
  );
}
