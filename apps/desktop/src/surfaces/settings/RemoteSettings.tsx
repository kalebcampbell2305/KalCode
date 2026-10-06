import { Badge, Button, Panel, Skeleton, useToast } from "@kalcode/ui/components";
import { Copy, QrCode, ShieldCheck, Smartphone, Tablet, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useOptionalAccount } from "../../account/AccountProvider.tsx";
import { planTier } from "../../ipc/account.ts";
import { toKalCodeError } from "../../ipc/errors.ts";
import { REMOTE_CHANGED_EVENT, type RemoteDevice, type RemoteStatus } from "../../ipc/remote.ts";
import { formatRelative } from "../../runtime/describeEvent.ts";
import { useRuntime } from "../../runtime/RuntimeProvider.tsx";
import styles from "./RemoteSettings.module.css";
import { countdown, deviceDetail, isTablet, remoteSummary, remoteVisible } from "./remoteModel.ts";

const PAIRED_DATE = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });

/** Settings › Remote, shown only where the account can use KalCode Remote (OWNER for now). */
export function RemoteSettingsGate() {
  const { info } = useRuntime();
  const tier = planTier(useOptionalAccount()?.snapshot);
  return remoteVisible(info.flags.features, tier) ? <RemoteSettings /> : null;
}

type Busy = "toggle" | "pair" | "cancel" | `revoke:${string}` | null;

