import { type ToastTone, useToast } from "@kalcode/ui/components";
import { type ReactNode, useCallback, useMemo, useRef, useState } from "react";
import type { KalCodeClient } from "../../../ipc/client.ts";
import { toKalCodeError } from "../../../ipc/errors.ts";
import { OperationsClient } from "../../../ipc/operations.ts";
import { type ProcessList, UtilityClient } from "../../../ipc/utilities.ts";
import { useRuntime } from "../../../runtime/RuntimeProvider.tsx";
import { useWorkspaces } from "../../../runtime/WorkspaceProvider.tsx";
import { tabLabels } from "../../../runtime/workspaceState.ts";
import { useNavigation } from "../../../shell/navigation.tsx";
import { isCodingAgent } from "../../dashboard/data/agents.ts";
import { activityWatchedSince, forgetTerminalActivity, terminalActivity } from "./activity.ts";
import { type AgentCleanup, agentCleanup, clearAgents, clearSummary, removeAgent } from "./agents.ts";
import { classifyTerminals, stillSafeToStop, type TidyEntry, type TidyScan, type TidyTerminal } from "./classify.ts";
import { closeAllSummary, closeAllTerminals } from "./closeAll.ts";
import { announceClosedPane } from "./closedPanes.ts";
import { type CloseAllScope, KalTidyCloseAllDialog } from "./KalTidyCloseAllDialog.tsx";
import { KalTidyDialog, type ReviewAgents } from "./KalTidyDialog.tsx";
import { type KalTidyApi, type KalTidyClearOutcome, KalTidyContext, type KalTidyOutcome } from "./kalTidyContext.ts";
import { type ScreenState, screenFromReplay } from "./screen.ts";

/** CPU becomes measurable on the sampler's second reading; wait this long before taking it. */
const CPU_RESAMPLE_MS = 350;
/** How long KalTidy waits for a terminal's scrollback before treating its screen as unreadable. */
const SCREEN_TIMEOUT_MS = 2_000;

/**
 * Reads a running terminal's screen from its native scrollback: a brief extra attachment (the
 * same stream a terminal view uses) whose first message is the replay, detached right away.
 * Works for terminals no view shows and after a window reload. Null when unreadable.
 */
