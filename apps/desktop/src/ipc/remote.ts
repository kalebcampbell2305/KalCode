/** KalCode Remote (Settings › Remote). Mirrors `RemoteStatus` in `src-tauri/src/remote/mod.rs`. */

/** The native cue to re-read `remote_status` (a device connected, paired or was removed). */
export const REMOTE_CHANGED_EVENT = "remote-changed";

export interface RemoteStatusError {
  code: string;
  message: string;
}

export interface RemotePairing {
  /** `kalcode-remote://pair?d=…`, single use. */
  link: string;
  /** The link as a QR code: SVG with dark modules on white. */
  qrSvg: string;
  /** Unix seconds. */
  expiresAt: number;
}

export interface RemoteDevice {
  id: string;
  name: string;
  platform: string;
  model: string;
  app: string;
  pairedAt: string;
  lastSeenAt: string | null;
  online: boolean;
}

export interface RemoteStatus {
  /** This account may use Remote (MAX and up). */
  available: boolean;
  enabled: boolean;
  listening: boolean;
  port: number | null;
  /** `ip:port` a device can reach. */
  addresses: string[];
  error: RemoteStatusError | null;
  machineName: string;
  pairing: RemotePairing | null;
  devices: RemoteDevice[];
}
