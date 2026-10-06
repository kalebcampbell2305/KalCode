import { useToast } from "@kalcode/ui/components";
import { useEffect, useRef, useState } from "react";
import { useAccount } from "../../account/AccountProvider.tsx";
import { beginLiveReload, onHandoff, onUiStaged, reportHandoffReady } from "../../ipc/liveUpdate.ts";
import { formatVersion } from "../../platform/version.ts";
import { type Destination, useNavigation } from "../navigation.tsx";
import { subscribeUpdated } from "./announce.ts";
import { liveReloadHeld } from "./hold.ts";
import styles from "./LiveUpdateHost.module.css";
import { captureSnapshot, HANDOFF_KEY, RELOAD_KEY, restoreDrafts, saveSnapshot, takeSnapshot } from "./snapshot.ts";

/** A staged UI applies after this long without typing or clicking (or while KalCode is hidden). */
export const QUIET_MS = 4_000;
const QUIET_POLL_MS = 1_000;

/** Whether a modal is open: its state is the person's current task, so the reload waits. */
function modalOpen(): boolean {
  return document.querySelector("[role='dialog'][data-state='open'], [role='alertdialog'][data-state='open']") !== null;
}

/**
 * KalCode Live Update inside the Shell:
 * - a newer UI staged by the shell applies at the next quiet moment by reloading only this page;
 *   terminals and coding agents keep running in the shell and re-attach with their scrollback;
 * - before that reload (or before a core handoff) the current place and unsent text are saved,
 *   and they are put back once the new UI renders;
 * - a finished update is announced with one small toast; nothing interrupts typing.
 */
export function LiveUpdateHost({
  onOpenDetails,
  reload = () => window.location.reload(),
}: {
  onOpenDetails: () => void;
  /** Reloads the page; injectable for tests. */
  reload?: () => void;
}) {
  const { current, navigate } = useNavigation();
  const toast = useToast();
  const currentRef = useRef<Destination>(current);
  currentRef.current = current;
  const [handoff, setHandoff] = useState<string | null>(null);
  const openDetails = useRef(onOpenDetails);
  openDetails.current = onOpenDetails;
  const reloadRef = useRef(reload);
  reloadRef.current = reload;
  // Drafts belong to the signed-in KalCode account; they are saved and restored only for it.
  const viewer = useAccount().snapshot.account?.id ?? null;
  const viewerRef = useRef(viewer);
  viewerRef.current = viewer;

  // Restore what the previous page saved, once.
  useEffect(() => {
    const current = viewerRef.current;
    const snapshot = current ? takeSnapshot(current) : null;
    if (!snapshot) return;
    if (snapshot.destination && snapshot.destination !== currentRef.current) {
      navigate(snapshot.destination as Destination);
    }
    return restoreDrafts(snapshot.drafts);
  }, [navigate]);

  useEffect(
    () =>
      subscribeUpdated((updated) => {
        toast.show({
          tone: "success",
          title: "KalCode updated",
          description:
            updated.class === "ui"
              ? `You're on ${formatVersion(updated.version)}. Your terminals and agents kept running.`
              : `You're on ${formatVersion(updated.version)}. Your workspace is right where you left it.`,
          action: { label: "Details", onSelect: () => openDetails.current() },
        });
      }),
    [toast],
  );

  // Apply a staged UI at the next quiet moment.
  useEffect(() => {
    let lastInput = Date.now();
    let timer: ReturnType<typeof setInterval> | null = null;
    const mark = () => {
      lastInput = Date.now();
    };
    const events = ["keydown", "pointerdown", "compositionstart", "compositionupdate"] as const;
    for (const name of events) window.addEventListener(name, mark, true);
    const apply = () => {
      if (timer !== null) clearInterval(timer);
      timer = null;
      if (viewerRef.current) saveSnapshot(RELOAD_KEY, captureSnapshot(viewerRef.current, currentRef.current));
      void beginLiveReload()
        .catch(() => undefined)
        .finally(() => reloadRef.current());
    };
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void onUiStaged(() => {
      if (timer !== null) return;
      timer = setInterval(() => {
        const quiet = document.hidden || Date.now() - lastInput >= QUIET_MS;
        // A send or create in flight finishes first, so its composer is cleared before saving.
        if (quiet && !modalOpen() && !liveReloadHeld()) apply();
      }, QUIET_POLL_MS);
    }).then((stop) => {
      if (disposed) stop();
      else unlisten = stop;
    });
    return () => {
      disposed = true;
      unlisten?.();
      if (timer !== null) clearInterval(timer);
      for (const name of events) window.removeEventListener(name, mark, true);
    };
  }, []);

  // A core handoff: save state, show progress, let the shell continue.
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void onHandoff((version) => {
      if (version) {
        if (viewerRef.current) saveSnapshot(HANDOFF_KEY, captureSnapshot(viewerRef.current, currentRef.current));
        setHandoff(version);
        void reportHandoffReady().catch(() => undefined);
      } else {
        setHandoff(null);
      }
    }).then((stop) => {
      if (disposed) stop();
      else unlisten = stop;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  if (!handoff) return null;
  return (
    <div className={styles.scrim} role="status" aria-live="polite">
      <div className={styles.card}>
        <span className={styles.spinner} aria-hidden="true" />
        <div>
          <p className={styles.title}>Applying KalCode update…</p>
          <p className={styles.detail}>{formatVersion(handoff)} · your workspace comes right back</p>
        </div>
      </div>
    </div>
  );
}
