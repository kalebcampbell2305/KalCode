import { Button } from "@kalcode/ui/components";
import { History, Play, RotateCcw } from "lucide-react";
import { AlertDialog } from "radix-ui";
import { useCallback, useEffect, useRef, useState } from "react";
import { useDeskRestore } from "../../runtime/deskRestore.ts";
import { useRuntime } from "../../runtime/RuntimeProvider.tsx";
import { useWorkspaces } from "../../runtime/WorkspaceProvider.tsx";
import { useNavigation } from "../../shell/navigation.tsx";
import { allContents } from "../../shell/panes/model.ts";
import type { PaneController } from "../../shell/panes/usePaneController.ts";
import { recoveryCandidates, restoreQueue } from "./continuity.ts";
import styles from "./DeskRecovery.module.css";
import confirmStyles from "./kaltidy/KalTidy.module.css";
import type { ProviderPanes } from "./panes/useProviderPanes.ts";

export function ContinueDeskNotice() {
  const { active, state } = useWorkspaces();
  const { automatic, continueDesk } = useDeskRestore(active?.id);
  const { current, navigate } = useNavigation();
  const [dismissed, setDismissed] = useState(false);
  if (automatic || dismissed || state !== "ready" || !active || current === "code") return null;
  return (
    <section className={styles.notice} aria-label="Desk recovery">
      <History className={styles.icon} aria-hidden="true" />
      <div className={styles.copy}>
        <p className={styles.title}>{active.name} is where you left it</p>
        <p className={styles.detail}>Your saved panes, Browser and recoverable agents are ready to reopen.</p>
      </div>
      <div className={styles.actions}>
        <Button
          size="sm"
          variant="primary"
          icon={<Play />}
          onClick={() => {
            continueDesk();
            navigate("code");
          }}
        >
          Continue where I left off
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setDismissed(true)}>
          Dismiss
        </Button>
      </div>
    </section>
  );
}

