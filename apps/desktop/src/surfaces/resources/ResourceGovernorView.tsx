import type { PressureLevel, Reading, ResourceSnapshot, VolumeReading } from "@kalcode/protocol";
import { Button, ErrorState, Panel, Select, Skeleton } from "@kalcode/ui/components";
import { RefreshCw } from "lucide-react";
import type { ResourceReport } from "../../ipc/resources.ts";
import { Page } from "../../shell/Page.tsx";
import styles from "./ResourceGovernorView.module.css";
import {
  admissionSummary,
  formatBytes,
  freshnessSummary,
  pressureSummary,
  type ReadingSummary,
  readingSummary,
} from "./resourceModel.ts";
import { type PresetResourceMode, useResourceGovernor } from "./useResourceGovernor.ts";

export function ResourceGovernorView() {
  const data = useResourceGovernor();
  if (data.loading) {
    return (
      <Page title="Resources" description="Live machine pressure and room for new provider work.">
        <Panel as="div" className={styles.loading} role="status" aria-busy="true">
          <span className="visually-hidden">Loading resource telemetry</span>
          <Skeleton width="35%" height="1rem" />
          <Skeleton width="70%" />
          <Skeleton width="55%" />
        </Panel>
      </Page>
    );
  }
  if (!data.report) {
    return (
      <Page title="Resources" description="Live machine pressure and room for new provider work.">
        <ErrorState title="Resource status unavailable" actions={<Button onClick={data.refresh}>Try again</Button>}>
          <p>
            {data.error ?? "KalCode couldn't read resource status."} Local controls and running work are unaffected.
          </p>
        </ErrorState>
      </Page>
    );
  }
  return (
    <Page
      title="Resources"
      description="Live machine pressure and room for new provider work. KalCode never stops running work automatically."
      actions={
        <Button icon={<RefreshCw />} onClick={data.refresh}>
          Refresh
        </Button>
      }
    >
      {data.error ? (
        <p className={styles.refreshError} role="status">
          The latest refresh failed. Showing the previous observation.
        </p>
      ) : null}
      <ResourceGovernorContent report={data.report} changingMode={data.changingMode} onModeChange={data.changeMode} />
    </Page>
  );
}

export function ResourceGovernorContent({
  report,
  changingMode,
  onModeChange,
}: {
  report: ResourceReport;
  changingMode: boolean;
  onModeChange: (mode: PresetResourceMode) => void;
}) {
  const pressure = pressureSummary(report.snapshot.pressure);
  const freshness = freshnessSummary(report.freshness);
  const admission = admissionSummary(report.admission);
  const status = governorStatus(report);
  const metrics = metricRows(report.snapshot);
  const selectedMode = report.admission.mode ?? report.snapshot.mode;
  const modePending = report.admission.reasons.some((reason) => reason.kind === "snapshot_mode_mismatch");

  return (
    <div className={styles.stack}>
      <section className={styles.runway} aria-labelledby="resource-runway-title" data-pressure={pressure.level}>
        <div className={styles.runwayCopy}>
          <h2 id="resource-runway-title" className={styles.runwayTitle}>
            {pressure.label}
          </h2>
          <p className={styles.runwayDetail}>{pressure.detail}</p>
        </div>
        <ul className={styles.runwayStates} aria-label="Resource governor state">
          <StatePill label={status.label} tone={status.tone} />
          <StatePill label={freshness.label} tone={freshness.tone} />
        </ul>
      </section>

      <div className={styles.columns}>
        <Panel title="Live readings" description="Measured locally. Missing readings stay visibly unknown.">
          <dl className={styles.metrics}>
            {metrics.map(({ key, ...metric }) => (
              <Metric key={key} {...metric} />
            ))}
          </dl>
        </Panel>

        <aside className={styles.controlColumn} aria-label="Resource controls and admission">
          <Panel title="New work" description="Admission applies only when starting governed provider work.">
            <div className={styles.admission} data-tone={admission.tone}>
              <strong>{admission.label}</strong>
              <span>{admission.detail}</span>
              <span className={styles.continuity}>
                Running work continues. Local controls, sign-in and recovery stay available.
              </span>
            </div>
          </Panel>

          <Panel
            title="Mode"
            description="Changes thresholds and concurrency targets, never permissions. Resets to Balanced after restart."
          >
            <label className={styles.modeField} htmlFor="resource-mode">
              <span>Resource mode</span>
              <Select
                id="resource-mode"
                value={selectedMode}
                disabled={changingMode}
                onChange={(event) => {
                  const mode = event.currentTarget.value;
                  if (mode !== "custom") onModeChange(mode as PresetResourceMode);
                }}
              >
                <option value="conservative">Conservative</option>
                <option value="balanced">Balanced</option>
                <option value="performance">Performance</option>
                {selectedMode === "custom" ? <option value="custom">Custom</option> : null}
              </Select>
            </label>
            <p className={styles.modeNote} role="status">
              {changingMode || modePending
                ? `Waiting for a resource sample in ${selectedMode} mode…`
                : `Sampling in ${selectedMode} mode.`}
            </p>
          </Panel>
        </aside>
      </div>

      <ResourceHistory report={report} />
    </div>
  );
}

function StatePill({ label, tone }: { label: string; tone: string }) {
  return (
    <li className={styles.statePill} data-tone={tone}>
      <span className={styles.stateDot} aria-hidden="true" />
      {label}
    </li>
  );
}

