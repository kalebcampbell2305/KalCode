import type { KalVoiceStatus, LocalReasoningStatus } from "@kalcode/protocol";

/** The on-device interpreter's state as shown to the owner. */
export interface LocalIntelligenceView {
  tone: "waiting" | "success" | "outline" | "danger";
  /** Short state, e.g. for a badge or a settings row. */
  label: string;
  detail: string;
  /** Whether "Retry local startup" can help now. */
  retry: boolean;
}

/** What the governor is waiting for before it admits the interpreter's start. */
const WAITING: Record<string, { label: string; detail: string }> = {
  resource_monitor_starting: {
    label: "Waiting for resource readings",
    detail:
      "KalCode starts the on-device interpreter automatically once its resource monitor has current CPU and memory readings, usually within 15 seconds.",
  },
  memory_headroom: {
    label: "Waiting for memory headroom",
    detail: "KalCode starts the on-device interpreter automatically when enough memory is free.",
  },
  cpu_headroom: {
    label: "Waiting for CPU headroom",
    detail: "KalCode starts the on-device interpreter automatically when the CPU is less busy.",
  },
  resource_pressure: {
    label: "Waiting for system pressure to ease",
    detail: "KalCode starts the on-device interpreter automatically when this computer is under less pressure.",
  },
};

/** Why an automatic start gave up, in owner terms. Unlisted codes are shown as-is. */
const FAILED: Record<string, string> = {
  capacity_wait_exhausted: "KalCode waited 15 minutes for enough memory or CPU headroom.",
  resource_monitor_unavailable: "KalCode's resource monitor isn't running, so it can't safely start the interpreter.",
  worker_health_timeout: "The interpreter didn't become ready in time.",
  worker_start_failed: "The interpreter process couldn't start.",
  worker_exited: "The interpreter process stopped while starting.",
  worker_guardian_unavailable: "KalCode's process guardian isn't available to run the interpreter.",
  worker_cleanup_unproven: "A previous interpreter process couldn't be confirmed stopped.",
};

const FIXED: Record<Exclude<LocalReasoningStatus, "waiting" | "failed">, LocalIntelligenceView> = {
  not_installed: {
    tone: "waiting",
    label: "Not installed",
    detail: "Direct commands work now. Download the on-device interpreter for other supported phrasing.",
    retry: false,
  },
  installed: {
    tone: "waiting",
    label: "Installed; not running",
    detail: "The local interpreter is installed. Retry startup in KalVoice settings.",
    retry: true,
  },
  warming: {
    tone: "waiting",
    label: "Starting",
    detail: "The on-device interpreter is starting. Direct commands remain available.",
    retry: false,
  },
  ready: {
    tone: "success",
    label: "Ready",
    detail: "The on-device interpreter handles supported phrasing without a connected provider.",
    retry: false,
  },
  unavailable: {
    tone: "outline",
    label: "Unavailable",
    detail: "Direct commands remain available. Check local interpreter startup in KalVoice settings.",
    retry: true,
  },
};

/** Maps native readiness (and its safe reason code) to the owner-facing state. */
export function localIntelligence(
  status: Pick<KalVoiceStatus, "localReasoning" | "localReasoningIssue"> | null | undefined,
): LocalIntelligenceView {
  const readiness = status?.localReasoning ?? "unavailable";
  const issue = status?.localReasoningIssue;
  if (readiness === "waiting") {
    const waiting = (issue && WAITING[issue]) || {
      label: "Waiting for capacity",
      detail: "KalCode starts the on-device interpreter automatically when this computer has room for it.",
    };
    return { tone: "waiting", ...waiting, detail: `${waiting.detail} Direct commands remain available.`, retry: false };
  }
  if (readiness === "failed") {
    const reason = (issue && FAILED[issue]) || (issue ? `Startup failed (${issue}).` : "Startup failed.");
    return {
      tone: "danger",
      label: issue ? `Couldn't start: ${issue}` : "Couldn't start",
      detail: `${reason} Direct commands remain available. Retry startup in KalVoice settings.`,
      retry: true,
    };
  }
  return FIXED[readiness];
}
