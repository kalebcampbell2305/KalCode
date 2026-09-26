import type { Notification, NotificationMark, NotificationPage } from "@kalcode/protocol";
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
  const [state, setState] = useState<LoadState>("loading");
  const [error, setError] = useState<KalCodeError | null>(null);
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [cursor, setCursor] = useState<string | null>(null);
  const [latest, setLatest] = useState<Notification | null>(null);
  const [panelOpen, setPanelOpenState] = useState(false);
  const opener = useRef<HTMLElement | null>(null);
  const generation = useRef(0);
  const loaded = useRef(PAGE);
  const refreshing = useRef<number | null>(null);
  const loadingMore = useRef(false);
  const unavailable = useRef(false);

  const refresh = useCallback(async () => {
    if (unavailable.current) return;
    const id = ++generation.current;
    refreshing.current = id;
    try {
      // Each native page is capped at 200; retain the depth the person already opened.
      const rows: Notification[] = [];
      let before: string | null = null;
      let page: NotificationPage;
      do {
        page = await client.listNotifications({ limit: Math.min(200, loaded.current - rows.length), before });
        if (id !== generation.current) return;
        rows.push(...page.notifications);
        before = page.nextCursor;
      } while (before && rows.length < loaded.current);
      setNotifications(rows);
      loaded.current = Math.max(PAGE, rows.length);
      setUnreadCount(page.unreadCount);
      setCursor(page.nextCursor);
      setState("ready");
      setError(null);
    } catch (raw) {
      if (id !== generation.current) return;
      const failure = toKalCodeError(raw);
      if (isCommandUnavailable(failure)) {
        unavailable.current = true;
        setState("unavailable");
        return;
      }
      setError(failure);
      setState((current) => (current === "ready" ? current : "error"));
    } finally {
      if (refreshing.current === id) refreshing.current = null;
    }
  }, [client]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Re-read after each new `notification.created` or answered approval (coalesced).
  const newestSeq = useMemo(() => events.find((e) => REFRESH_TYPES.has(e.type))?.seq ?? 0, [events]);
  const seenSeq = useRef<number | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (seenSeq.current === null) {
      seenSeq.current = newestSeq;
      return;
    }
    if (newestSeq <= seenSeq.current) return;
    seenSeq.current = newestSeq;
    if (timer.current) return;
    timer.current = setTimeout(() => {
      timer.current = null;
      void refresh();
    }, REFRESH_DEBOUNCE_MS);
  }, [newestSeq, refresh]);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  // The newest live notification (for the announcer): the first unread one raised after load.
  const baseline = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (state !== "ready") return;
    const first = notifications[0] ?? null;
    if (baseline.current === undefined) {
      baseline.current = first ? `${first.id}@${first.updatedAt}` : null;
      return;
    }
    const key = first ? `${first.id}@${first.updatedAt}` : null;
    if (first && key !== baseline.current && first.readAt === null) setLatest(first);
    baseline.current = key;
  }, [notifications, state]);

  const loadMore = useCallback(async () => {
    if (!cursor || loadingMore.current || refreshing.current !== null) return;
    loadingMore.current = true;
    const id = generation.current;
    try {
      const page = await client.listNotifications({ limit: PAGE, before: cursor });
      if (id !== generation.current) return;
      loaded.current += page.notifications.length;
      setNotifications((current) => {
        const seen = new Set(current.map((n) => n.id));
        return [...current, ...page.notifications.filter((n) => !seen.has(n.id))];
      });
      setCursor(page.nextCursor);
      setUnreadCount(page.unreadCount);
    } catch (raw) {
      if (id !== generation.current) return;
      toast.show({
        tone: "danger",
        title: "Couldn't load older notifications",
        description: toKalCodeError(raw).message,
      });
    } finally {
      loadingMore.current = false;
    }
  }, [client, cursor, toast]);

  const mark = useCallback(
    async (ids: readonly string[] | null, value: NotificationMark) => {
      // Pending pages contain state from before this mutation; they must not restore it.
      refreshing.current = ++generation.current;
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
        toast.show({
          tone: "danger",
          title: "Couldn't update notifications",
          description: toKalCodeError(raw).message,
        });
      }
      await refresh();
    },
    [client, refresh, toast],
  );

  const setPanelOpen = useCallback((open: boolean) => {
    if (open && document.activeElement instanceof HTMLElement) opener.current = document.activeElement;
    setPanelOpenState(open);
  }, []);
  const returnFocus = useRef(true);
  const panelReturnFocus = useCallback(() => {
    const target = opener.current;
    opener.current = null;
    if (returnFocus.current && target?.isConnected) target.focus();
    returnFocus.current = true;
  }, []);

  const open = useCallback(
    async (notification: Notification) => {
      // Focus goes to the entity, not back to the bell.
      returnFocus.current = false;
      setPanelOpenState(false);
      if (notification.readAt === null) void mark([notification.id], "read");
      await intents.focus(targetOf(notification));
    },
    [intents, mark],
  );

  const value = useMemo<NotificationsValue>(
    () => ({
      state,
      error,
      notifications,
      unreadCount,
      hasMore: cursor !== null,
      loadMore,
      refresh,
      mark,
      open,
      panelOpen,
      setPanelOpen,
      panelReturnFocus,
      latest,
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
    ],
  );
  return <NotificationsContext.Provider value={value}>{children}</NotificationsContext.Provider>;
}

export function useNotifications(): NotificationsValue {
  const value = useContext(NotificationsContext);
  if (!value) throw new Error("useNotifications must be used inside <NotificationsProvider>");
  return value;
}