interface MetricRow extends ReadingSummary {
  key: string;
  name: string;
  percent?: number;
}

function metricRows(snapshot: ResourceSnapshot): MetricRow[] {
  const cpu = readingSummary(snapshot.cpu, (value) => `${round(value.smoothedPercent)}%`);
  const memory = readingSummary(snapshot.memory, (value) => `${round(value.smoothedUsedPercent)}%`);
  return [
    {
      key: "cpu",
      name: "CPU",
      ...cpu,
      percent: snapshot.cpu.state === "value" ? snapshot.cpu.detail.smoothedPercent : undefined,
    },
    {
      key: "memory",
      name: "Memory",
      ...memory,
      percent: snapshot.memory.state === "value" ? snapshot.memory.detail.smoothedUsedPercent : undefined,
    },
    { key: "disk", name: "Workspace disk", ...volumeSummary(snapshot.volumes) },
    {
      key: "disk-io",
      name: "Disk throughput",
      ...readingSummary(
        snapshot.diskIo,
        (value) => `${formatRate(value.readBytesPerSec)} read · ${formatRate(value.writeBytesPerSec)} write`,
      ),
    },
    {
      key: "network",
      name: "Network",
      ...readingSummary(
        snapshot.network,
        (value) => `${formatRate(value.rxBytesPerSec)} received · ${formatRate(value.txBytesPerSec)} sent`,
      ),
    },
    {
      key: "kalcode",
      name: "KalCode",
      ...readingSummary(
        snapshot.kalcodeTree,
        (value) => `${formatBytes(value.totalRssBytes)} memory · ${round(value.totalCpuPercent)}% CPU`,
      ),
    },
    { key: "gpu", name: "GPU", ...gpuSummary(snapshot.gpu) },
    {
      key: "processes",
      name: "Processes",
      ...readingSummary(snapshot.processCount, (value) => value.toLocaleString()),
    },
  ];
}

function volumeSummary(reading: Reading<VolumeReading[]>): ReadingSummary {
  return readingSummary(reading, (volumes) => {
    if (volumes.length === 0) return "No workspace volume";
    const free = Math.min(...volumes.map((volume) => volume.freeBytes));
    return `${formatBytes(free)} free`;
  });
}

function gpuSummary(reading: ResourceSnapshot["gpu"]): ReadingSummary {
  if (reading.state !== "value") return readingSummary(reading, () => "Measured");
  return readingSummary(reading.detail.utilizationPercent, (value) => `${round(value)}%`);
}

function Metric({ name, label, detail, state, percent }: Omit<MetricRow, "key">) {
  return (
    <div className={styles.metric} data-reading-state={state}>
      <dt>{name}</dt>
      <dd>
        <span className={styles.metricValue}>{label}</span>
        {detail ? <span className={styles.metricDetail}>{detail}</span> : null}
        {percent !== undefined ? (
          <progress
            className={styles.meter}
            max={100}
            value={Math.max(0, Math.min(100, percent))}
            aria-label={`${name} use`}
          />
        ) : null}
      </dd>
    </div>
  );
}

function ResourceHistory({ report }: { report: ResourceReport }) {
  const points = report.history.slice(-60);
  return (
    <Panel title="Recent load" description="Up to the latest 60 bounded in-memory samples; nothing is written to disk.">
      {points.length === 0 ? (
        <p className={styles.emptyHistory}>History begins after the first resource samples arrive.</p>
      ) : (
        <div className={styles.history} role="img" aria-label={`CPU use across ${points.length} recent samples`}>
          {points.map((point) => (
            <span
              key={point.seq}
              className={styles.historyBar}
              data-unknown={point.cpuPercent === null ? true : undefined}
              style={{ height: point.cpuPercent === null ? "2px" : `${Math.max(2, Math.min(100, point.cpuPercent))}%` }}
              title={point.cpuPercent === null ? "CPU unknown" : `${round(point.cpuPercent)}% CPU`}
            />
          ))}
        </div>
      )}
      <p className={styles.samplerNote}>
        Sample {report.snapshot.seq.toLocaleString()} · next check in{" "}
        {formatInterval(report.snapshot.sampling.nextIntervalMs)} · last probe{" "}
        {report.stats.lastProbeMs.toLocaleString()} ms
      </p>
    </Panel>
  );
}

function governorStatus(report: ResourceReport): { label: string; tone: string } {
  switch (report.status.state) {
    case "running":
      return { label: "Sampler running", tone: "success" };
    case "starting":
      return { label: "Sampler starting", tone: "neutral" };
    case "degraded":
      return { label: "Sampler degraded", tone: "warning" };
    case "failed":
      return { label: "Sampler offline", tone: "danger" };
    case "stopped":
      return { label: "Sampler stopped", tone: "neutral" };
  }
}

function round(value: number): string {
  return Number.isInteger(value) ? value.toFixed(0) : value.toFixed(1);
}

function formatRate(bytesPerSecond: number): string {
  return `${formatBytes(bytesPerSecond)}/s`;
}

function formatInterval(milliseconds: number): string {
  return milliseconds >= 1_000 ? `${round(milliseconds / 1_000)} s` : `${milliseconds} ms`;
}

export function pressureTone(level: PressureLevel | "unknown"): string {
  if (level === "critical") return "danger";
  if (level === "high" || level === "elevated") return "warning";
  return level === "normal" ? "success" : "neutral";
}
