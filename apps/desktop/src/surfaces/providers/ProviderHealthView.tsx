import type { HealthRollup, ProviderHealth, ProviderStatus } from "@kalcode/protocol";
import {
  Button,
  ErrorState,
  type KeyValueItem,
  KeyValueList,
  Panel,
  ProviderMark,
  Skeleton,
  StatusIndicator,
  Table,
} from "@kalcode/ui/components";
import { formatAbsolute, formatRelative } from "../../runtime/describeEvent.ts";
import {
  failuresText,
  formatMs,
  type HourSlot,
  healthStateLabel,
  historySummary,
  hourSlots,
  latencyText,
  processText,
  rateLimitText,
  recoveryHint,
  signInText,
  trendLabel,
  versionText,
} from "./healthLabels.ts";
import { useOptionalProviderAccountSessions } from "./ProviderAccountSessions.tsx";
import healthStyles from "./ProviderHealthView.module.css";
import styles from "./ProvidersPage.module.css";
import type { Label } from "./providerLabels.ts";
import { HISTORY_HOURS, type ProviderHealthData } from "./useProviderHealth.ts";

/**
 * The Providers → Health tab (PH-01): one panel per provider with what KalCode last detected and
 * observed. Unknown values are shown as unknown; a rate limit appears only when the provider
 * reported one (PH-02). A failure to read health never blocks the page (PH-06).
 */
export function ProviderHealthView({
  data,
  statuses,
  now,
}: {
  data: ProviderHealthData;
  statuses: readonly ProviderStatus[] | null;
  now: number;
}) {
  const { list, error, trends, refresh } = data;
  if (error && !list) {
    return (
      <ErrorState
        title="Health unknown"
        code={`${error.category}/${error.code}`}
        actions={<Button onClick={refresh}>Try again</Button>}
      >
        <p>
          KalCode couldn't read provider health right now. Threads aren't affected, and the Setup tab still shows what
          detection found.
        </p>
      </ErrorState>
    );
  }
  if (!list) {
    return (
      <Panel as="div" className={styles.loading} role="status" aria-busy="true">
        <span className="visually-hidden">Loading provider health</span>
        <Skeleton width="30%" height="1rem" />
        <Skeleton width="65%" />
        <Skeleton width="55%" />
      </Panel>
    );
  }
  return (
    <>
      {error ? (
        <p className={healthStyles.stale} role="status">
          Couldn't refresh provider health. Showing what KalCode read before.
        </p>
      ) : null}
      {list.map((health) => (
        <HealthPanel
          key={health.providerId}
          health={health}
          status={statuses?.find((s) => s.id === health.providerId) ?? null}
          rollups={trends[health.providerId]}
          now={now}
        />
      ))}
    </>
  );
}

function StatusValue({ label }: { label: Label }) {
  return (
    <span className={styles.status}>
      <StatusIndicator tone={label.tone}>{label.label}</StatusIndicator>
      {label.detail ? <span className={styles.statusDetail}>{label.detail}</span> : null}
    </span>
  );
}

function When({ iso, now }: { iso: string; now: number }) {
  return (
    <time dateTime={iso} title={formatAbsolute(iso)}>
      {formatRelative(iso, now)}
    </time>
  );
}

function HealthPanel({
  health,
  status,
  rollups,
  now,
}: {
  health: ProviderHealth;
  status: ProviderStatus | null;
  rollups: HealthRollup[] | null | undefined;
  now: number;
}) {
  const hint = recoveryHint(health, status);
  const accounts = useOptionalProviderAccountSessions()?.accounts;
  const own = accounts?.filter((account) => account.providerId === health.providerId) ?? null;
  const signIns = own
    ? { total: own.length, signedIn: own.filter((a) => a.authenticationState === "authenticated").length }
    : null;
  const state: KeyValueItem[] = [
    { key: "health", label: "Health", value: <StatusValue label={healthStateLabel(health, status)} /> },
    { key: "process", label: "Process", value: processText(health) },
    { key: "sign-in", label: "Sign-in", value: <StatusValue label={signInText(health, status, signIns)} /> },
    { key: "version", label: "Version", value: versionText(health, status) },
    { key: "latency", label: "First output", value: latencyText(health) },
  ];
  const observed: KeyValueItem[] = [
    { key: "failures", label: "Recent failures", value: failuresText(health, now) },
    { key: "rate-limit", label: "Rate limit", value: <StatusValue label={rateLimitText(health)} /> },
    { key: "trend", label: "Trend", value: trendLabel(health.trend) },
  ];
  if (hint) {
    observed.push({
      key: "recover",
      label: "What to do",
      value: (
        <span className={styles.install}>
          <span className={styles.prose}>{hint.text}</span>
          {hint.command ? (
            <code data-selectable className={styles.command}>
              {hint.command}
            </code>
          ) : null}
        </span>
      ),
    });
  }
  observed.push({
    key: "checked",
    label: "Last checked",
    value: (
      <span>
        {health.checkedAt ? <When iso={health.checkedAt} now={now} /> : "Not checked yet"}
        <span className={styles.statusDetail}>
          {" · observed "}
          <When iso={health.observedAt} now={now} />
        </span>
      </span>
    ),
  });

  return (
    <Panel
      id={`health-${health.providerId}`}
      data-health-state={health.state}
      className={styles.provider}
      title={<ProviderMark provider={health.providerId} name={health.displayName} tile size="md" />}
      padding="none"
    >
      <div className={styles.overview}>
        <KeyValueList items={state} className={styles.kv} />
        <KeyValueList items={observed} className={styles.kv} />
      </div>
      <HealthHistory name={health.displayName} rollups={rollups} now={now} />
    </Panel>
  );
}

