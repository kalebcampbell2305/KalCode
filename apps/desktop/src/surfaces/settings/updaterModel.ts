import type { KalCodeClient } from "../../ipc/client.ts";
import type { UpdateChannel, UpdateStatus } from "../../ipc/updater.ts";
import { formatVersion, publicVersion, sameVersionBuild } from "../../platform/version.ts";

const CHANNEL_LABELS: Record<UpdateChannel, string> = { stable: "Stable", beta: "Beta", dev: "Dev" };

/**
 * The update channels Settings offers. A Stable build never offers Dev (engineering builds with
 * unfinished changes); a channel already selected stays listed so the control shows the truth.
 */
export function channelOptions(
  buildChannel: string,
  current: UpdateChannel,
): { value: UpdateChannel; label: string }[] {
  const offered: UpdateChannel[] = buildChannel === "stable" ? ["stable", "beta"] : ["stable", "beta", "dev"];
  if (!offered.includes(current)) offered.push(current);
  return offered.map((value) => ({ value, label: CHANNEL_LABELS[value] }));
}

export interface UpdatePresentation {
  label: string;
  detail: string;
  progress: number | null;
}

export function updatePresentation(status: UpdateStatus): UpdatePresentation {
  switch (status.phase) {
    case "checking":
      return {
        label: "Checking for updates",
        detail: "Contacting the selected KalCode update channel.",
        progress: null,
      };
    case "downloading": {
      const progress =
        status.totalBytes && status.totalBytes > 0
          ? Math.min(100, Math.round((status.downloadedBytes / status.totalBytes) * 100))
          : null;
      return {
        label: status.availableVersion
          ? `Downloading KalCode ${formatVersion(status.availableVersion)}`
          : "Downloading update",
        detail: progress === null ? "Downloading and verifying the signed release." : `${progress}% downloaded`,
        progress,
      };
    }
    case "ready":
      return {
        label: status.availableVersion ? readyLabel(status.currentVersion, status.availableVersion) : "Update ready",
        detail: "Your work stays open until you choose to restart and install.",
        progress: 100,
      };
    case "up_to_date":
      return {
        label: "KalCode is up to date",
        detail: `Version ${formatVersion(status.currentVersion)}`,
        progress: null,
      };
    case "installing":
      return {
        label: "Restarting to install",
        detail: "KalCode is preserving active work before the installer starts.",
        progress: null,
      };
    case "failed":
      return {
        label: "Update check needs attention",
        detail: status.lastError ?? "KalCode couldn't complete the update safely.",
        progress: null,
      };
    default:
      return {
        label: `KalCode ${formatVersion(status.currentVersion)}`,
        detail:
          "Updates download in the background only after their signatures and release metadata pass verification.",
        progress: null,
      };
  }
}

/**
 * "A new KalCode 0.1.7 build is ready (build 780)" for a newer build of the running public
 * version; "KalCode 0.1.8 build 900 is ready" across public versions.
 */
export function readyLabel(currentVersion: string | null | undefined, availableVersion: string): string {
  const build = sameVersionBuild(currentVersion, availableVersion);
  return build === null
    ? `KalCode ${formatVersion(availableVersion)} is ready`
    : `A new KalCode ${publicVersion(availableVersion)} build is ready (build ${build})`;
}

/**
 * The one restart-and-install path. Settings → Updates and the shell's update-ready notice both
 * call it, and only after an explicit user action: native closes active work safely, then
 * restarts into the verified update.
 */
export function restartAndInstall(client: Pick<KalCodeClient, "updaterInstall">): Promise<void> {
  return client.updaterInstall();
}
