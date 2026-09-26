import type {
  CapacityAdvice,
  CustomResourceLimits,
  GovernorMode,
  PressureLevel,
  ResourceHoldReason,
  ResourceKind,
  ResourceSnapshot,
} from "@kalcode/protocol";
import { invoke } from "@tauri-apps/api/core";

export type ResourceGovernorStatus =
  | { state: "starting" }
  | { state: "running" }
  | { state: "degraded"; reason: string }
  | { state: "failed"; reason: string }
  | { state: "stopped" };

export interface ResourceSamplerStats {
  samples: number;
  failedSamples: number;
  slowTierSamples: number;
  processTierSamples: number;
  totalProbeMs: number;
  lastProbeMs: number;
  maxProbeMs: number;
  maxProcessTierMs: number;
  droppedUpdates: number;
}

export interface ResourceFreshness {
  state: "fresh" | "stale" | "unavailable";
  ageMs: number | null;
  maxAgeMs: number;
  detail: string;
}

export type ResourceAdmissionReason =
  | { kind: "governor_not_ready"; status: ResourceGovernorStatus }
  | { kind: "snapshot_missing" }
  | { kind: "snapshot_from_future"; sampledAtUnixMs: number }
  | { kind: "snapshot_stale"; ageMs: number; maxAgeMs: number }
  | { kind: "snapshot_mode_mismatch"; snapshotMode: string; activeMode: string }
  | { kind: "required_telemetry_unknown"; resource: ResourceKind; detail: string }
  | { kind: "required_telemetry_unavailable"; resource: ResourceKind; detail: string }
  | { kind: "capacity_unavailable" }
  | { kind: "capacity"; holds: ResourceHoldReason[] };

export interface ResourceAdmissionDecision {
  state: "allowed" | "held";
  mode: GovernorMode | null;
  additional: number;
  reasons: ResourceAdmissionReason[];
  snapshotSeq: number | null;
  sampledAtUnixMs: number | null;
}

export interface ResourceHistoryPoint {
  seq: number;
  sampledAtUnixMs: number;
  cpuPercent: number | null;
  memoryUsedPercent: number | null;
  pressure: PressureLevel | null;
}

export interface ResourcePressureTransition {
  resource: ResourceKind;
  from: PressureLevel;
  to: PressureLevel;
  mode: GovernorMode;
  seq: number;
  atUnixMs: number;
}

export interface ResourceReport {
  status: ResourceGovernorStatus;
  snapshot: ResourceSnapshot;
  history: ResourceHistoryPoint[];
  transitions: ResourcePressureTransition[];
  stats: ResourceSamplerStats;
  capacity: CapacityAdvice;
  admission: ResourceAdmissionDecision;
  freshness: ResourceFreshness;
}

export type ResourceModeSelection =
  | { mode: "conservative" }
  | { mode: "balanced" }
  | { mode: "performance" }
  | ({ mode: "custom" } & CustomResourceLimits);

export function getResourceReport(): Promise<ResourceReport> {
  return invoke<ResourceReport>("resource_report");
}

export function setResourceMode(mode: ResourceModeSelection): Promise<ResourceReport> {
  return invoke<ResourceReport>("resource_set_mode", { mode });
}

/** Reports view visibility only; scheduler-owned running-work counts are preserved natively. */
export function setResourceViewOpen(open: boolean): Promise<void> {
  return invoke<void>("resource_set_view_open", { open });
}
