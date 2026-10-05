import type { PressureLevel, PressureSummary, Reading, ResourceKind } from "@kalcode/protocol";
import type {
  ResourceAdmissionDecision,
  ResourceAdmissionReason,
  ResourceFreshness,
  ResourceHardPressure,
} from "../../ipc/resources.ts";

export type ResourceTone = "neutral" | "success" | "warning" | "danger";

export interface ReadingSummary {
  label: string;
  detail: string | null;
  state: "value" | "unknown" | "unavailable";
}

export function readingSummary<T>(reading: Reading<T>, format: (value: T) => string): ReadingSummary {
  if (reading.state === "value") {
    return { label: format(reading.detail), detail: null, state: "value" };
  }
  return {
    label: reading.state === "unknown" ? "Unknown" : "Unavailable",
    detail: reading.detail,
    state: reading.state,
  };
}

const PRESSURE_ORDER: Record<PressureLevel, number> = {
  normal: 0,
  elevated: 1,
  high: 2,
  critical: 3,
};

const RESOURCE_LABELS: Record<ResourceKind, string> = {
  cpu: "CPU",
  memory: "Memory",
  gpu: "GPU",
  vram: "VRAM",
  disk_io: "Disk I/O",
  disk_space: "Disk space",
  network: "Network",
  process_count: "Process count",
};

export function resourceLabel(resource: ResourceKind): string {
  return RESOURCE_LABELS[resource];
}

export function pressureSummary(pressure: PressureSummary): {
  level: PressureLevel | "unknown";
  label: string;
  detail: string;
} {
  const worst = pressure.entries.reduce<(typeof pressure.entries)[number] | null>(
    (current, entry) => (!current || PRESSURE_ORDER[entry.level] > PRESSURE_ORDER[current.level] ? entry : current),
    null,
  );
  const unknown = pressure.unknown.map(resourceLabel);
  const unknownDetail =
    unknown.length === 0 ? "" : `${joinNames(unknown)} ${unknown.length === 1 ? "has" : "have"} no current reading.`;

  if (!worst) {
    return {
      level: "unknown",
      label: "Pressure unknown",
      detail: unknownDetail || "The sampler has not measured a governed resource yet.",
    };
  }

  const limiting =
    worst.level === "normal"
      ? "No measured resource is limiting new work."
      : `${resourceLabel(worst.resource)} is limiting new work.`;
  return {
    level: worst.level,
    label: `${capitalize(worst.level)} pressure`,
    detail: [limiting, unknownDetail].filter(Boolean).join(" "),
  };
}

export function freshnessSummary(freshness: ResourceFreshness): { label: string; tone: ResourceTone } {
  switch (freshness.state) {
    case "fresh":
      return { label: "Current", tone: "success" };
    case "stale":
      return { label: "Stale", tone: "warning" };
    case "unavailable":
      return { label: "No current sample", tone: "danger" };
  }
}

/** Above this, `additional` means "no count limit applies" (the governor reports u32::MAX). */
const UNLIMITED = 1_000_000;

/**
 * Coding agents you start: they start immediately unless genuine hard pressure (critically low
 * memory, a full disk) or your own Custom limit holds them. CPU load never does.
 */
export function admissionSummary(decision: ResourceAdmissionDecision): {
  label: string;
  detail: string;
  tone: ResourceTone;
} {
  if (decision.state === "allowed") {
    return {
      label: "New coding agents start immediately",
      detail:
        decision.additional < UNLIMITED
          ? `${decision.additional} more ${decision.additional === 1 ? "agent fits" : "agents fit"} your Custom limit.`
          : "CPU load never delays an agent you start; KalCode slows optional background work instead.",
      tone: "success",
    };
  }
  const hard = decision.reasons.find((reason) => reason.kind === "hard_pressure");
  return {
    label: "New coding agents are waiting",
    detail: hard ? hardPressureText(hard.pressure) : admissionReasonText(prioritizedReason(decision.reasons)),
    tone: "warning",
  };
}

/** Optional background work (local models, downloads): it yields first under load. */
export function backgroundAdmissionSummary(decision: ResourceAdmissionDecision): {
  label: string;
  detail: string;
  tone: ResourceTone;
} {
  if (decision.state === "allowed") {
    return { label: "Background work can run", detail: "Local models and downloads can start.", tone: "success" };
  }
  return {
    label: "Background work is yielding",
    detail: admissionReasonText(prioritizedReason(decision.reasons)),
    tone: "warning",
  };
}

function hardPressureText(pressure: ResourceHardPressure): string {
  switch (pressure.kind) {
    case "memory_critical":
      return `Memory is critically low (${pressure.availableMb} MB free). Start Anyway is available on each waiting agent.`;
    case "commit_exhausted":
      return `Memory is critically low (${pressure.remainingMb} MB of commit left). Start Anyway is available on each waiting agent.`;
    case "disk_full":
      return `The disk is almost full (${pressure.freeMb} MB free on ${pressure.mount}). Start Anyway is available on each waiting agent.`;
  }
}

function prioritizedReason(reasons: readonly ResourceAdmissionReason[]): ResourceAdmissionReason | undefined {
  const priority: ResourceAdmissionReason["kind"][] = [
    "snapshot_from_future",
    "snapshot_stale",
    "snapshot_mode_mismatch",
    "snapshot_missing",
    "governor_not_ready",
    "required_telemetry_unknown",
    "required_telemetry_unavailable",
    "hard_pressure",
    "capacity",
    "capacity_unavailable",
  ];
  return priority.flatMap((kind) => reasons.filter((reason) => reason.kind === kind))[0];
}

function admissionReasonText(reason: ResourceAdmissionReason | undefined): string {
  switch (reason?.kind) {
    case "snapshot_stale":
    case "snapshot_missing":
      return "Waiting for a current resource sample.";
    case "snapshot_from_future":
      return "The sampler clock is inconsistent. Background work stays paused until a current sample arrives.";
    case "snapshot_mode_mismatch":
      return "Waiting for a resource sample under the selected mode.";
    case "governor_not_ready":
      return "Resource monitoring is not ready. Running work continues.";
    case "required_telemetry_unknown":
      return `Waiting for a current ${resourceLabel(reason.resource)} reading.`;
    case "required_telemetry_unavailable":
      return `${resourceLabel(reason.resource)} telemetry is unavailable for this workload.`;
    case "capacity":
      return "CPU or memory headroom, pressure or your Custom limit leave no room right now.";
    case "hard_pressure":
      return hardPressureText(reason.pressure);
    case "capacity_unavailable":
    case undefined:
      return "Capacity cannot be verified right now.";
  }
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"] as const;
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** exponent;
  const rounded = value >= 10 || Number.isInteger(value) ? value.toFixed(0) : value.toFixed(1);
  return `${rounded} ${units[exponent]}`;
}

function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(", ")}, and ${names.at(-1)}`;
}

function capitalize(value: string): string {
  return value.length === 0 ? value : `${value[0]?.toUpperCase()}${value.slice(1)}`;
}