/** Runs after the saved shell is visible. Nothing here replays shell commands or user prompts. */
export function DeskRecovery({
  controller,
  panes,
  active,
}: {
  controller: PaneController;
  panes: ProviderPanes;
  active: boolean;
}) {
  const { client } = useRuntime();
  const workspace = useWorkspaces().active;
  const { automatic, continueDesk, request } = useDeskRestore(workspace?.id);
  const { navigate } = useNavigation();
  const [busy, setBusy] = useState(false);
  const [failures, setFailures] = useState<string[]>([]);
  const [confirmingReset, setConfirmingReset] = useState(false);
  const latest = useRef({ controller, panes, active });
  latest.current = { controller, panes, active };
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const candidates = useCallback((allowPendingInput = false) => {
    const { controller: current, panes: providers } = latest.current;
    const open = new Set(
      allContents(current.layout).flatMap((content) => (content.kind === "agent" ? [content.agentId] : [])),
    );
    return recoveryCandidates(
      providers.panes.map((p) => p.thread),
      open,
      new Set(providers.panes.filter((p) => p.info?.running).map((p) => p.thread.id)),
      { allowPendingInput },
    );
  }, []);
  const queuedCandidates = useCallback(
    () => candidates(true).filter((thread) => thread.resumeHasPendingInput === true),
    [candidates],
  );
  const restoring = useRef(false);
  const admitted = useRef(new Set<string>());
  const manualAdmission = useRef(new Map<string, number>());
  const recover = useCallback(
    async (
      requestedIds: readonly string[],
      retryIds: readonly string[] = [],
      manualRevision?: number,
      allowPendingInput = false,
    ) => {
      if (restoring.current) return false;
      const eligibleThreads = allowPendingInput ? queuedCandidates() : candidates();
      const eligible = new Set(eligibleThreads.map((thread) => thread.id));
      const ids = [...new Set(requestedIds)].filter((id) => eligible.has(id));
      if (ids.length === 0) return false;
      restoring.current = true;
      for (const id of ids) admitted.current.add(id);
      if (manualRevision !== undefined) {
        for (const id of retryIds) manualAdmission.current.set(id, manualRevision);
      }
      setBusy(true);
      const queue = restoreQueue(client);
      queue.retry(retryIds.filter((id) => eligible.has(id)));
      try {
        const failed = await queue.restore(
          ids,
          (id) =>
            mounted.current &&
            latest.current.active &&
            (allowPendingInput ? queuedCandidates() : candidates()).some((thread) => thread.id === id),
          async (id) => {
            // Check native facts again after waiting in the bounded queue. An explicit stop wins.
            const thread = await client.getThread(id);
            if (!thread.restartRecoverable || !thread.resumable || thread.status !== "interrupted") return;
            if (allowPendingInput && thread.resumeHasPendingInput !== true) return;
            const stillEligible = (allowPendingInput ? queuedCandidates() : candidates()).some(
              (candidate) => candidate.id === id,
            );
            if (!mounted.current || !stillEligible) return;
            // Native rechecks this boolean and the durable queued-input marker in the same claim.
            const updated = await client.resumeThread(id, undefined, null, allowPendingInput);
            if (mounted.current) latest.current.panes.updated(updated);
            if (updated.status === "failed" || updated.status === "offline") throw new Error("Restore failed");
          },
        );
        if (mounted.current) {
          const attempted = new Set(ids);
          setFailures((previous) => [...previous.filter((id) => !attempted.has(id)), ...failed]);
        }
      } finally {
        restoring.current = false;
        if (mounted.current) {
          setBusy(false);
          void latest.current.panes.refresh();
        }
      }
      return true;
    },
    [client, candidates, queuedCandidates],
  );
  const candidateKey = candidates()
    .map((thread) => thread.id)
    .join("\u0000");
  useEffect(() => {
    if (!active || !controller.ready || controller.loadError || !panes.loaded || busy) return;
    const candidateIds = candidateKey ? candidateKey.split("\u0000") : [];
    const manualIds = candidateIds.filter((id) => request > (manualAdmission.current.get(id) ?? 0));
    const freshIds =
      automatic || request > 0 ? candidateIds.filter((id) => !admitted.current.has(id)) : ([] as string[]);
    const ids = [...new Set([...manualIds, ...freshIds])];
    if (ids.length === 0) return;
    // Let the entire saved shell paint before any heavy provider startup.
    const frame = requestAnimationFrame(() => {
      void recover(ids, manualIds, request > 0 ? request : undefined);
    });
    return () => cancelAnimationFrame(frame);
  }, [active, automatic, request, controller.ready, controller.loadError, panes.loaded, busy, candidateKey, recover]);

  const pending = candidates().length;
  const queued = queuedCandidates().length;
  const openIds = new Set(
    allContents(controller.layout).flatMap((content) => (content.kind === "agent" ? [content.agentId] : [])),
  );
  const unresolvedFailures = failures.filter(
    (id) =>
      openIds.has(id) &&
      panes.panes.some(
        (p) => p.thread.id === id && !p.info?.running && ["interrupted", "failed", "offline"].includes(p.thread.status),
      ),
  );
  const unavailable = panes.panes.filter(
    (p) => openIds.has(p.thread.id) && p.thread.restartRecoverable && !p.thread.resumable && !p.info?.running,
  ).length;
  if (active && controller.loadError)
    return (
      <>
        <section className={styles.notice} aria-label="Desk recovery" aria-busy={controller.resettingSavedLayout}>
          <History className={styles.icon} aria-hidden="true" />
          <div className={styles.copy}>
            <p className={styles.title}>Your saved desk couldn't load</p>
            <p className={styles.detail}>{controller.loadError} Your visible desk is still available.</p>
          </div>
          <div className={styles.actions}>
            <Button
              size="sm"
              variant="primary"
              icon={<RotateCcw />}
              disabled={controller.resettingSavedLayout}
              onClick={controller.retryLoad}
            >
              Retry restore
            </Button>
            <Button
              size="sm"
              variant="ghost"
              busy={controller.resettingSavedLayout}
              onClick={() => setConfirmingReset(true)}
            >
              {controller.resettingSavedLayout ? "Resetting saved layout" : "Reset saved layout"}
            </Button>
          </div>
        </section>
        <AlertDialog.Root
          open={confirmingReset}
          onOpenChange={(open) => !controller.resettingSavedLayout && setConfirmingReset(open)}
        >
          <AlertDialog.Portal>
            <AlertDialog.Overlay className={confirmStyles.overlay} />
            <AlertDialog.Content className={confirmStyles.confirm}>
              <div className={confirmStyles.head}>
                <span className={confirmStyles.mark} data-tone="danger" aria-hidden="true">
                  <RotateCcw />
                </span>
                <div className={confirmStyles.headText}>
                  <AlertDialog.Title className={confirmStyles.title}>Reset saved pane arrangement?</AlertDialog.Title>
                  <AlertDialog.Description className={confirmStyles.description}>
                    This replaces the saved pane arrangement and Browser locations with the desk currently shown.
                    Running terminals and agents stay open.
                  </AlertDialog.Description>
                </div>
              </div>
              <div className={confirmStyles.confirmActions}>
                <AlertDialog.Cancel asChild>
                  <Button variant="ghost" disabled={controller.resettingSavedLayout}>
                    Cancel
                  </Button>
                </AlertDialog.Cancel>
                <AlertDialog.Action asChild>
                  <Button
                    variant="danger"
                    busy={controller.resettingSavedLayout}
                    onClick={() => void controller.resetSavedLayout()}
                  >
                    Reset saved layout
                  </Button>
                </AlertDialog.Action>
              </div>
            </AlertDialog.Content>
          </AlertDialog.Portal>
        </AlertDialog.Root>
      </>
    );
  if (!active || !controller.ready || (!pending && !queued && !busy && !unresolvedFailures.length && !unavailable))
    return null;
  return (
    <section className={styles.notice} aria-label="Desk recovery" aria-busy={busy}>
      <History className={styles.icon} aria-hidden="true" />
      <div className={styles.copy}>
        <p className={styles.title}>
          {busy
            ? "Bringing your agents back"
            : queued
              ? queued === 1
                ? "Queued task waiting"
                : "Queued tasks waiting"
              : unresolvedFailures.length || unavailable
                ? "Your desk is back. Some agents need a fresh start."
                : "Continue where I left off"}
        </p>
        <p className={styles.detail}>
          {busy
            ? "Your workspace is ready to use while provider sessions reconnect."
            : queued
              ? queued === 1
                ? "1 agent has a queued prompt. Automatic restore leaves it unsent. Choose Resume queued task to continue."
                : `${queued} agents have queued prompts. Automatic restore leaves them unsent. Choose Resume queued tasks to continue.`
              : unavailable
                ? "Open an ended agent to start a fresh session with its saved project and task context."
                : unresolvedFailures.length
                  ? "Open the affected agent for its error and recovery options. Your other panes are ready."
                  : `${pending} saved ${pending === 1 ? "agent can" : "agents can"} resume. Ended commands stay in Run history.`}
        </p>
      </div>
      <div className={styles.actions}>
        {pending > 0 ? (
          <Button
            size="sm"
            variant={queued ? "secondary" : "primary"}
            icon={unresolvedFailures.length ? <RotateCcw /> : <Play />}
            busy={busy}
            onClick={() => {
              // The in-Code action carries the same durable app-lifetime intent as Home's
              // Continue button, so a provider that validates later joins this recovery pass.
              continueDesk();
              const ids = candidates().map((thread) => thread.id);
              void recover(ids, ids, request + 1);
            }}
          >
            {unresolvedFailures.length ? "Retry recovery" : "Continue where I left off"}
          </Button>
        ) : null}
        {queued > 0 ? (
          <Button
            size="sm"
            variant="primary"
            icon={<Play />}
            busy={busy}
            onClick={() => {
              const ids = queuedCandidates().map((thread) => thread.id);
              void recover(ids, ids, undefined, true);
            }}
          >
            {queued === 1 ? "Resume queued task" : "Resume queued tasks"}
          </Button>
        ) : null}
        <Button size="sm" variant="ghost" onClick={() => navigate("operations")}>
          Run history
        </Button>
      </div>
    </section>
  );
}
