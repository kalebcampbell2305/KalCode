import { type ToastTone, useToast } from "@kalcode/ui/components";
import { type ReactNode, useCallback, useMemo, useRef, useState } from "react";
import { toKalCodeError } from "../../../ipc/errors.ts";
import { OperationsClient } from "../../../ipc/operations.ts";
import { type ProcessList, UtilityClient } from "../../../ipc/utilities.ts";
import { useRuntime } from "../../../runtime/RuntimeProvider.tsx";
import { useWorkspaces } from "../../../runtime/WorkspaceProvider.tsx";
import { tabLabels } from "../../../runtime/workspaceState.ts";
import { useNavigation } from "../../../shell/navigation.tsx";
import { forgetTerminalActivity, terminalActivity } from "./activity.ts";
import { classifyTerminals, type TidyEntry, type TidyScan, type TidyTerminal } from "./classify.ts";
import { KalTidyDialog } from "./KalTidyDialog.tsx";
import { type KalTidyApi, KalTidyContext, type KalTidyOutcome } from "./kalTidyContext.ts";

/** CPU becomes measurable on the sampler's second reading; wait this long before taking it. */
const CPU_RESAMPLE_MS = 350;

function terminalsWord(n: number): string {
  return n === 1 ? "1 terminal" : `${n} terminals`;
}

/** The one-sentence result of a tidy (toast title, KalVoice reply). */
export function tidySummary(result: { stopped: number; kept: number; failed: number; blocked: boolean }): string {
  if (result.blocked) return "Nothing was stopped: KalCode couldn't check your terminals.";
  const parts: string[] = [];
  if (result.stopped > 0) {
    parts.push(`Stopped ${result.stopped === 1 ? "1 idle terminal" : `${result.stopped} idle terminals`}.`);
  } else if (result.kept > 0 || result.failed > 0) parts.push("No idle terminals to stop.");
  else return "No terminals to tidy.";
  if (result.kept > 0) parts.push(`Kept ${terminalsWord(result.kept)} in use.`);
  if (result.failed > 0) parts.push(`${terminalsWord(result.failed)} couldn't be stopped.`);
  return parts.join(" ");
}

/**
 * KalTidy (owner request, 0.1.8 builds): one-click cleanup of idle terminals for the Code quick
 * action, the Command Palette and KalVoice. Scans every workspace's terminals, the processes
 * running in them and Operations, classifies conservatively (`classify.ts`) and stops only
 * terminals that are idle — or, from the review dialog, ones the person chose explicitly.
 * Terminals close through native `terminal_close` (what a tab's close does: the shell and
 * everything it started end); the workspace state then re-reads so tabs and panes follow.
 */
