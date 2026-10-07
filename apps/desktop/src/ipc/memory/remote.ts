import type { RemoteStatus } from "../remote.ts";
import type { DashboardHandlers } from "./dashboard.ts";

/** A tiny QR-like SVG for the browser fake (the native one encodes the real link). */
const FAKE_QR =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 21 21" shape-rendering="crispEdges"><rect width="21" height="21" fill="#ffffff"/><path fill="#000000" d="M0 0h7v7H0zM14 0h7v7h-7zM0 14h7v7H0zM2 2h3v3H2zM16 2h3v3h-3zM2 16h3v3H2zM9 1h1v2H9zM11 3h2v1h-2zM8 8h5v5H8zM15 9h2v2h-2zM18 12h2v2h-2zM9 15h3v2H9zM14 15h2v4h-2zM17 17h3v3h-3z"/></svg>';

/** KalCode Remote for the browser fake: off until turned on, one paired phone. */
export function createRemoteMemory(): { handlers: DashboardHandlers } {
  const paired = new Date(Date.now() - 3 * 86_400_000).toISOString();
  let status: RemoteStatus = {
    available: true,
    enabled: false,
    listening: false,
    port: null,
    addresses: [],
    error: null,
    machineName: "Kaleb's Workstation",
    pairing: null,
    devices: [
      {
        id: "dev_0a1b2c3d4e5f60718293a4b5",
        name: "Kaleb's iPhone",
        platform: "ios",
        model: "iPhone17,1",
        app: "1.0 (1)",
        pairedAt: paired,
        lastSeenAt: new Date(Date.now() - 2 * 60_000).toISOString(),
        online: true,
      },
    ],
  };
  const snapshot = () => structuredClone(status);
  return {
    handlers: {
      remote_status: snapshot,
      remote_set_enabled: (args) => {
        const enabled = args.enabled === true;
        status = {
          ...status,
          enabled,
          listening: enabled,
          port: enabled ? 47820 : null,
          addresses: enabled ? ["192.168.1.20:47820", "100.101.102.103:47820"] : [],
          pairing: enabled ? status.pairing : null,
        };
        return snapshot();
      },
      remote_pair_start: () => {
        if (!status.listening) {
          throw {
            category: "validation",
            code: "remote_off",
            message: "Turn on Remote first, then pair your device.",
            retryable: false,
          };
        }
        status = {
          ...status,
          pairing: {
            link: "kalcode-remote://pair?d=eyJ2IjoxfQ",
            qrSvg: FAKE_QR,
            expiresAt: Math.floor(Date.now() / 1000) + 300,
          },
        };
        return snapshot();
      },
      remote_pair_cancel: () => {
        status = { ...status, pairing: null };
        return snapshot();
      },
      remote_device_revoke: (args) => {
        status = { ...status, devices: status.devices.filter((d) => d.id !== args.deviceId) };
        return snapshot();
      },
    },
  };
}
