import type {
  AdapterState,
  MappingFidelity,
  PermissionMode,
  ProviderCapabilities,
  ProviderDetection,
  ProviderStatus,
} from "@kalcode/protocol";
import type { StatusTone } from "@kalcode/ui/components";

export interface Label {
  tone: StatusTone;
  label: string;
  /** Supporting sentence shown under the label, if any. */
  detail: string | null;
}

/** Installation state as detected. Never claims more than detection reported. */
export function detectionLabel(detection: ProviderDetection | null, errorCode: string | null = null): Label {
  if (!detection) return { tone: "idle", label: "Not checked yet", detail: null };
  switch (detection.state) {
    case "installed":
      return {
        tone: "success",
        label: detection.version ? `Installed, version ${detection.version}` : "Installed",
        detail: null,
      };
    case "outdated":
      return {
        tone: "waiting",
        label: detection.version ? `Outdated, version ${detection.version}` : "Outdated",
        detail:
          detection.message ??
          (detection.minimumVersion ? `KalCode needs version ${detection.minimumVersion} or later.` : null),
      };
    case "not_installed":
      return { tone: "idle", label: "Not installed", detail: null };
    case "error":
      return {
        tone: "danger",
        label: "Couldn't check",
        detail: [detection.message, errorCode ? `Error code: ${errorCode}.` : null].filter(Boolean).join(" ") || null,
      };
  }
}

/**
 * Sign-in state exactly as the provider's own documented status command reported it. KalCode
 * never signs in for the user, so there is no "connected" state here.
 */
export function authLabel(status: ProviderStatus): Label | null {
  const detection = status.detection;
  // Sign-in is only checked for an installed CLI.
  if (!detection || detection.state === "not_installed" || detection.state === "error") return null;
  const checkedWith = status.authCheck ? `Checked with ${status.authCheck}.` : null;
  switch (detection.auth) {
    case "authenticated":
      return { tone: "success", label: "Signed in", detail: checkedWith };
    case "not_authenticated":
      return { tone: "waiting", label: "Signed out", detail: checkedWith };
    case "unknown":
      return {
        tone: "idle",
        label: "Sign-in status unknown",
        detail: status.authCheck
          ? `${status.authCheck} didn't give a clear answer.`
          : `${status.displayName} has no documented way to check sign-in without starting a session.`,
      };
  }
}

/** Whether to show the "sign in with your own CLI" hint. */
export function needsSignIn(status: ProviderStatus): boolean {
  const detection = status.detection;
  if (!detection || detection.state === "not_installed" || detection.state === "error") return false;
  return detection.auth !== "authenticated";
}

/** Whether to show install guidance. */
export function needsInstall(status: ProviderStatus): boolean {
  return status.detection?.state === "not_installed";
}

export function adapterLabel(adapter: AdapterState): { badge: string; description: string } {
  return adapter === "implemented"
    ? { badge: "Adapter ready", description: "Ready for threads when installed and signed in." }
    : {
        badge: "Detection only",
        description: "Detection only. Threads can't use it until KalCode's adapter for it ships.",
      };
}

const FIDELITY: Record<MappingFidelity, string> = {
  exact: "Exact",
  approximate_stricter: "Stricter than requested",
  unsupported: "Not supported",
};

export function fidelityLabel(fidelity: MappingFidelity): string {
  return FIDELITY[fidelity];
}

const MODES: Record<PermissionMode, string> = {
  plan: "Plan",
  approve: "Approve",
  auto: "Auto",
  bypass: "Bypass",
  custom: "Custom",
};

export function modeLabel(mode: PermissionMode): string {
  return MODES[mode];
}

export interface CapabilityItem {
  key: keyof Omit<ProviderCapabilities, "models" | "permissionMappings">;
  label: string;
  supported: boolean;
}

export function capabilityItems(capabilities: ProviderCapabilities): CapabilityItem[] {
  return [
    { key: "streaming", label: "Streaming", supported: capabilities.streaming },
    { key: "interrupt", label: "Interrupt", supported: capabilities.interrupt },
    { key: "resume", label: "Resume", supported: capabilities.resume },
    { key: "hostApprovals", label: "Host approvals", supported: capabilities.hostApprovals },
  ];
}

/** Models as shown to users, or null when the provider can't list them up front. */
export function modelList(status: ProviderStatus): string | null {
  const models = status.capabilities.models;
  if (status.modelSource === "not_discoverable" || models.length === 0) return null;
  return models.map((m) => (m.isDefault ? `${m.displayName} (default)` : m.displayName)).join(", ");
}

export interface ProvidersSummary {
  checked: boolean;
  installed: number;
  total: number;
  /** Display names of installed (including outdated) providers. */
  installedNames: string[];
}

/** Summary for compact places such as the dashboard. Uses cached detection only. */
export function summarizeProviders(statuses: readonly ProviderStatus[]): ProvidersSummary {
  const installed = statuses.filter((s) => s.detection?.state === "installed" || s.detection?.state === "outdated");
  return {
    checked: statuses.some((s) => s.detection !== null),
    installed: installed.length,
    total: statuses.length,
    installedNames: installed.map((s) => s.displayName),
  };
}

/** Whether any provider still needs its first detection. */
export function needsFirstDetection(statuses: readonly ProviderStatus[]): boolean {
  return statuses.some((s) => s.detection === null);
}

/**
 * Splits a provider setting into flag groups ("--permission-mode plan") so a line break never
 * falls inside a flag or between a flag and its value.
 */
export function settingGroups(setting: string): string[] {
  const groups: string[] = [];
  for (const token of setting.split(/\s+/).filter(Boolean)) {
    const last = groups.length - 1;
    if (last >= 0 && !token.startsWith("-") && groups[last]?.startsWith("-") && !groups[last].includes(" ")) {
      groups[last] = `${groups[last]} ${token}`;
    } else {
      groups.push(token);
    }
  }
  return groups;
}
