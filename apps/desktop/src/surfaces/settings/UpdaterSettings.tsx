import { Button, Panel, SegmentedControl, Skeleton, useToast } from "@kalcode/ui/components";
import { RefreshCw, RotateCcw, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toKalCodeError } from "../../ipc/errors.ts";
import { type LiveStatus, liveUpdateStatus, onLiveStatus } from "../../ipc/liveUpdate.ts";
import type { UpdateChannel, UpdateStatus } from "../../ipc/updater.ts";
import { formatVersion } from "../../platform/version.ts";
import { useRuntime } from "../../runtime/RuntimeProvider.tsx";
import { liveUpdateLine } from "./liveUpdateModel.ts";
import styles from "./UpdaterSettings.module.css";
import { channelOptions, installsWhenClosed, restartAndInstall, updatePresentation } from "./updaterModel.ts";

type Operation = "channel" | "check" | "cancel" | "install" | "restore";

/** `updater_status` reads local state only, so following an in-flight check costs no network. */
const STATUS_POLL_MS = 1_000;

export function UpdaterSettings() {
  const { client, info } = useRuntime();
  const toast = useToast();
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [loadingError, setLoadingError] = useState<string | null>(null);
  const [operation, setOperation] = useState<Operation | null>(null);
  const [confirmRecovery, setConfirmRecovery] = useState(false);
  const [live, setLive] = useState<LiveStatus | null>(null);

  // Live Update pushes its state; nothing here polls it.
  useEffect(() => {
    let active = true;
    let unlisten: (() => void) | null = null;
    void liveUpdateStatus()
      .then((next) => active && setLive(next))
      .catch(() => undefined);
    void onLiveStatus((next) => setLive(next)).then((stop) => {
      if (active) unlisten = stop;
      else stop();
    });
    return () => {
      active = false;
      unlisten?.();
    };
  }, []);

  const load = useCallback(async () => {
    try {
      setStatus(await client.updaterStatus());
      setLoadingError(null);
    } catch (error) {
      setLoadingError(toKalCodeError(error).message);
    }
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  // Native checks on its own (at launch and periodically), so a phase read here goes stale. While
  // anything is in flight, follow it: a frozen "checking" keeps Check disabled and leaves a Cancel
  // that would discard the build native has since staged.
  const inFlight =
    operation === "check" ||
    status?.phase === "checking" ||
    status?.phase === "downloading" ||
    status?.phase === "installing";
  useEffect(() => {
    if (!inFlight) return;
    const timer = window.setInterval(() => void load(), STATUS_POLL_MS);
    return () => window.clearInterval(timer);
  }, [inFlight, load]);

  const run = useCallback(
    async (name: Operation, action: () => Promise<UpdateStatus | undefined>) => {
      setOperation(name);
      try {
        const next = await action();
        if (next) setStatus(next);
        else await load();
      } catch (error) {
        const failure = toKalCodeError(error);
        toast.show({ tone: "danger", title: "Update action didn't complete", description: failure.message });
        await load();
      } finally {
        setOperation(null);
      }
    },
    [load, toast],
  );

  const changeChannel = (channel: UpdateChannel) => {
    setConfirmRecovery(false);
    void run("channel", () => client.updaterSetChannel(channel));
  };

  if (!status) {
    return (
      <Panel id="updates" title="Updates" icon={<RefreshCw />}>
        {loadingError ? (
          <div role="alert" className={styles.loadError}>
            <p>{loadingError}</p>
            <Button size="sm" onClick={() => void load()}>
              Try again
            </Button>
          </div>
        ) : (
          <div role="status" aria-label="Loading update settings" className={styles.loading}>
            <Skeleton width="70%" />
            <Skeleton width="45%" />
          </div>
        )}
      </Panel>
    );
  }

  const presentation = updatePresentation(status);
  const liveLine = liveUpdateLine(live);
  const busy = operation !== null || status.phase === "checking" || status.phase === "downloading";
  const canCancel = operation === "check" || status.phase === "checking" || status.phase === "downloading";

  return (
    <Panel
      id="updates"
      title="Updates"
      icon={<RefreshCw />}
      description={
        info.channel === "stable"
          ? "Stable is recommended. Beta may contain unfinished changes."
          : "Stable is recommended. Beta and Dev may contain unfinished changes."
      }
      padding="none"
    >
      <div className={styles.content}>
        <div className={styles.channelRow}>
          <div>
            <p id="update-channel-label" className={styles.label}>
              Update channel
            </p>
            <p className={styles.help}>Changing channel never installs anything by itself.</p>
          </div>
          <SegmentedControl<UpdateChannel>
            aria-labelledby="update-channel-label"
            value={status.channel}
            onValueChange={changeChannel}
            disabled={busy || status.phase === "installing"}
            options={channelOptions(info.channel, status.channel)}
          />
        </div>

        <div className={styles.status} aria-live="polite" aria-busy={busy || undefined}>
          <span className={styles.statusDot} data-phase={status.phase} aria-hidden="true" />
          <div className={styles.statusText}>
            <p className={styles.statusLabel}>{presentation.label}</p>
            <p className={styles.help}>{presentation.detail}</p>
          </div>
        </div>
        {presentation.progress !== null ? (
          <progress className={styles.progress} max={100} value={presentation.progress}>
            {presentation.progress}%
          </progress>
        ) : null}
        {liveLine ? (
          <div className={styles.status} aria-live="polite">
            <span
              className={styles.statusDot}
              data-phase={liveLine.tone === "success" ? "ready" : liveLine.tone === "warning" ? "failed" : "idle"}
              aria-hidden="true"
            />
            <div className={styles.statusText}>
              <p className={styles.statusLabel}>{liveLine.label}</p>
              <p className={styles.help}>{liveLine.detail}</p>
            </div>
          </div>
        ) : null}

        <div className={styles.actions}>
          <Button
            icon={<RefreshCw />}
            busy={operation === "check" || status.phase === "checking" || status.phase === "downloading"}
            disabled={busy || status.phase === "installing"}
            onClick={() => void run("check", () => client.updaterCheck())}
          >
            Check for updates
          </Button>
          {canCancel ? (
            <Button
              icon={<X />}
              busy={operation === "cancel"}
              disabled={operation === "cancel"}
              onClick={() => void run("cancel", () => client.updaterCancel())}
            >
              Cancel update check
            </Button>
          ) : null}
          {status.phase === "ready" && !installsWhenClosed(status) ? (
            <Button
              variant="primary"
              busy={operation === "install"}
              onClick={() => void run("install", () => restartAndInstall(client).then(() => undefined))}
            >
              Restart and install{status.availableVersion ? ` ${formatVersion(status.availableVersion)}` : ""}
            </Button>
          ) : null}
        </div>

        {status.recoveryAvailable ? (
          <div className={styles.recovery}>
            <div>
              <p className={styles.label}>Verified previous version</p>
              <p className={styles.help}>Use this only if the current version is preventing you from working.</p>
            </div>
            {confirmRecovery ? (
              <fieldset className={styles.recoveryActions}>
                <legend className="visually-hidden">Confirm restoring the previous version</legend>
                <Button
                  variant="danger"
                  busy={operation === "restore"}
                  onClick={() => void run("restore", () => client.updaterRestorePrevious().then(() => undefined))}
                >
                  Confirm restore and restart
                </Button>
                <Button onClick={() => setConfirmRecovery(false)}>Cancel</Button>
              </fieldset>
            ) : (
              <Button icon={<RotateCcw />} onClick={() => setConfirmRecovery(true)}>
                Restore previous version
              </Button>
            )}
          </div>
        ) : null}
      </div>
    </Panel>
  );
}