export function RemoteSettings() {
  const { client } = useRuntime();
  const toast = useToast();
  const [status, setStatus] = useState<RemoteStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<Busy>(null);

  const load = useCallback(async () => {
    try {
      setStatus(await client.remoteStatus());
      setLoadError(null);
    } catch (error) {
      setLoadError(toKalCodeError(error).message);
    }
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  // Native says when a device connects, pairs or leaves; the page follows without polling.
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let disposed = false;
    void import("@tauri-apps/api/event")
      .then(({ listen }) => listen(REMOTE_CHANGED_EVENT, () => void load()))
      .then((stop) => {
        if (disposed) stop();
        else unlisten = stop;
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [load]);

  const run = useCallback(
    async (name: Exclude<Busy, null>, title: string, action: () => Promise<RemoteStatus>) => {
      setBusy(name);
      try {
        setStatus(await action());
      } catch (error) {
        toast.show({ tone: "danger", title, description: toKalCodeError(error).message });
        await load();
      } finally {
        setBusy(null);
      }
    },
    [load, toast],
  );

  if (!status) {
    return (
      <Panel id="remote" title="Remote" icon={<Smartphone />}>
        {loadError ? (
          <div role="alert" className={styles.loadError}>
            <p>{loadError}</p>
            <Button size="sm" onClick={() => void load()}>
              Try again
            </Button>
          </div>
        ) : (
          <div role="status" aria-label="Loading Remote" className={styles.loading}>
            <Skeleton height="1.25rem" width="60%" />
            <Skeleton height="2.5rem" />
          </div>
        )}
      </Panel>
    );
  }

  const summary = remoteSummary(status);
  const ready = status.enabled && status.listening && status.addresses.length > 0;
  return (
    <Panel
      id="remote"
      title="Remote"
      icon={<Smartphone />}
      padding="none"
      description="Run this workstation from your phone: agents, approvals and runs, live."
    >
      <div className={styles.content}>
        <div className={styles.toggleRow}>
          <div>
            <div id="remote-enabled-label" className={styles.label}>
              KalCode Remote
            </div>
            <div className={styles.help}>Lets paired devices see and steer {status.machineName}.</div>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={status.enabled}
            aria-labelledby="remote-enabled-label"
            className={styles.switch}
            disabled={busy === "toggle"}
            onClick={() => void run("toggle", "Remote didn't change", () => client.remoteSetEnabled(!status.enabled))}
          >
            <span className={styles.switchThumb} />
          </button>
        </div>

        <div className={styles.status} data-tone={summary.tone} aria-live="polite">
          <span className={styles.statusDot} data-tone={summary.tone} aria-hidden />
          <div className={styles.statusText}>
            <div className={styles.statusLine}>{summary.text}</div>
            {summary.tone === "listening" ? (
              <ul className={styles.addresses} aria-label="Addresses">
                {status.addresses.map((address) => (
                  <li key={address} className={styles.address}>
                    {address}
                  </li>
                ))}
              </ul>
            ) : null}
            {summary.tone === "failed" ? (
              <div className={styles.help}>
                If your phone still can't connect, allow KalCode on private networks in your firewall.
              </div>
            ) : null}
          </div>
        </div>

        {ready ? (
          status.pairing ? (
            <PairingCard
              pairing={status.pairing}
              cancelling={busy === "cancel"}
              onCancel={() => void run("cancel", "Pairing didn't stop", () => client.remotePairCancel())}
              onExpired={() => void load()}
            />
          ) : (
            <div className={styles.pairRow}>
              <div>
                <div className={styles.label}>Pair a device</div>
                <div className={styles.help}>
                  Scan a one-time code with the KalCode Remote app on your phone or tablet.
                </div>
              </div>
              <Button
                variant="primary"
                icon={<QrCode />}
                busy={busy === "pair"}
                onClick={() => void run("pair", "Pairing didn't start", () => client.remotePairStart())}
              >
                Pair a device
              </Button>
            </div>
          )
        ) : null}

        <DeviceList
          devices={status.devices}
          busy={busy}
          onRevoke={(device) =>
            void run(`revoke:${device.id}`, "Device wasn't removed", () => client.remoteDeviceRevoke(device.id))
          }
        />

        <p className={styles.security}>
          <ShieldCheck aria-hidden />
          <span>
            End-to-end encrypted, device to desktop, and it stays on your network (or your Tailscale). Phones can
            approve once or deny, never change settings, run shells or see credentials.
          </span>
        </p>
      </div>
    </Panel>
  );
}

function PairingCard({
  pairing,
  cancelling,
  onCancel,
  onExpired,
}: {
  pairing: NonNullable<RemoteStatus["pairing"]>;
  cancelling: boolean;
  onCancel: () => void;
  onExpired: () => void;
}) {
  const toast = useToast();
  const [now, setNow] = useState(() => Date.now());
  const expired = now / 1000 >= pairing.expiresAt;
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    if (expired) onExpired();
  }, [expired, onExpired]);
  const copy = () => {
    void navigator.clipboard.writeText(pairing.link).then(
      () => toast.show({ tone: "success", title: "Pairing link copied", description: "It works once, for 5 minutes." }),
      () => toast.show({ tone: "danger", title: "Couldn't copy the link", description: "Scan the code instead." }),
    );
  };
  return (
    <section className={styles.pairing} aria-label="Pair a device">
      <div className={styles.qrTile}>
        <img
          className={styles.qr}
          src={`data:image/svg+xml;utf8,${encodeURIComponent(pairing.qrSvg)}`}
          alt="Pairing code. Scan it with the KalCode Remote app."
          width={176}
          height={176}
        />
      </div>
      <div className={styles.pairingText}>
        <div className={styles.pairingTitle}>Scan with KalCode Remote</div>
        <ol className={styles.steps}>
          <li>Open KalCode Remote on your phone or tablet.</li>
          <li>Tap Scan pairing code and point the camera here.</li>
        </ol>
        <div className={styles.expiry} aria-live="off">
          Code expires in <span className={styles.timer}>{countdown(pairing.expiresAt, now)}</span> · single use
        </div>
        <div className={styles.actions}>
          <Button size="sm" variant="secondary" icon={<Copy />} onClick={copy}>
            Copy pairing link
          </Button>
          <Button size="sm" variant="ghost" icon={<X />} busy={cancelling} onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </div>
    </section>
  );
}

function DeviceList({
  devices,
  busy,
  onRevoke,
}: {
  devices: readonly RemoteDevice[];
  busy: Busy;
  onRevoke: (device: RemoteDevice) => void;
}) {
  const [confirming, setConfirming] = useState<string | null>(null);
  return (
    <section className={styles.devices} aria-labelledby="remote-devices-label">
      <div id="remote-devices-label" className={styles.sectionLabel}>
        Paired devices
      </div>
      {devices.length === 0 ? (
        <p className={styles.empty}>No devices yet. Pair your phone to run KalCode from anywhere on your network.</p>
      ) : (
        <ul className={styles.deviceList}>
          {devices.map((device) => {
            const Glyph = isTablet(device) ? Tablet : Smartphone;
            const asking = confirming === device.id;
            return (
              <li key={device.id} className={styles.device} data-online={device.online || undefined}>
                <span className={styles.deviceIcon} aria-hidden>
                  <Glyph />
                </span>
                <div className={styles.deviceText}>
                  <div className={styles.deviceName}>
                    <span className={styles.deviceTitle}>{device.name}</span>
                    {device.online ? <Badge tone="success">Online now</Badge> : null}
                  </div>
                  <div className={styles.deviceMeta}>{deviceDetail(device)}</div>
                  <div className={styles.deviceMeta}>
                    Paired {PAIRED_DATE.format(new Date(device.pairedAt))}
                    {device.lastSeenAt && !device.online ? ` · last seen ${formatRelative(device.lastSeenAt)}` : ""}
                  </div>
                </div>
                {asking ? (
                  <fieldset className={styles.confirm}>
                    <legend className={styles.confirmText}>Remove {device.name}? It disconnects now.</legend>
                    <Button
                      size="sm"
                      variant="danger"
                      busy={busy === `revoke:${device.id}`}
                      onClick={() => onRevoke(device)}
                    >
                      Remove
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setConfirming(null)}>
                      Keep
                    </Button>
                  </fieldset>
                ) : (
                  <Button size="sm" variant="ghost" onClick={() => setConfirming(device.id)}>
                    Remove
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
