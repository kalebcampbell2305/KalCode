export type UpdateChannel = "stable" | "beta" | "dev";

export type UpdatePhase = "idle" | "checking" | "downloading" | "ready" | "up_to_date" | "installing" | "failed";

/** User-safe updater state. Native never exposes feed bodies, local paths, signatures, or keys. */
export interface UpdateStatus {
  channel: UpdateChannel;
  phase: UpdatePhase;
  currentVersion: string;
  availableVersion: string | null;
  downloadedBytes: number;
  totalBytes: number | null;
  lastError: string | null;
  recoveryAvailable: boolean;
}
