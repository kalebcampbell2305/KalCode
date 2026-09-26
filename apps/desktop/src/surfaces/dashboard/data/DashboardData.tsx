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

function createSession() {
  return {
    active: true,
    tracker: null as RefreshTracker | null,
    pending: new Set<DashboardResource>(),
    timer: null as ReturnType<typeof setTimeout> | null,
    actions: new Map<string, symbol>(),
  };
}

type Session = ReturnType<typeof createSession>;
type Lifetime = { session: Session };

function useInvalidation(lifetime: Lifetime, isCurrent: (session: Session) => boolean) {
  const [versions, setVersions] = useState<Record<DashboardResource, number>>({
    threads: 0,
    approvals: 0,
    terminals: 0,
  });
  const invalidate = useCallback(
    (stale: Iterable<DashboardResource>, session = lifetime.session) => {
      if (!isCurrent(session)) return;
      for (const resource of stale) session.pending.add(resource);
      if (session.pending.size === 0 || session.timer) return;
      session.timer = setTimeout(() => {
        session.timer = null;
        if (!isCurrent(session)) return;
        const batch = [...session.pending];
        session.pending.clear();
        setVersions((v) => {
          if (!isCurrent(session)) return v;
          const next = { ...v };
          for (const resource of batch) next[resource] += 1;
          return next;
        });
      }, REFRESH_DEBOUNCE_MS);
    },
    [lifetime, isCurrent],
  );

  return [versions, invalidate] as const;
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
  // Client object equality alone cannot distinguish A -> B -> A or effect reconnection.
  // biome-ignore lint/correctness/useExhaustiveDependencies: client defines this resource lifetime.
  const lifetime = useMemo<Lifetime>(() => ({ session: createSession() }), [client]);
  const current = useRef(lifetime);
  current.current = lifetime;
  const [, reconnect] = useState(0);
  const isCurrent = useCallback(
    (session: Session) => current.current === lifetime && lifetime.session === session && session.active,
    [lifetime],
  );
  useEffect(() => {
    if (!lifetime.session.active) {
      lifetime.session = createSession();
      reconnect((version) => version + 1);
    }
    const session = lifetime.session;
    return () => {
      session.active = false;
      if (session.timer) clearTimeout(session.timer);
      session.timer = null;
      session.pending.clear();
      session.actions.clear();
    };
  }, [lifetime]);
  const [versions, invalidate] = useInvalidation(lifetime, isCurrent);

  // useResource resets its loader in an effect; hide the previous client's snapshot
  // during the first replacement commit without remounting Dashboard consumers.
  const [resourceOwner, setResourceOwner] = useState(lifetime);
  useEffect(() => setResourceOwner(lifetime), [lifetime]);

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
  useEffect(() => {
    if (eventsState !== "ready") return;
    const session = lifetime.session;
    if (!isCurrent(session)) return;
    if (!session.tracker) {
      session.tracker = new RefreshTracker(events[0]?.seq ?? 0);
      return;
    }
    const stale = session.tracker.observe(events);
    if (stale.size > 0) invalidate(stale, session);
  }, [events, eventsState, invalidate, lifetime, isCurrent]);

  const [actionState, setActionState] = useState(() => ({
    owner: lifetime,
    session: lifetime.session,
    pending: new Map<string, ThreadAction>(),
    polite: null as Announcement | null,
  }));
  const emptyActions = useMemo(() => new Map<string, ThreadAction>(), []);
  const ownsState = actionState.owner === lifetime && isCurrent(actionState.session);
  const pendingActions = ownsState ? actionState.pending : emptyActions;
  const polite = ownsState ? actionState.polite : null;
  const urgent = null;
  const announceSeq = useRef(0);
  const actionSession = lifetime.session;

  const runAction = useCallback(
    async (thread: ThreadSummary, action: Exclude<ThreadAction, "open">) => {
      const session = actionSession;
      if (!isCurrent(session)) return;
      // A newer explicit action (including Stop) can run immediately. Its completion
      // owns this row; an older request cannot clear or overwrite its visible state.
      const request = Symbol();
      session.actions.set(thread.id, request);
      const ownsAction = () => isCurrent(session) && session.actions.get(thread.id) === request;
      setActionState((state) =>
        ownsAction()
          ? {
              owner: lifetime,
              session,
              pending: new Map(state.owner === lifetime && state.session === session ? state.pending : []).set(
                thread.id,
                action,
              ),
              polite: state.owner === lifetime && state.session === session ? state.polite : null,
            }
          : state,
      );
      try {
        const updated =
          action === "interrupt"
            ? await client.interruptThread(thread.id)
            : action === "stop"
              ? await client.stopThread(thread.id)
              : action === "archive"
                ? await client.archiveThread(thread.id)
                : await client.resumeThread(thread.id); // resume and retry
        if (!isCurrent(session)) return;
        // Reconcile even a superseded current-client command: native effects already happened.
        invalidate(["threads"], session);
        if (!ownsAction()) return;
        threads.update((list) =>
          action === "archive"
            ? list.filter((t) => t.id !== updated.id)
            : list.map((t) => (t.id === updated.id ? updated : t)),
        );
        const announcement = {
          id: ++announceSeq.current,
          text:
            action === "archive"
              ? `${thread.name} archived`
              : `${thread.name}: ${ACTION_LABELS[action].toLowerCase()} requested`,
        };
        setActionState((state) => (ownsAction() ? { ...state, polite: announcement } : state));
      } catch (raw) {
        if (!isCurrent(session)) return;
        invalidate(["threads"], session);
        if (!ownsAction()) return;
        const error = toKalCodeError(raw);
        toast.show({
          tone: "danger",
          title: `Couldn't ${ACTION_LABELS[action].toLowerCase()} ${thread.name}`,
          description: error.message,
        });
      } finally {
        if (ownsAction()) {
          setActionState((state) => {
            if (!ownsAction() || state.owner !== lifetime) return state;
            const next = new Map(state.pending);
            next.delete(thread.id);
            return { ...state, pending: next };
          });
        }
      }
    },
    [client, threads.update, invalidate, toast, lifetime, isCurrent, actionSession],
  );

  const value = useMemo<DashboardDataValue>(
    () => ({
      threads: resourceOwner === lifetime ? threads : { ...threads, state: { status: "loading" } },
      terminals: resourceOwner === lifetime ? terminals : { ...terminals, state: { status: "loading" } },
      pendingActions,
      runAction,
      urgent,
      polite,
    }),
    [threads, terminals, pendingActions, runAction, polite, resourceOwner, lifetime],
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

/**
 * Provides Dashboard data to its children unless an ancestor already does: widgets and the
 * Dashboard pane (Z7-W1) render inside or outside the Dashboard surface.
 */
export function DashboardDataBoundary({ children }: { children: ReactNode }) {
  const existing = useContext(DashboardDataContext);
  return existing ? children : <DashboardDataProvider>{children}</DashboardDataProvider>;
}
