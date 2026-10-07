import type { EventEnvelope, Notification, NotificationMark, NotificationPage } from "@kalcode/protocol";
import { useToast } from "@kalcode/ui/components";
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { isCommandUnavailable, type KalCodeError, toKalCodeError } from "../../ipc/errors.ts";
import { useEvents, useRuntime } from "../../runtime/RuntimeProvider.tsx";
import { useUiIntents } from "../../runtime/uiIntents.tsx";
import { targetOf } from "./model.ts";

type LoadState = "loading" | "ready" | "unavailable" | "error";

const PAGE = 50;
/**
 * Bursts of notifications (a crash recovery, a flood of approvals) cost one read. The native
 * worker settles notifications just after the event that caused them, hence the short wait.
 */
const REFRESH_DEBOUNCE_MS = 300;
/** Events after which the list is re-read: new notifications, and answered approvals (their
 *  permission notices are marked read natively, without an event of their own). */
const REFRESH_TYPES = new Set(["notification.created", "approval.approved", "approval.denied", "approval.expired"]);

/** Whether `event` can change the list. A thread leaving `waiting_for_permission` is when the
 *  native center settles its permission notice once every request is answered. */
function refreshesList(event: EventEnvelope): boolean {
  return (
    REFRESH_TYPES.has(event.type) ||
    (event.type === "thread.status_changed" && event.payload.from === "waiting_for_permission")
  );
}

export interface NotificationsValue {
  state: LoadState;
  error: KalCodeError | null;
  /** Newest first; dismissed ones are never listed. */
  notifications: Notification[];
  unreadCount: number;
  hasMore: boolean;
  loadMore: () => Promise<void>;
  refresh: () => Promise<void>;
  mark: (ids: readonly string[] | null, mark: NotificationMark) => Promise<void>;
  /** Marks it read, closes the center and focuses its entity (thread pane, provider, …). */
  open: (notification: Notification) => Promise<void>;
  panelOpen: boolean;
  setPanelOpen: (open: boolean) => void;
  panelReturnFocus: () => void;
  /** The latest notification raised live (for the announcer). */
  latest: Notification | null;
}

const NotificationsContext = createContext<NotificationsValue | null>(null);

/**
 * The notification center's state (Z7-W3): the native store's notifications (`notification_list`),
 * re-read when a `notification.created` event is recorded, with read / unread / dismiss through
 * `notification_mark`. Must sit inside `UiIntentsProvider` (opening a notification focuses it).
 */
