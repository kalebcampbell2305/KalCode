import type { ComponentProvisioning, KalVoiceStatus, LocalReasoningStatus } from "@kalcode/protocol";
import { formatBytes } from "./assistantState.ts";
import {
  failureReason,
  LOCAL_REASONING_ID,
  provisioningFor,
  retryWhen,
  SIGNED_CATALOG,
  stoppedReason,
  waitingReason,
} from "./readiness.ts";

/** The on-device interpreter's state as shown to the owner. */
export interface LocalIntelligenceView {
  tone: "waiting" | "success" | "outline" | "danger";
  /** Short state, e.g. for a badge or a settings row. */
  label: string;
  detail: string;
  /** Whether "Retry now" can help now. */
  retry: boolean;
  /** An automatic download is running or waiting: it can be paused. */
  pausable?: boolean;
  /** The automatic download is paused: it can be resumed. */
  resumable?: boolean;
  /** Automatic preparation stopped: offer the owner's own reviewed download. */
  manual?: boolean;
  /** Bytes so far while downloading. */
  progress?: { received: number; total: number };
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

/** Why an automatic start round ended, in owner terms. Unlisted codes are shown as-is. */
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
    detail: "The local interpreter is installed. KalCode starts it automatically.",
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

/** The size shown before the signed catalog states it exactly. */
const APPROXIMATE_SIZE = "about 850 MB";

const DIRECT = "Direct commands work now.";

/** The automatic (or owner-started) local-intelligence download, as the owner sees it. */
function preparing(item: ComponentProvisioning): LocalIntelligenceView {
  const size = item.totalBytes > 0 ? formatBytes(item.totalBytes) : APPROXIMATE_SIZE;
  const pausable = item.automatic;
  switch (item.phase) {
    case "preparing":
      return {
        tone: "waiting",
        label: `Preparing local intelligence (${size})…`,
        detail: `Preparing local intelligence (${size}) from ${SIGNED_CATALOG}… It is downloaded once and verified before use. ${DIRECT}`,
        retry: false,
        pausable,
      };
    case "downloading":
      return {
        tone: "waiting",
        label: `Preparing local intelligence (${size})…`,
        detail: `Preparing local intelligence (${size}) from ${SIGNED_CATALOG}… Downloading ${formatBytes(item.receivedBytes)} of ${size}. It is verified before use. ${DIRECT}`,
        retry: false,
        pausable,
        progress: { received: item.receivedBytes, total: item.totalBytes },
      };
    case "verifying":
      return {
        tone: "waiting",
        label: "Verifying local intelligence",
        detail: `Checking signatures and checksums before installing. ${DIRECT}`,
        retry: false,
        pausable,
      };
    case "waiting_for_resources":
    case "waiting_for_talk":
      return {
        tone: "waiting",
        label: "Waiting for system resources",
        detail: `The local intelligence download (${size}) continues when ${waitingReason(item.reason)}. ${DIRECT}`,
        retry: false,
        pausable,
      };
    case "paused":
      return {
        tone: "outline",
        label: "Paused",
        detail:
          item.receivedBytes > 0
            ? `Local intelligence is paused at ${formatBytes(item.receivedBytes)} of ${size}. Resume continues where it stopped. ${DIRECT}`
            : `Local intelligence (${size}) is paused. ${DIRECT}`,
        retry: false,
        resumable: true,
      };
    case "retry_scheduled":
      return {
        tone: "outline",
        label: "Unavailable",
        detail: `Couldn't download local intelligence: ${failureReason(item.reason)}. KalCode retries ${retryWhen(item.retryInSeconds)}, and when you return to KalCode. ${DIRECT}`,
        retry: false,
        pausable,
      };
    case "unavailable":
      return {
        tone: "outline",
        label: "Unavailable",
        detail: `${stoppedReason(item.reason)}. KalCode won't retry automatically until it restarts; you can still use Review download. ${DIRECT}`,
        retry: false,
        manual: true,
      };
  }
}

type LocalIntelligenceStatus = Pick<KalVoiceStatus, "localReasoning" | "localReasoningIssue"> &
  Partial<Pick<KalVoiceStatus, "provisioning" | "preferences" | "activeModel">>;

/** Maps native readiness (its safe reason code and any download) to the owner-facing state. */
export function localIntelligence(status: LocalIntelligenceStatus | null | undefined): LocalIntelligenceView {
  const readiness = status?.localReasoning ?? "unavailable";
  const issue = status?.localReasoningIssue;
  if (readiness === "not_installed") {
    const item = provisioningFor(status, LOCAL_REASONING_ID);
    if (item) return preparing(item);
    const preferences = status?.preferences;
    if (preferences?.localIntelligenceAuto && !preferences.localIntelligencePaused) {
      return status?.activeModel
        ? {
            tone: "waiting",
            label: `Preparing local intelligence (${APPROXIMATE_SIZE})…`,
            detail: `Preparing local intelligence (${APPROXIMATE_SIZE}) from ${SIGNED_CATALOG}… It is downloaded once and verified before use. ${DIRECT}`,
            retry: false,
            pausable: true,
          }
        : {
            tone: "waiting",
            label: "Waiting for speech",
            detail: `KalCode prepares local intelligence (${APPROXIMATE_SIZE}) after the speech model is ready. ${DIRECT}`,
            retry: false,
            pausable: true,
          };
    }
    if (preferences?.localIntelligenceAuto && preferences.localIntelligencePaused) {
      return {
        tone: "outline",
        label: "Paused",
        detail: `Local intelligence (${APPROXIMATE_SIZE}) is paused. ${DIRECT}`,
        retry: false,
        resumable: true,
      };
    }
  }
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
      detail: `${reason} KalCode retries automatically, and when you return to KalCode. Direct commands remain available.`,
      retry: true,
    };
  }
  return FIXED[readiness];
}