async function readScreen(client: KalCodeClient, terminalId: string): Promise<ScreenState | null> {
  let received: (bytes: Uint8Array) => void = () => undefined;
  const replay = new Promise<Uint8Array>((resolve) => {
    received = resolve;
  });
  let attachment: number | null = null;
  try {
    attachment = await client.attachTerminal(terminalId, (bytes) => received(bytes));
    if (attachment === null) return null;
    const bytes = await Promise.race([
      replay,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), SCREEN_TIMEOUT_MS)),
    ]);
    return bytes ? screenFromReplay(bytes) : null;
  } catch {
    return null;
  } finally {
    if (attachment !== null) client.detachTerminal(attachment).catch(() => undefined);
  }
}

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
 *
 * It also clears coding agents whose session is over (failed, or finished/stopped) through the
 * canonical `removeAgent`, and "Close all" force-closes every terminal and agent in the current
 * workspace after one confirmation.
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
  // The review's agents (every workspace's coding agents), read with each scan.
  const [agents, setAgents] = useState<ReviewAgents | null>(null);
  const [clearing, setClearing] = useState<AgentCleanup | null>(null);
  // Only the newest scan may land: a slower older one would show stale classes.
  const scanRequest = useRef(0);
  const [closeAllOpen, setCloseAllOpen] = useState(false);
  const [closeScope, setCloseScope] = useState<CloseAllScope | null>(null);
  const closeAllRequest = useRef(0);
  const closingAll = useRef(false);
  const live = useRef({ workspaces, reviewOpen });
  live.current = { workspaces, reviewOpen };

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
    const screens = new Map<string, ScreenState | null>();
    const readScreens = Promise.all(
      terminals
        .filter((t) => t.status === "running")
        .map(async (t) => screens.set(t.id, await readScreen(client, t.id))),
    );
    const [processes, snapshot] = await Promise.allSettled([sample(), operations.snapshot(), readScreens]);
    return classifyTerminals({
      terminals,
      processes: processes.status === "fulfilled" ? processes.value.processes : null,
      processError: processes.status === "rejected" ? errorText(processes.reason) : null,
      operations: snapshot.status === "fulfilled" ? snapshot.value : null,
      operationsError: snapshot.status === "rejected" ? errorText(snapshot.reason) : null,
      activity: terminalActivity,
      focusedTerminalId: focused.current,
      screens: (id) => screens.get(id) ?? null,
      watchedSince: activityWatchedSince(),
      now: Date.now(),
    });
  }, [client, utilities, operations]);

  /**
   * Stops each terminal unless someone typed into it after `since` (or, for an idle one, left
   * text at its prompt in the meantime), or a fresh process scan shows it changed: another
   * shell (restarted), or, for an idle one, something now running in it. No fresh scan, no stop.
   */
  const stopAll = useCallback(
    async (targets: readonly TidyEntry[], since: number) => {
      let stopped = 0;
      let failed = 0;
      let changed = 0;
      const fresh = targets.length > 0 ? await utilities.processes("related").catch(() => null) : null;
      for (const entry of targets) {
        const { terminal, cls } = entry;
        const latest = terminalActivity(terminal.id);
        if (
          !fresh ||
          !stillSafeToStop(entry, fresh.processes) ||
          (latest.lastInputAt ?? 0) > since ||
          (cls === "idle" && latest.unsent)
        ) {
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
    [client, utilities],
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

  const readAgents = useCallback(async (): Promise<ReviewAgents> => {
    try {
      return { list: (await client.listThreads()).filter(isCodingAgent), error: null };
    } catch (error) {
      return { list: [], error: `KalCode couldn't list your agents: ${errorText(error)}` };
    }
  }, [client]);

  const rescan = useCallback(async () => {
    const request = ++scanRequest.current;
    const current = () => request === scanRequest.current;
    setScanning(true);
    const agentsRead = readAgents().then((next) => {
      if (current()) setAgents(next);
    });
    try {
      const next = await takeScan();
      if (current()) setScan(next);
    } catch (error) {
      // Never leave the review waiting: a scan that broke keeps every terminal.
      if (current()) {
        setScan({ entries: [], blocked: `KalTidy ran into a problem: ${errorText(error)}`, at: Date.now() });
      }
    } finally {
      await agentsRead;
      if (current()) setScanning(false);
    }
  }, [takeScan, readAgents]);

  const openReview = useCallback(() => {
    setReviewOpen(true);
    setScan(null);
    setAgents(null);
    void rescan();
  }, [rescan]);

  /** Clears failed or finished agents everywhere; no confirmation (their sessions are over). */
  const clear = useCallback(
    async (which: AgentCleanup): Promise<KalTidyClearOutcome> => {
      setClearing(which);
      try {
        const result = await clearAgents(client, await client.listThreads(), which);
        const summary = clearSummary(result, which);
        const tone: ToastTone = result.failed > 0 ? "danger" : result.cleared > 0 ? "success" : "info";
        toast.show({ tone, title: summary });
        return { ...result, summary };
      } catch (error) {
        const summary = "Nothing was cleared: KalTidy couldn't read your agents.";
        toast.show({ tone: "danger", title: summary, description: errorText(error) });
        return { cleared: 0, failed: 0, summary };
      } finally {
        setClearing(null);
        // The open review shows what is left.
        if (live.current.reviewOpen) {
          const request = scanRequest.current;
          void readAgents().then((next) => {
            if (request === scanRequest.current) setAgents(next);
          });
        }
      }
    },
    [client, toast, readAgents],
  );
  const clearFailed = useCallback(() => clear("failed"), [clear]);
  const clearFinished = useCallback(() => clear("finished"), [clear]);

  /** One agent's X: the same canonical removal, only for an agent whose session is over. */
  const dismissAgent = useCallback(
    async (agentId: string): Promise<boolean> => {
      try {
        const thread = await client.getThread(agentId);
        if (agentCleanup(thread) === null) {
          toast.show({
            tone: "info",
            title: `${thread.name} is still in use, so it was kept.`,
            description: "Stop it first, or use Close all.",
          });
          return false;
        }
        await removeAgent(client, thread);
        return true;
      } catch (error) {
        toast.show({ tone: "danger", title: "Couldn't clear the agent.", description: errorText(error) });
        return false;
      }
    },
    [client, toast],
  );

  /** Opens the one confirmation at once; the agent count fills in when read. */
  const closeAll = useCallback(() => {
    const { active, terminals } = live.current.workspaces;
    if (!active) {
      toast.show({
        tone: "info",
        title: "Open a workspace first.",
        description: "Close all ends the current workspace's terminals and agents.",
      });
      return;
    }
    const request = ++closeAllRequest.current;
    setCloseScope({ workspaceName: active.name, terminals: terminals.length, agents: "loading" });
    setCloseAllOpen(true);
    client.listThreads({ workspaceId: active.id }).then(
      (threads) => {
        if (request !== closeAllRequest.current) return;
        // Only this workspace's agents, whatever else the list returns.
        const count = threads.filter((t) => t.workspaceId === active.id && isCodingAgent(t)).length;
        setCloseScope((scope) => (scope ? { ...scope, agents: count } : scope));
      },
      () => {
        if (request !== closeAllRequest.current) return;
        setCloseScope((scope) => (scope ? { ...scope, agents: "unknown" } : scope));
      },
    );
  }, [client, toast]);

  /**
   * After "Close all": every terminal and coding agent in the current workspace ends, whatever it
   * is doing, through the canonical close paths; each pane closes as its process actually ends.
   */
  const runCloseAll = useCallback(async () => {
    closeAllRequest.current += 1;
    setCloseAllOpen(false);
    setReviewOpen(false);
    const active = live.current.workspaces.active;
    if (!active) {
      toast.show({ tone: "info", title: "No workspace is open, so there is nothing to close." });
      return;
    }
    if (closingAll.current) return;
    closingAll.current = true;
    try {
      const [terminals, threads] = await Promise.allSettled([
        client.listTerminals(active.id),
        client.listThreads({ workspaceId: active.id }),
      ]);
      const result = await closeAllTerminals(
        {
          terminals: terminals.status === "fulfilled" ? terminals.value.filter((t) => t.workspaceId === active.id) : [],
          threads: threads.status === "fulfilled" ? threads.value.filter((t) => t.workspaceId === active.id) : [],
        },
        {
          closeTerminal: async (terminal) => {
            await client.closeTerminal(terminal.id);
            forgetTerminalActivity(terminal.id);
            announceClosedPane({ kind: "terminal", id: terminal.id });
          },
          removeAgent: (thread) => removeAgent(client, thread),
        },
      );
      await refreshWorkspaces.current();
      const unread = [terminals, threads].find((r) => r.status === "rejected");
      const tone: ToastTone =
        result.failed > 0 || unread ? "danger" : result.terminals + result.agents > 0 ? "success" : "info";
      toast.show({
        tone,
        title: closeAllSummary(result),
        ...(unread?.status === "rejected"
          ? { description: `KalCode couldn't list everything to close: ${errorText(unread.reason)}` }
          : {}),
      });
    } catch (error) {
      toast.show({ tone: "danger", title: "KalTidy couldn't close everything.", description: errorText(error) });
    } finally {
      closingAll.current = false;
    }
  }, [client, toast]);

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

  const api = useMemo<KalTidyApi>(
    () => ({ openReview, stopIdle, clearFailed, clearFinished, dismissAgent, closeAll }),
    [openReview, stopIdle, clearFailed, clearFinished, dismissAgent, closeAll],
  );

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
        agents={agents}
        clearing={clearing}
        activeWorkspaceId={workspaces.active?.id ?? null}
        onClear={(which) => void clear(which)}
        onCloseAll={closeAll}
      />
      <KalTidyCloseAllDialog
        open={closeAllOpen}
        onOpenChange={(open) => {
          if (open) return;
          closeAllRequest.current += 1;
          setCloseAllOpen(false);
        }}
        scope={closeScope}
        onConfirm={() => void runCloseAll()}
      />
    </KalTidyContext.Provider>
  );
}

function errorText(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return toKalCodeError(error).message;
}
