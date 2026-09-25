import type { TerminalInfo, ThreadSummary } from "@kalcode/protocol";
import { useToast } from "@kalcode/ui/components";
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { toKalCodeError } from "../../../ipc/errors.ts";
import { useEvents, useRuntime } from "../../../runtime/RuntimeProvider.tsx";
import { ACTION_LABELS, type ThreadAction } from "./actions.ts";
import { type DashboardResource, RefreshTracker } from "./refresh.ts";
import { type Resource, useResource } from "./resource.ts";

/** Coalesces bursts of events (a busy thread emits many) into one read per source. */
const REFRESH_DEBOUNCE_MS = 120;

export interface Announcement {
  id: number;
  text: string;
}

interface DashboardDataValue {
  threads: Resource<ThreadSummary[]>;
  terminals: Resource<TerminalInfo[]>;
  /** Thread id → action in flight. */
  pendingActions: ReadonlyMap<string, ThreadAction>;
  runAction: (thread: ThreadSummary, action: Exclude<ThreadAction, "open">) => Promise<void>;
  /** Screen-reader announcements (new approvals are announced app-wide by ApprovalAnnouncer). */
  urgent: Announcement | null;
  polite: Announcement | null;
}

const DashboardDataContext = createContext<DashboardDataValue | null>(null);

function useInvalidation(): [Record<DashboardResource, number>, (stale: Iterable<DashboardResource>) => void] {
  const [versions, setVersions] = useState<Record<DashboardResource, number>>({
    threads: 0,
    approvals: 0,
    terminals: 0,
  });
  const pending = useRef(new Set<DashboardResource>());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const invalidate = useCallback((stale: Iterable<DashboardResource>) => {
    for (const resource of stale) pending.current.add(resource);
    if (pending.current.size === 0 || timer.current) return;
    timer.current = setTimeout(() => {
      timer.current = null;
      const batch = [...pending.current];
      pending.current.clear();
      setVersions((v) => {
        const next = { ...v };
        for (const resource of batch) next[resource] += 1;
        return next;
      });
    }, REFRESH_DEBOUNCE_MS);
  }, []);

  return [versions, invalidate];
}

/**
 * The Dashboard's data layer. Reads threads (Z3 `thread_list`) and running terminals (Z1
 * `terminals_running`) through KalCodeClient, and re-reads each whenever the event log records
 * something that can change it. Thread actions go through the contract commands; results are
 * applied immediately and then reconciled by the event-driven refresh. Pending approvals come
 * from the permission engine's shared state (`usePermissions`, Z4), like the Approvals panel.
 */
export function DashboardDataProvider({ children }: { children: ReactNode }) {
  const { client } = useRuntime();
  const { events, state: eventsState } = useEvents();
  const toast = useToast();
  const [versions, invalidate] = useInvalidation();

  const threads = useResource(
    useCallback(() => client.listThreads(), [client]),
    versions.threads,
  );
  const terminals = useResource(
    useCallback(() => client.runningTerminals(), [client]),
    versions.terminals,
  );

  // Event-driven refresh: each new event invalidates the sources it can change. The tracker starts
  // once the event history has loaded, at its newest event: history is covered by the first reads.
  const tracker = useRef<RefreshTracker | null>(null);
  useEffect(() => {
    if (eventsState !== "ready") return;
    if (!tracker.current) {
      tracker.current = new RefreshTracker(events[0]?.seq ?? 0);
      return;
    }
    const stale = tracker.current.observe(events);
    if (stale.size > 0) invalidate(stale);
  }, [events, eventsState, invalidate]);

  // Announcements.
  const [urgent, setUrgent] = useState<Announcement | null>(null);
  const [polite, setPolite] = useState<Announcement | null>(null);
  const announceSeq = useRef(0);
  const announce = useCallback((text: string, level: "urgent" | "polite") => {
    const next = { id: ++announceSeq.current, text };
    (level === "urgent" ? setUrgent : setPolite)(next);
  }, []);

  const [pendingActions, setPendingActions] = useState<ReadonlyMap<string, ThreadAction>>(new Map());
  const runAction = useCallback(
    async (thread: ThreadSummary, action: Exclude<ThreadAction, "open">) => {
      setPendingActions((m) => new Map(m).set(thread.id, action));
      try {
        const updated =
          action === "interrupt"
            ? await client.interruptThread(thread.id)
            : action === "stop"
              ? await client.stopThread(thread.id)
              : action === "archive"
                ? await client.archiveThread(thread.id)
                : await client.resumeThread(thread.id); // resume and retry
        threads.update((list) =>
          action === "archive"
            ? list.filter((t) => t.id !== updated.id)
            : list.map((t) => (t.id === updated.id ? updated : t)),
        );
        announce(
          action === "archive"
            ? `${thread.name} archived`
            : `${thread.name}: ${ACTION_LABELS[action].toLowerCase()} requested`,
          "polite",
        );
        invalidate(["threads"]);
      } catch (raw) {
        const error = toKalCodeError(raw);
        toast.show({
          tone: "danger",
          title: `Couldn't ${ACTION_LABELS[action].toLowerCase()} ${thread.name}`,
          description: error.message,
        });
        invalidate(["threads"]);
      } finally {
        setPendingActions((m) => {
          const next = new Map(m);
          next.delete(thread.id);
          return next;
        });
      }
    },
    [client, threads.update, announce, invalidate, toast],
  );

  const value = useMemo<DashboardDataValue>(
    () => ({ threads, terminals, pendingActions, runAction, urgent, polite }),
    [threads, terminals, pendingActions, runAction, urgent, polite],
  );

  return <DashboardDataContext.Provider value={value}>{children}</DashboardDataContext.Provider>;
}

function useDashboardData(): DashboardDataValue {
  const value = useContext(DashboardDataContext);
  if (!value) throw new Error("Dashboard data hooks must be used inside <DashboardDataProvider>");
  return value;
}

/** Threads from Z3 `thread_list`, refreshed on thread/tool/file/approval events. */
export function useThreadSummaries() {
  const { threads, pendingActions, runAction } = useDashboardData();
  return { ...threads, pendingActions, runAction };
}

/** Running terminals from Z1 `terminals_running`, refreshed on shell events. */
export function useRunningTerminals() {
  return useDashboardData().terminals;
}

export function useDashboardAnnouncements() {
  const { urgent, polite } = useDashboardData();
  return { urgent, polite };
}
