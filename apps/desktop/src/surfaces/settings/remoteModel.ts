import type { AccountTier } from "../../ipc/account.ts";
import type { RemoteDevice, RemoteStatus } from "../../ipc/remote.ts";

/** The FeatureFlag fields this needs. */
interface Flag {
  id: string;
  state: string;
  visible: boolean;
}

/** KalCode Remote for iPhone and iPad on the App Store. */
export const REMOTE_APP_STORE_URL = "https://apps.apple.com/app/id6819834499";

/** The plans that include Remote: its MAX placement, plus OWNER. Mirrors native `remote::tier_allows`. */
const REMOTE_TIERS: ReadonlySet<AccountTier> = new Set(["max", "max2x", "owner"]);

/**
 * Settings › Remote appears only where the account can use it: the build ships it and the plan
 * includes it (MAX and up).
 */
export function remoteVisible(features: readonly Flag[] | undefined, tier: AccountTier): boolean {
  const built = features?.some((f) => f.id === "remote" && f.visible && f.state !== "gated") ?? false;
  return built && REMOTE_TIERS.has(tier);
}

export type RemoteTone = "off" | "listening" | "failed";

/** The one-line truth under the switch. */
export function remoteSummary(status: RemoteStatus): { tone: RemoteTone; text: string } {
  if (!status.enabled) return { tone: "off", text: "Off. No device can connect to this computer." };
  if (status.error) return { tone: "failed", text: status.error.message };
  if (!status.listening) return { tone: "failed", text: "Remote is on but not listening. Turn it off and on again." };
  const count = status.addresses.length;
  if (count === 0) {
    return {
      tone: "failed",
      text: `Listening on port ${status.port ?? ""}, but this computer has no network address a phone can reach.`,
    };
  }
  const online = status.devices.filter((d) => d.online).length;
  const where = `Listening on ${count} ${count === 1 ? "address" : "addresses"}`;
  return {
    tone: "listening",
    text: online > 0 ? `${where} · ${online} ${online === 1 ? "device" : "devices"} connected` : where,
  };
}

/** "4:07" until the pairing code expires; "0:00" once it has. */
export function countdown(expiresAt: number, nowMs: number): string {
  const left = Math.max(0, Math.ceil(expiresAt - nowMs / 1000));
  return `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`;
}

const APPLE_MODELS: readonly [string, string][] = [
  ["iPhone", "iPhone"],
  ["iPad", "iPad"],
];

/** "iPhone · iOS · KalCode 1.0 (1)": what kind of device, never its raw identifiers alone. */
export function deviceDetail(device: Pick<RemoteDevice, "platform" | "model" | "app">): string {
  const family = APPLE_MODELS.find(([prefix]) => device.model.startsWith(prefix))?.[1];
  const platform =
    device.platform === "ios" ? "iOS" : device.platform === "android" ? "Android" : device.platform || null;
  const app = device.app ? `KalCode ${device.app}` : null;
  return [family ?? (device.model || null), platform, app].filter(Boolean).join(" · ");
}

/** Tablets get the tablet glyph. */
export function isTablet(device: Pick<RemoteDevice, "model">): boolean {
  return /^ipad|tablet/i.test(device.model);
}