export function KalTidyProvider({ children }: { children: ReactNode }) {
  const { client } = useRuntime();
  const workspaces = useWorkspaces();
  const { current } = useNavigation();
  const toast = useToast();
  const utilities = useMemo(
    () => new UtilityClient((command, args) => client.transport.invoke(command, args)),
    [client],
  );
  const operations = useMemo(
    () => new OperationsClient((command, args) => client.transport.invoke(command, args)),
    [client],
  );
  const [reviewOpen, setReviewOpen] = useState(false);
  const [scan, setScan] = useState<TidyScan | null>(null);
  const [scanning, setScanning] = useState(false);
  const [stopping, setStopping] = useState(false);
  const busy = useRef(false);

  // Read at scan time, so a scan always sees the terminal the person is in right now.
  const focused = useRef<string | null>(null);
  focused.current = current === "code" ? workspaces.activeTerminalId : null;
  const refreshWorkspaces = useRef(workspaces.refresh);
  refreshWorkspaces.current = workspaces.refresh;

  const takeScan = useCallback(async (): Promise<TidyScan> => {
    let terminals: TidyTerminal[];
    try {
      const listed = await client.listWorkspaces();
      const perWorkspace = await Promise.all(listed.map((w) => client.listTerminals(w.id)));
      terminals = perWorkspace.flatMap((list, index) => {
        const labels = tabLabels(list);
        const workspaceName = listed[index]?.name ?? "Workspace";
        return list.map((t) => ({ ...t, label: labels.get(t.id) ?? t.title, workspaceName }));
      });
    } catch (error) {
      return {
        entries: [],
        blocked: `KalCode couldn't list your terminals: ${toKalCodeError(error).message}`,
        at: Date.now(),
      };
    }
    const running = terminals.some((t) => t.status === "running");
    const sample = async (): Promise<ProcessList> => {
      const first = await utilities.processes("related");
      if (first.cpuReady || !running) return first;
      await new Promise((resolve) => setTimeout(resolve, CPU_RESAMPLE_MS));
      return utilities.processes("related");
    };
    const [processes, snapshot] = await Promise.allSettled([sample(), operations.snapshot()]);
    return classifyTerminals({
      terminals,
      processes: processes.status === "fulfilled" ? processes.value.processes : null,
      processError: processes.status === "rejected" ? errorText(processes.reason) : null,
      operations: snapshot.status === "fulfilled" ? snapshot.value : null,
      operationsError: snapshot.status === "rejected" ? errorText(snapshot.reason) : null,
      activity: terminalActivity,
      focusedTerminalId: focused.current,
      now: Date.now(),
    });
  }, [client, utilities, operations]);

  /**
   * Stops each terminal unless someone typed into it after `since` (or, for an idle one, left
   * text at its prompt in the meantime).
   */
  const stopAll = useCallback(
    async (targets: readonly TidyEntry[], since: number) => {
      let stopped = 0;
      let failed = 0;
      let changed = 0;
      for (const { terminal, cls } of targets) {
        const latest = terminalActivity(terminal.id);
        if ((latest.lastInputAt ?? 0) > since || (cls === "idle" && latest.unsent)) {
          changed += 1;
          continue;
        }
        try {
          await client.closeTerminal(terminal.id);
          forgetTerminalActivity(terminal.id);
          stopped += 1;
        } catch {
          failed += 1;
        }
      }
      if (stopped + failed > 0) await refreshWorkspaces.current();
      return { stopped, failed, changed };
    },
    [client],
  );

  const report = useCallback(
    (outcome: KalTidyOutcome, blocked: string | null, offerReview: boolean, openReview: () => void) => {
      const tone: ToastTone = blocked || outcome.failed > 0 ? "danger" : outcome.stopped > 0 ? "success" : "info";
      toast.show({
        tone,
        title: outcome.summary,
        ...(blocked ? { description: blocked } : {}),
        ...(offerReview ? { action: { label: "Review terminals", onSelect: openReview } } : {}),
      });
    },
    [toast],
  );

  const rescan = useCallback(async () => {
    setScanning(true);
    try {
      setScan(await takeScan());
    } catch (error) {
      // Never leave the review waiting: a scan that broke keeps every terminal.
      setScan({ entries: [], blocked: `KalTidy ran into a problem: ${errorText(error)}`, at: Date.now() });
    } finally {
      setScanning(false);
    }
  }, [takeScan]);

  const openReview = useCallback(() => {
    setReviewOpen(true);
    setScan(null);
    void rescan();
  }, [rescan]);

  const stopIdle = useCallback(async (): Promise<KalTidyOutcome> => {
    if (busy.current) {
      return { stopped: 0, kept: 0, failed: 0, summary: "KalTidy is already tidying your terminals." };
    }
    busy.current = true;
    try {
      const result = await takeScan();
      const idle = result.entries.filter((e) => e.cls === "idle");
      const { stopped, failed, changed } = await stopAll(idle, result.at);
      const kept = result.entries.length - idle.length + changed;
      const outcome = {
        stopped,
        kept,
        failed,
        summary: tidySummary({ stopped, kept, failed, blocked: result.blocked !== null }),
      };
      report(outcome, result.blocked, kept > 0 || failed > 0 || result.blocked !== null, openReview);
      return outcome;
    } catch (error) {
      const summary = "Nothing was stopped: KalTidy ran into a problem.";
      toast.show({ tone: "danger", title: summary, description: errorText(error) });
      return { stopped: 0, kept: 0, failed: 0, summary };
    } finally {
      busy.current = false;
    }
  }, [takeScan, stopAll, report, openReview, toast]);

  /**
   * Stops what the person chose in the review, after a fresh scan: an idle terminal still idle,
   * or one they opted into that is still in the same state. Anything that became protected, or
   * changed since they looked, stays.
   */
  const confirmReview = useCallback(
    async (selected: readonly string[]) => {
      if (busy.current || !scan) return;
      busy.current = true;
      setStopping(true);
      try {
        const reviewed = new Map(scan.entries.map((e) => [e.terminal.id, e]));
        const fresh = await takeScan();
        const targets = fresh.entries.filter((entry) => {
          if (!selected.includes(entry.terminal.id) || entry.cls === "protected") return false;
          return entry.cls === "idle" || reviewed.get(entry.terminal.id)?.cls === entry.cls;
        });
        const { stopped, failed, changed } = await stopAll(targets, scan.at);
        const skipped = selected.length - targets.length + changed;
        const parts = [stopped > 0 ? `Stopped ${terminalsWord(stopped)}.` : "No terminals were stopped."];
        if (skipped > 0) {
          parts.push(
            `${terminalsWord(skipped)} changed since you looked, so ${skipped === 1 ? "it was" : "they were"} kept.`,
          );
        }
        if (failed > 0) parts.push(`${terminalsWord(failed)} couldn't be stopped.`);
        const blocked = fresh.blocked !== null && targets.length === 0 && selected.length > 0 ? fresh.blocked : null;
        const summary = parts.join(" ");
        report({ stopped, kept: fresh.entries.length - stopped - failed, failed, summary }, blocked, false, openReview);
        setReviewOpen(false);
      } catch (error) {
        toast.show({
          tone: "danger",
          title: "Nothing was stopped: KalTidy ran into a problem.",
          description: errorText(error),
        });
      } finally {
        busy.current = false;
        setStopping(false);
      }
    },
    [scan, takeScan, stopAll, report, openReview, toast],
  );

  const api = useMemo<KalTidyApi>(() => ({ openReview, stopIdle }), [openReview, stopIdle]);

  return (
    <KalTidyContext.Provider value={api}>
      {children}
      <KalTidyDialog
        open={reviewOpen}
        onOpenChange={(open) => {
          if (!open && !stopping) setReviewOpen(false);
        }}
        scan={scan}
        scanning={scanning}
        stopping={stopping}
        onRescan={() => void rescan()}
        onConfirm={(ids) => void confirmReview(ids)}
      />
    </KalTidyContext.Provider>
  );
}

function errorText(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return toKalCodeError(error).message;
}
