import type {
  AdapterState,
  MappingFidelity,
  PermissionMode,
  ProviderAccount,
  ProviderCapabilities,
  ProviderDetection,
  ProviderStatus,
  ToolCapability,
  ToolKind,
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
 * Sign-in state exactly as provider detection reported it. Installation/version detection may
 * intentionally leave auth unknown when a safe standalone status probe does not exist.
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
          : status.id === "claude-code"
            ? "Sign-in is checked when a Claude Code session starts."
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

/**
 * One line under Setup's Sign in button for a provider whose only supported sign-in for KalCode
 * is the managed account (its own isolated profile). `null` keeps the provider's own command
 * guidance. A terminal login would sign in a different profile, so it is never suggested.
 */
export function accountSignInHint(status: Pick<ProviderStatus, "id" | "displayName">): string | null {
  if (status.id === "cursor")
    return "Cursor opens its official browser sign-in and keeps the session in its native profile.";
  const opens: Record<string, string> = {
    "gemini-cli": "Gemini opens Google sign-in",
    "claude-code": "Claude Code opens its sign-in",
    codex: "Codex opens ChatGPT sign-in",
  };
  const provider = opens[status.id];
  return provider ? `${provider} in your browser for that account only.` : null;
}

/**
 * Sign-in for a managed provider, read from KalCode's own accounts: the one authoritative state
 * the Accounts tab shows too. `null` while the accounts haven't loaded.
 */
export function managedSignInLabel(
  accounts: readonly Pick<ProviderAccount, "authenticationState">[] | null,
): Label | null {
  if (!accounts) return null;
  const signedIn = accounts.filter((account) => account.authenticationState === "authenticated").length;
  if (signedIn > 0) {
    return {
      tone: "success",
      label: `Signed in (${signedIn} ${signedIn === 1 ? "account" : "accounts"})`,
      detail: null,
    };
  }
  if (accounts.length === 0) return { tone: "idle", label: "No account yet", detail: null };
  return { tone: "waiting", label: "Not signed in", detail: null };
}

/**
 * "Same sign-in as Work" when another KalCode account of the same provider reports the same
 * provider identity: both names share one provider login, so they share its plan and usage.
 */
export function sameSignInLabel(
  account: Pick<ProviderAccount, "id" | "providerId" | "providerReportedIdentity">,
  accounts: readonly Pick<
    ProviderAccount,
    "id" | "providerId" | "providerReportedIdentity" | "displayName" | "isDefault" | "archivedAt"
  >[],
): string | null {
  const identity = account.providerReportedIdentity?.trim().toLowerCase();
  if (!identity) return null;
  const twins = accounts.filter(
    (other) =>
      other.id !== account.id &&
      other.archivedAt === null &&
      other.providerId === account.providerId &&
      other.providerReportedIdentity?.trim().toLowerCase() === identity,
  );
  if (twins.length === 0) return null;
  const [first] = [...twins].sort(
    (a, b) =>
      Number(b.isDefault) - Number(a.isDefault) ||
      a.displayName.localeCompare(b.displayName, undefined, { numeric: true, sensitivity: "base" }),
  );
  const name = first?.displayName.trim() || "Unnamed account";
  return twins.length === 1 ? `Same sign-in as ${name}` : `Same sign-in as ${name} +${twins.length - 1}`;
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

const TOOL_LABELS: Record<ToolKind, string> = {
  shell: "Shell",
  file_read: "Read files",
  file_edit: "Edit files",
  repo_search: "Search repo",
  web_search: "Web search",
  web_fetch: "Fetch pages",
  mcp: "MCP servers",
  subagents: "Subagents",
  extensions: "Plugins & extensions",
};

export interface ToolItem {
  kind: ToolKind;
  label: string;
  /** "native": works as in the provider's terminal. */
  state: ToolCapability["availability"]["state"];
  /** Short word for the state; the full reason travels in `detail`. */
  value: string;
  detail: string | null;
}

/**
 * The provider's own tools as its adapter declares them (truthful: never padded to look like
 * another provider). Unavailable tools say why.
 */
export function toolItems(capabilities: ProviderCapabilities): ToolItem[] {
  return capabilities.tools.map((tool) => {
    const availability = tool.availability;
    const name = tool.providerName ? `${tool.providerName}. ` : "";
    const base = { kind: tool.kind, label: TOOL_LABELS[tool.kind], state: availability.state };
    if (availability.state === "needs_setup") {
      return { ...base, value: "Needs setup", detail: availability.detail };
    }
    if (availability.state === "unavailable") {
      return { ...base, value: "Not offered", detail: availability.reason };
    }
    const detail = `${name}${tool.note ?? ""}`.trim();
    return { ...base, value: "Native", detail: detail || null };
  });
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

/**
 * Toast title for a failed browser sign-in. An installed CLI release outside the certified range
 * is not a sign-in failure the person can retry past, so it is named for what it is; the native
 * message (which names the found and supported versions, or a safe reason code) is the detail.
 */
export function signInFailureTitle(providerName: string, errorCode: string): string {
  return errorCode === "provider_version_unsupported"
    ? `${providerName} version isn't supported yet`
    : `${providerName} sign-in didn't finish`;
}