export function NotificationsProvider({ children }: { children: ReactNode }) {
  const { client } = useRuntime();
  const { events } = useEvents();
  const intents = useUiIntents();
  const toast = useToast();
  const lifecycle = useMemo(
    () => ({
      client,
      mounted: false,
      epoch: 0,
      generation: 0,
      loaded: PAGE,
      refreshing: null as number | null,
      loadingMore: null as object | null,
      unavailable: false,
      seenSeq: null as number | null,
      timer: null as ReturnType<typeof setTimeout> | null,
      baseline: undefined as string | null | undefined,
    }),
    [client],
  );
  const currentLifecycle = useRef(lifecycle);
  currentLifecycle.current = lifecycle;
  const renderEpoch = lifecycle.epoch;
  const isCurrent = useCallback(
    (epoch = renderEpoch) => lifecycle.mounted && currentLifecycle.current === lifecycle && epoch === lifecycle.epoch,
    [lifecycle, renderEpoch],
  );
  const [stateOwner, setStateOwner] = useState({ lifecycle, epoch: renderEpoch });
  // Activity preserves state while retiring effects. Hide the retired epoch before
  // consumers reconnect, and keep callbacks from that epoch retired as well.
  const ownsState = stateOwner.lifecycle === lifecycle && isCurrent(stateOwner.epoch);
  const [state, setState] = useState<LoadState>("loading");
  const [error, setError] = useState<KalCodeError | null>(null);
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [cursor, setCursor] = useState<string | null>(null);
  const [latest, setLatest] = useState<Notification | null>(null);
  const [panelOpen, setPanelOpenState] = useState(false);
  const opener = useRef<HTMLElement | null>(null);
  const returnFocus = useRef(true);

  useEffect(() => {
    lifecycle.mounted = true;
    lifecycle.loaded = PAGE;
    lifecycle.refreshing = null;
    lifecycle.loadingMore = null;
    lifecycle.unavailable = false;
    lifecycle.seenSeq = null;
    lifecycle.baseline = undefined;
    setStateOwner({ lifecycle, epoch: lifecycle.epoch });
    setState("loading");
    setError(null);
    setNotifications([]);
    setUnreadCount(0);
    setCursor(null);
    setLatest(null);
    setPanelOpenState(false);
    opener.current = null;
    returnFocus.current = true;
    return () => {
      lifecycle.mounted = false;
      lifecycle.epoch += 1;
      lifecycle.generation += 1;
      if (lifecycle.timer !== null) clearTimeout(lifecycle.timer);
      lifecycle.timer = null;
    };
  }, [lifecycle]);

  const refresh = useCallback(async () => {
    if (!isCurrent() || lifecycle.unavailable) return;
    const epoch = lifecycle.epoch;
    const id = ++lifecycle.generation;
    lifecycle.refreshing = id;
    lifecycle.loadingMore = null;
    try {
      // Each native page is capped at 200; retain the depth the person already opened.
      const rows: Notification[] = [];
      let before: string | null = null;
      let page: NotificationPage;
      do {
        page = await client.listNotifications({ limit: Math.min(200, lifecycle.loaded - rows.length), before });
        if (!isCurrent(epoch) || id !== lifecycle.generation) return;
        rows.push(...page.notifications);
        before = page.nextCursor;
      } while (before && rows.length < lifecycle.loaded);
      setNotifications(rows);
      lifecycle.loaded = Math.max(PAGE, rows.length);
      setUnreadCount(page.unreadCount);
      setCursor(page.nextCursor);
      setState("ready");
      setError(null);
    } catch (raw) {
      if (!isCurrent(epoch) || id !== lifecycle.generation) return;
      const failure = toKalCodeError(raw);
      if (isCommandUnavailable(failure)) {
        lifecycle.unavailable = true;
        setState("unavailable");
        return;
      }
      setError(failure);
      setState((current) => (current === "ready" ? current : "error"));
    } finally {
      if (lifecycle.refreshing === id) lifecycle.refreshing = null;
    }
  }, [client, lifecycle, isCurrent]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Re-read after each new `notification.created` or answered approval (coalesced).
  const newestSeq = useMemo(() => events.find(refreshesList)?.seq ?? 0, [events]);
  useEffect(() => {
    if (lifecycle.seenSeq === null) {
      lifecycle.seenSeq = newestSeq;
      return;
    }
    if (newestSeq <= lifecycle.seenSeq) return;
    lifecycle.seenSeq = newestSeq;
    if (lifecycle.timer !== null) return;
    const epoch = lifecycle.epoch;
    lifecycle.timer = setTimeout(() => {
      if (!isCurrent(epoch)) return;
      lifecycle.timer = null;
      void refresh();
    }, REFRESH_DEBOUNCE_MS);
  }, [newestSeq, refresh, lifecycle, isCurrent]);

  // The newest live notification (for the announcer): the first unread one raised after load.
  useEffect(() => {
    if (!ownsState || state !== "ready") return;
    const first = notifications[0] ?? null;
    if (lifecycle.baseline === undefined) {
      lifecycle.baseline = first ? `${first.id}@${first.updatedAt}` : null;
      return;
    }
    const key = first ? `${first.id}@${first.updatedAt}` : null;
    if (first && key !== lifecycle.baseline && first.readAt === null) setLatest(first);
    lifecycle.baseline = key;
  }, [notifications, state, lifecycle, ownsState]);

  const loadMore = useCallback(async () => {
    if (!isCurrent() || !cursor || lifecycle.loadingMore !== null || lifecycle.refreshing !== null) return;
    const request = {};
    lifecycle.loadingMore = request;
    const epoch = lifecycle.epoch;
    const id = lifecycle.generation;
    try {
      const page = await client.listNotifications({ limit: PAGE, before: cursor });
      if (!isCurrent(epoch) || id !== lifecycle.generation) return;
      lifecycle.loaded += page.notifications.length;
      setNotifications((current) => {
        const seen = new Set(current.map((n) => n.id));
        return [...current, ...page.notifications.filter((n) => !seen.has(n.id))];
      });
      setCursor(page.nextCursor);
      setUnreadCount(page.unreadCount);
    } catch (raw) {
      if (!isCurrent(epoch) || id !== lifecycle.generation) return;
      toast.show({
        tone: "danger",
        title: "Couldn't load older notifications",
        description: toKalCodeError(raw).message,
      });
    } finally {
      if (lifecycle.loadingMore === request) lifecycle.loadingMore = null;
    }
  }, [client, cursor, toast, lifecycle, isCurrent]);

  const mark = useCallback(
    async (ids: readonly string[] | null, value: NotificationMark) => {
      if (!isCurrent()) return;
      const epoch = lifecycle.epoch;
      // Pending pages contain state from before this mutation; they must not restore it.
      lifecycle.refreshing = ++lifecycle.generation;
      const applies = (n: Notification) => ids === null || ids.includes(n.id);
      const now = new Date().toISOString();
      // Optimistic: the list reflects the change at once; the read after it reconciles.
      setNotifications((current) =>
        value === "dismissed"
          ? current.filter((n) => !applies(n))
          : current.map((n) => (applies(n) ? { ...n, readAt: value === "read" ? (n.readAt ?? now) : null } : n)),
      );
      try {
        await client.markNotifications(ids, value);
      } catch (raw) {
        if (!isCurrent(epoch)) return;
        toast.show({
          tone: "danger",
          title: "Couldn't update notifications",
          description: toKalCodeError(raw).message,
        });
      }
      if (isCurrent(epoch)) await refresh();
    },
    [client, refresh, toast, lifecycle, isCurrent],
  );

  const setPanelOpen = useCallback(
    (open: boolean) => {
      if (!isCurrent()) return;
      if (open && document.activeElement instanceof HTMLElement) opener.current = document.activeElement;
      setPanelOpenState(open);
    },
    [isCurrent],
  );
  const panelReturnFocus = useCallback(() => {
    if (!isCurrent()) return;
    const target = opener.current;
    opener.current = null;
    if (returnFocus.current && target?.isConnected) target.focus();
    returnFocus.current = true;
  }, [isCurrent]);

  const open = useCallback(
    async (notification: Notification) => {
      if (!isCurrent()) return;
      // Focus goes to the entity, not back to the bell.
      returnFocus.current = false;
      setPanelOpenState(false);
      if (notification.readAt === null) void mark([notification.id], "read");
      await intents.focus(targetOf(notification));
    },
    [intents, mark, isCurrent],
  );

  const value = useMemo<NotificationsValue>(
    () => ({
      state: ownsState ? state : "loading",
      error: ownsState ? error : null,
      notifications: ownsState ? notifications : [],
      unreadCount: ownsState ? unreadCount : 0,
      hasMore: ownsState && cursor !== null,
      loadMore,
      refresh,
      mark,
      open,
      panelOpen: ownsState && panelOpen,
      setPanelOpen,
      panelReturnFocus,
      latest: ownsState ? latest : null,
    }),
    [
      state,
      error,
      notifications,
      unreadCount,
      cursor,
      loadMore,
      refresh,
      mark,
      open,
      panelOpen,
      setPanelOpen,
      panelReturnFocus,
      latest,
      ownsState,
    ],
  );
  return <NotificationsContext.Provider value={value}>{children}</NotificationsContext.Provider>;
}

export function useNotifications(): NotificationsValue {
  const value = useContext(NotificationsContext);
  if (!value) throw new Error("useNotifications must be used inside <NotificationsProvider>");
  return value;
}

/** The notification center when one is mounted (canonical actions run outside it in tests). */
export function useOptionalNotifications(): NotificationsValue | null {
  return useContext(NotificationsContext);
}
