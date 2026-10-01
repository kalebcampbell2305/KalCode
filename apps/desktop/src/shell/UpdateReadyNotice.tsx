import { Button, useToast } from "@kalcode/ui/components";
import { RefreshCw } from "lucide-react";
import { AlertDialog } from "radix-ui";
import { useEffect, useState } from "react";
import type { KalCodeClient } from "../ipc/client.ts";
import { toKalCodeError } from "../ipc/errors.ts";
import { formatVersion, publicVersion, sameVersionBuild } from "../platform/version.ts";
import { installsWhenClosed, restartAndInstall } from "../surfaces/settings/updaterModel.ts";
import styles from "./UpdateReadyNotice.module.css";

export type UpdateReadyNoticeClient = Pick<KalCodeClient, "updaterStatus" | "updaterInstall">;

/** How often the shell re-reads updater status (native has no updater event to subscribe to). */
export const UPDATE_STATUS_POLL_MS = 60_000;

/** A verified update that is ready; `version` is null when native didn't name it. */
interface ReadyUpdate {
  version: string | null;
  /** The running version, to tell a new build of the same public version apart. */
  currentVersion?: string;
}

/**
 * Non-modal, app-wide notice for a downloaded and verified new public version. It never
 * restarts on its own: "Restart to update" asks for confirmation first, then uses the same
 * install path as Settings → Updates. "Later" hides it for this app session. A newer build of
 * the running public version staged to install silently when KalCode closes is not announced;
 * one whose silent install failed is offered here, so nobody stays on an old build.
 * Status read failures stay silent — Settings → Updates is where updater problems are reported.
 */
export function UpdateReadyNotice({
  client,
  onOpenDetails,
  pollMs = UPDATE_STATUS_POLL_MS,
}: {
  client: UpdateReadyNoticeClient;
  onOpenDetails: () => void;
  pollMs?: number;
}) {
  const toast = useToast();
  const [ready, setReady] = useState<ReadyUpdate | null>(null);
  const [dismissed, setDismissed] = useState<ReadyUpdate | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [installing, setInstalling] = useState(false);

  useEffect(() => {
    let active = true;
    const read = async () => {
      try {
        const status = await client.updaterStatus();
        if (active)
          setReady(
            status.phase === "ready" && !installsWhenClosed(status)
              ? { version: status.availableVersion, currentVersion: status.currentVersion }
              : null,
          );
      } catch {
        if (active) setReady(null);
      }
    };
    void read();
    const timer = setInterval(() => void read(), pollMs);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [client, pollMs]);

  // "Later" hides this version for the session; a newer ready version is announced again.
  const visible = ready !== null && !(dismissed !== null && dismissed.version === ready.version);
  const build = ready?.version ? sameVersionBuild(ready.currentVersion, ready.version) : null;
  const title = !ready?.version
    ? "A KalCode update is ready to install."
    : build === null
      ? `KalCode ${publicVersion(ready.version)} is ready to install.`
      : `A new KalCode ${publicVersion(ready.version)} build is ready (build ${build}).`;
  const target = ready?.version ? `KalCode ${formatVersion(ready.version)}` : "the new version";

  const install = async () => {
    setInstalling(true);
    try {
      await restartAndInstall(client);
      setConfirming(false);
    } catch (error) {
      setConfirming(false);
      toast.show({ tone: "danger", title: "Update didn't install", description: toKalCodeError(error).message });
    } finally {
      setInstalling(false);
    }
  };

  return (
    <>
      <div className={styles.region} role="status" aria-live="polite" aria-label={visible ? "Update ready" : undefined}>
        {visible ? (
          <div className={styles.notice}>
            <span className={styles.icon} aria-hidden="true">
              <RefreshCw />
            </span>
            <div className={styles.text}>
              <p className={styles.title}>{title}</p>
              <p className={styles.detail}>Your work stays open until you restart.</p>
              <div className={styles.actions}>
                <Button size="sm" variant="primary" onClick={() => setConfirming(true)}>
                  Restart to update
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setDismissed(ready)}>
                  Later
                </Button>
                <Button size="sm" variant="ghost" onClick={onOpenDetails}>
                  Details
                </Button>
              </div>
            </div>
          </div>
        ) : null}
      </div>
      <AlertDialog.Root open={confirming} onOpenChange={(open) => !installing && setConfirming(open)}>
        <AlertDialog.Portal>
          <AlertDialog.Overlay className={styles.overlay} />
          <AlertDialog.Content className={styles.dialog}>
            <AlertDialog.Title className={styles.dialogTitle}>Restart to update?</AlertDialog.Title>
            <AlertDialog.Description className={styles.dialogBody}>
              KalCode will close running threads, terminals and KalVoice, then restart into {target}.
            </AlertDialog.Description>
            <div className={styles.dialogActions}>
              <AlertDialog.Cancel asChild>
                <Button variant="ghost" disabled={installing}>
                  Cancel
                </Button>
              </AlertDialog.Cancel>
              <Button variant="primary" busy={installing} onClick={() => void install()}>
                Restart and install{ready?.version ? ` ${formatVersion(ready.version)}` : ""}
              </Button>
            </div>
          </AlertDialog.Content>
        </AlertDialog.Portal>
      </AlertDialog.Root>
    </>
  );
}