const HOUR = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });

function hourRange(slot: HourSlot): string {
  const start = new Date(slot.hourStart);
  return `${HOUR.format(start)}–${HOUR.format(new Date(start.getTime() + 3_600_000))}`;
}

/**
 * Sessions and failures per hour over the last 24 hours: two small bar rows on one shared scale
 * (decorative; each bar has a hover title) with the same numbers as a table.
 */
function HealthHistory({
  name,
  rollups,
  now,
}: {
  name: string;
  rollups: HealthRollup[] | null | undefined;
  now: number;
}) {
  if (rollups === undefined) {
    return (
      <div className={healthStyles.history}>
        <Skeleton width="40%" />
      </div>
    );
  }
  if (rollups === null) {
    return (
      <div className={healthStyles.history}>
        <p className={healthStyles.historyHead}>
          <span className={healthStyles.historyTitle}>Last {HISTORY_HOURS} hours</span>
          <span className={styles.statusDetail}>History isn't available right now.</span>
        </p>
      </div>
    );
  }
  const slots = hourSlots(rollups, HISTORY_HOURS, now);
  const withData = slots.filter((s) => s.sessions > 0 || s.failures > 0 || s.backoffs > 0);
  const max = Math.max(1, ...slots.map((s) => Math.max(s.sessions, s.failures)));
  return (
    <div className={healthStyles.history}>
      <p className={healthStyles.historyHead}>
        <span className={healthStyles.historyTitle}>Last {HISTORY_HOURS} hours</span>
        <span className={healthStyles.historySummary}>{historySummary(slots)}</span>
      </p>
      {withData.length > 0 ? (
        <>
          <div className={healthStyles.chart} aria-hidden="true">
            <BarRow label="Sessions" slots={slots} value={(s) => s.sessions} max={max} kind="sessions" />
            <BarRow label="Failures" slots={slots} value={(s) => s.failures} max={max} kind="failures" />
            <div className={healthStyles.axis}>
              <span>{HISTORY_HOURS} h ago</span>
              <span>Now</span>
            </div>
          </div>
          <details className={healthStyles.details}>
            <summary>Hourly numbers</summary>
            <Table dense caption={`${name}: sessions and failures per hour, last ${HISTORY_HOURS} hours`} captionHidden>
              <thead>
                <tr>
                  <th scope="col">Hour</th>
                  <th scope="col" data-numeric>
                    Sessions
                  </th>
                  <th scope="col" data-numeric>
                    Failures
                  </th>
                  <th scope="col" data-numeric>
                    First output (p50)
                  </th>
                </tr>
              </thead>
              <tbody>
                {[...withData].reverse().map((slot) => (
                  <tr key={slot.hourStart}>
                    <th scope="row">
                      <time dateTime={slot.hourStart}>{hourRange(slot)}</time>
                    </th>
                    <td data-numeric>{slot.sessions}</td>
                    <td data-numeric>{slot.failures}</td>
                    <td data-numeric>{slot.latencyP50Ms !== null ? formatMs(slot.latencyP50Ms) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </details>
        </>
      ) : null}
    </div>
  );
}

function BarRow({
  label,
  slots,
  value,
  max,
  kind,
}: {
  label: string;
  slots: readonly HourSlot[];
  value: (slot: HourSlot) => number;
  max: number;
  kind: "sessions" | "failures";
}) {
  return (
    <div className={healthStyles.row}>
      <span className={healthStyles.rowLabel}>{label}</span>
      <div className={healthStyles.bars} data-kind={kind}>
        {slots.map((slot) => {
          const v = value(slot);
          return (
            <span
              key={slot.hourStart}
              className={healthStyles.bar}
              data-empty={v === 0 || undefined}
              style={{ height: v === 0 ? undefined : `${Math.max(12, (v / max) * 100)}%` }}
              title={`${hourRange(slot)}: ${v} ${label.toLowerCase()}`}
            />
          );
        })}
      </div>
    </div>
  );
}
