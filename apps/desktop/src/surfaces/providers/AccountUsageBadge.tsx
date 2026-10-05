import type { ProviderAccount } from "@kalcode/protocol";
import { ProviderGlyph } from "@kalcode/ui/components";
import { Popover } from "radix-ui";
import { type CSSProperties, useEffect, useId, useState } from "react";
import { formatRelative } from "../../runtime/describeEvent.ts";
import { accountProviderName } from "../../shell/accountCommands.ts";
import styles from "./AccountUsageBadge.module.css";
import { accountName, accountSessionState } from "./accountIdentity.ts";
import {
  type AccountUsageState,
  isReportedPercent,
  LOW_USAGE_PERCENT,
  limitingWindow,
  resetsIn,
  type UsageWindow,
  usagePercent,
  usageSummary,
  useAccountUsage,
} from "./accountUsage.ts";
import { useOptionalProviderAccountSessions } from "./ProviderAccountSessions.tsx";

export interface AccountUsageBadgeProps {
  /** The exact provider account (Claude A, Codex B…) whose canonical usage to show. */
  account: Pick<ProviderAccount, "id" | "displayName" | "providerId">;
  size?: "xs" | "sm";
  /** When true, clicking opens the compact account + usage menu. */
  interactive?: boolean;
}

/** Compact "64% left" usage for one provider account, from the canonical account state. */
export function AccountUsageBadge({ account, size = "sm", interactive = false }: AccountUsageBadgeProps) {
  const usage = useAccountUsage(account.id);
  const summary = usageSummary(usage);
  const body = (
    <>
      <span className={styles.dot} aria-hidden="true" />
      <span className={styles.value}>{summary.short}</span>
    </>
  );
  const common = {
    className: styles.badge,
    "data-size": size,
    "data-tone": summary.tone,
    "data-usage-tone": summary.tone,
    "data-stale": usage.status === "stale" || undefined,
  };
  if (!interactive) {
    return (
      <span {...common} title={usageTitle(usage)}>
        {body}
      </span>
    );
  }
  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button
          type="button"
          {...common}
          data-interactive=""
          aria-label={`${accountName(account)} usage: ${summary.short}. Show account details`}
        >
          {body}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content className={styles.popover} side="bottom" align="end" sideOffset={6} collisionPadding={8}>
          <AccountUsageDetails account={account} usage={usage} />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function usageTitle(usage: AccountUsageState): string | undefined {
  if (usage.status !== "fresh" && usage.status !== "stale") return usage.reason ?? undefined;
  const lines = usage.windows
    .filter((w) => isReportedPercent(w.remainingPercent))
    .map((w) =>
      [
        `${w.label}: ${usagePercent(w.remainingPercent)}% ${usage.status === "stale" ? "last reported" : "remaining"}`,
        resetsIn(w.resetsAt),
      ]
        .filter(Boolean)
        .join(" · "),
    );
  if (usage.checkedAt) lines.push(`Updated ${formatRelative(usage.checkedAt)}`);
  return lines.join("\n");
}

function percent(window: UsageWindow): number {
  return window.remainingPercent;
}

/** A small remaining-quota bar plus "64% left": the non-interactive form used inside rows. */
export function UsageMeter({ usage, className }: { usage: AccountUsageState; className?: string }) {
  const summary = usageSummary(usage);
  const limiting = limitingWindow(usage);
  const known = usage.status === "fresh" && limiting !== null;
  return (
    <span
      className={[styles.meter, className].filter(Boolean).join(" ")}
      data-tone={summary.tone}
      data-stale={usage.status === "stale" || undefined}
      data-checking={usage.status === "checking" || undefined}
      title={usageTitle(usage)}
    >
      <span className={styles.track} data-empty={!known || undefined} aria-hidden="true">
        {known ? <span className={styles.fill} style={{ "--fill": `${percent(limiting)}%` } as CSSProperties} /> : null}
      </span>
      <span className={styles.meterText}>{summary.short}</span>
    </span>
  );
}

/** Re-renders once a minute so "Resets in…" and "Updated…" stay honest while a menu is open. */
function useMinuteClock(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

/** Account, identity, plan, each usage window and when it was read: the badge's popover body. */
export function AccountUsageDetails({
  account,
  usage,
}: {
  account: Pick<ProviderAccount, "id" | "displayName" | "providerId">;
  usage: AccountUsageState;
}) {
  const now = useMinuteClock();
  const titleId = useId();
  const sessions = useOptionalProviderAccountSessions();
  const full = sessions?.accounts?.find((a) => a.id === account.id) ?? null;
  const session = full
    ? accountSessionState(full, sessions?.checking.has(full.id), sessions?.validationErrors.get(full.id) ?? null)
    : null;
  const plan = usage.plan ?? null;
  const meta = [accountProviderName(account.providerId), full?.providerReportedIdentity, plan].filter(Boolean);
  const windows = usage.windows.filter((window) => isReportedPercent(window.remainingPercent));
  const known = usage.status === "fresh" || usage.status === "stale";
  return (
    <section className={styles.details} aria-labelledby={titleId}>
      <header className={styles.detailsHead}>
        <ProviderGlyph provider={account.providerId} size="sm" />
        <div className={styles.detailsName}>
          <h3 id={titleId}>{accountName(account)}</h3>
          <p>{meta.join(" · ")}</p>
        </div>
        {session ? (
          <span className={styles.session} data-tone={session.tone}>
            <span className={styles.dot} aria-hidden="true" />
            {session.label}
          </span>
        ) : null}
      </header>
      {known && windows.length > 0 ? (
        <ul className={styles.windows}>
          {windows.map((w) => {
            const left = percent(w);
            const reset = resetsIn(w.resetsAt, now);
            return (
              <li
                key={w.id}
                className={styles.window}
                data-tone={usage.status === "stale" ? "muted" : left < LOW_USAGE_PERCENT ? "low" : "ok"}
              >
                <span className={styles.windowLabel}>{w.label}</span>
                <span className={styles.windowValue}>
                  <strong>{usagePercent(w.remainingPercent)}%</strong>{" "}
                  {usage.status === "stale" ? "last reported" : "remaining"}
                </span>
                <span className={styles.windowTrack} aria-hidden="true">
                  <span className={styles.fill} style={{ "--fill": `${left}%` } as CSSProperties} />
                </span>
                {reset ? <span className={styles.windowReset}>{reset}</span> : null}
              </li>
            );
          })}
        </ul>
      ) : (
        <p className={styles.unknown}>
          {usage.status === "checking"
            ? "Checking usage…"
            : `Usage unavailable${usage.reason ? ` · ${usage.reason}` : ""}`}
        </p>
      )}
      {known && usage.checkedAt ? (
        <p className={styles.checked} data-stale={usage.status === "stale" || undefined}>
          {usage.status === "stale"
            ? `Last read ${formatRelative(usage.checkedAt, now)} · may be out of date`
            : `Updated ${formatRelative(usage.checkedAt, now)}`}
        </p>
      ) : null}
    </section>
  );
}
