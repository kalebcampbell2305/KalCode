import type { UpdateChannel, UpdateStatus } from "../updater.ts";
import type { DashboardHandlers } from "./dashboard.ts";

const CHANNELS: ReadonlySet<string> = new Set(["stable", "beta", "dev"]);

export function createUpdaterMemory(currentVersion: string): { handlers: DashboardHandlers } {
  let status: UpdateStatus = {
    channel: "stable",
    phase: "idle",
    currentVersion,
    availableVersion: null,
    downloadedBytes: 0,
    totalBytes: null,
    lastError: null,
    recoveryAvailable: false,
  };

  const snapshot = () => structuredClone(status);
  return {
    handlers: {
      updater_status: snapshot,
      updater_set_channel: (args) => {
        const channel = args.channel;
        if (typeof channel !== "string" || !CHANNELS.has(channel)) {
          throw {
            category: "update",
            code: "update_channel_invalid",
            message: "Choose Stable, Beta, or Dev.",
            retryable: false,
          };
        }
        status = {
          ...status,
          channel: channel as UpdateChannel,
          phase: "idle",
          availableVersion: null,
          downloadedBytes: 0,
          totalBytes: null,
          lastError: null,
        };
        return snapshot();
      },
      updater_check: () => {
        status = { ...status, phase: "up_to_date", lastError: null };
        return snapshot();
      },
      updater_cancel: () => {
        if (status.phase === "installing") {
          throw {
            category: "update",
            code: "update_busy",
            message: "An update operation is already running.",
            retryable: false,
          };
        }
        status = {
          ...status,
          phase: "idle",
          availableVersion: null,
          downloadedBytes: 0,
          totalBytes: null,
          lastError: null,
        };
        return snapshot();
      },
      updater_install: () => {
        if (status.phase !== "ready") {
          throw {
            category: "update",
            code: "update_not_ready",
            message: "No verified update is ready to install.",
            retryable: false,
          };
        }
      },
      updater_restore_previous: () => {
        if (!status.recoveryAvailable) {
          throw {
            category: "update",
            code: "rollback_unavailable",
            message: "No verified previous version is available.",
            retryable: false,
          };
        }
      },
    },
  };
}
