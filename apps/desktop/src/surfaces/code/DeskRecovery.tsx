import { Button } from "@kalcode/ui/components";
import { History, Play, RotateCcw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useDeskRestore } from "../../runtime/deskRestore.ts";
import { useRuntime } from "../../runtime/RuntimeProvider.tsx";
import { useWorkspaces } from "../../runtime/WorkspaceProvider.tsx";
import { useNavigation } from "../../shell/navigation.tsx";
import { allContents } from "../../shell/panes/model.ts";
import type { PaneController } from "../../shell/panes/usePaneController.ts";
import { recoveryCandidates, restoreQueue } from "./continuity.ts";
import styles from "./DeskRecovery.module.css";
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
  const { automatic, request } = useDeskRestore(workspace?.id);
  const { navigate } = useNavigation();
  const [busy, setBusy] = useState(false);
  const [failures, setFailures] = useState<string[]>([]);
  const latest = useRef({ controller, panes, active });
  latest.current = { controller, panes, active };
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const candidates = useCallback(() => {
    const { controller: current, panes: providers } = latest.current;
    const open = new Set(
      allContents(current.layout).flatMap((content) => (content.kind === "agent" ? [content.agentId] : [])),
    );
    return recoveryCandidates(
      providers.panes.map((p) => p.thread),
      open,
      new Set(providers.panes.filter((p) => p.info?.running).map((p) => p.thread.id)),
    );
  }, []);
  const restoring = useRef(false);
  const recover = useCallback(
    async (retry = false) => {
      if (restoring.current) return;
      restoring.current = true;
      setBusy(true);
      const queue = restoreQueue(client);
      const ids = candidates().map((thread) => thread.id);
      if (retry) queue.retry(ids);
      try {
        const failed = await queue.restore(
          ids,
          (id) => mounted.current && latest.current.active && candidates().some((thread) => thread.id === id),
          async (id) => {
            // Check native facts again after waiting in the bounded queue. An explicit stop wins.
            const thread = await client.getThread(id);
            if (!thread.restartRecoverable || !thread.resumable || thread.status !== "interrupted") return;
            if (!mounted.current || !candidates().some((candidate) => candidate.id === id)) return;
            const updated = await client.resumeThread(id);
            if (mounted.current) latest.current.panes.updated(updated);
            if (updated.status === "failed" || updated.status === "offline") throw new Error("Restore failed");
          },
        );
        if (mounted.current) setFailures(failed);
      } finally {
        restoring.current = false;
        if (mounted.current) {
          setBusy(false);
          void latest.current.panes.refresh();
        }
      }
    },
    [client, candidates],
  );
  const autoAttempted = useRef(false);
  const manualRequest = useRef(0);
  useEffect(() => {
    if (!active || !controller.ready || controller.loadError || !panes.loaded) return;
    const manual = request > manualRequest.current;
    if (!manual && (!automatic || autoAttempted.current)) return;
    autoAttempted.current = true;
    manualRequest.current = request;
    // Let the entire saved shell paint before any heavy provider startup.
    const frame = requestAnimationFrame(() => {
      void recover(manual);
    });
    return () => {
      cancelAnimationFrame(frame);
      autoAttempted.current = false;
    };
  }, [active, automatic, request, controller.ready, controller.loadError, panes.loaded, recover]);

  const pending = candidates().length;
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
      <section className={styles.notice} aria-label="Desk recovery">
        <History className={styles.icon} aria-hidden="true" />
        <div className={styles.copy}>
          <p className={styles.title}>Your saved desk couldn't load</p>
          <p className={styles.detail}>{controller.loadError} Your saved layout has been kept.</p>
        </div>
        <Button size="sm" variant="primary" icon={<RotateCcw />} onClick={controller.retryLoad}>
          Retry restore
        </Button>
      </section>
    );
  if (!active || !controller.ready || (!pending && !busy && !unresolvedFailures.length && !unavailable)) return null;
  return (
    <section className={styles.notice} aria-label="Desk recovery" aria-busy={busy}>
      <History className={styles.icon} aria-hidden="true" />
      <div className={styles.copy}>
        <p className={styles.title}>
          {busy
            ? "Bringing your agents back"
            : unresolvedFailures.length || unavailable
              ? "Your desk is back. Some agents need a fresh start."
              : "Continue where I left off"}
        </p>
        <p className={styles.detail}>
          {busy
            ? "Your workspace is ready to use while provider sessions reconnect."
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
            variant="primary"
            icon={unresolvedFailures.length ? <RotateCcw /> : <Play />}
            busy={busy}
            onClick={() => void recover(true)}
          >
            {unresolvedFailures.length ? "Retry recovery" : "Continue where I left off"}
          </Button>
        ) : null}
        <Button size="sm" variant="ghost" onClick={() => navigate("operations")}>
          Run history
        </Button>
      </div>
    </section>
  );
}
