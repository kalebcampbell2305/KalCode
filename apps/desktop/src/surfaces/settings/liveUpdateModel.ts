import type { LiveStatus } from "../../ipc/liveUpdate.ts";
import { formatVersion } from "../../platform/version.ts";

export interface LiveUpdateLine {
  label: string;
  detail: string;
  tone: "neutral" | "success" | "warning";
}

function seconds(ms: number | null): string | null {
  if (ms === null) return null;
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

/** The one Live Update line under the update status, or null when there is nothing to say. */
export function liveUpdateLine(status: LiveStatus | null): LiveUpdateLine | null {
  if (!status) return null;
  if ((status.phase === "ROLLED_BACK" || status.phase === "FAILED") && status.lastError) {
    return { label: "Live update", detail: status.lastError, tone: "warning" };
  }
  if (status.pendingVersion && status.pendingClass === "core") {
    const waiting = status.waitingFor ? ` Waiting because ${status.waitingFor}.` : "";
    return {
      label: `${formatVersion(status.pendingVersion)} is ready`,
      detail: `It changes KalCode's core, so KalCode applies it in a quick handoff when that won't interrupt running terminals or agents, or when you close KalCode.${waiting}`,
      tone: "neutral",
    };
  }
  if (status.pendingVersion && (status.phase === "LIVE_APPLYING" || status.phase === "DOWNLOADING")) {
    return {
      label: `Applying ${formatVersion(status.pendingVersion)}`,
      detail: "The new interface loads at the next pause in your typing. Terminals and agents keep running.",
      tone: "neutral",
    };
  }
  if (status.lastUpdated) {
    const took =
      status.lastUpdated.class === "ui"
        ? seconds(status.timings.rendererRefreshMs)
        : seconds(status.timings.coreHandoffMs);
    return {
      label: `Updated to ${formatVersion(status.lastUpdated.version)} without a restart`,
      detail:
        status.lastUpdated.class === "ui"
          ? `Applied live${took ? ` in ${took}` : ""}. Terminals and agents kept running.`
          : `Applied in a quick handoff${took ? ` (${took})` : ""}; your workspace was restored.`,
      tone: "success",
    };
  }
  if (status.uiVersion !== status.shellVersion) {
    return {
      label: `Interface ${formatVersion(status.uiVersion)}`,
      detail: `Applied live on KalCode core ${formatVersion(status.shellVersion)}.`,
      tone: "success",
    };
  }
  return null;
}
