import type { AppInfo, Settings, SettingsPatch } from "@kalcode/protocol";
import { useToast } from "@kalcode/ui/components";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { KalCodeClient } from "../ipc/client.ts";
import { type KalCodeError, toKalCodeError } from "../ipc/errors.ts";
import { EventFeed } from "./eventFeed.ts";

const INITIAL_PAGE = 100;
const OLDER_PAGE = 100;

type LoadState = "loading" | "ready" | "error";

interface RuntimeValue {
  client: KalCodeClient;
  info: AppInfo;
  settings: Settings;
  updateSettings: (patch: SettingsPatch) => Promise<void>;
  feed: EventFeed;
  eventsState: LoadState;
  eventsError: KalCodeError | null;
  retryEvents: () => void;
  loadOlderEvents: () => Promise<void>;
}

const RuntimeContext = createContext<RuntimeValue | null>(null);

interface RuntimeProviderProps {
  client: KalCodeClient;
  info: AppInfo;
  initialSettings: Settings;
  children: ReactNode;
}

export function RuntimeProvider({ client, info, initialSettings, children }: RuntimeProviderProps) {
  const toast = useToast();
  const [settings, setSettings] = useState(initialSettings);
  const requestSeq = useRef(0);
  const inFlight = useRef(0);
  const needsReconcile = useRef(false);

  /**
   * Optimistic update. A lone request applies its own response. When requests overlap (their
   * responses may arrive in any order) or one fails, the UI re-reads the saved settings once
   * nothing is in flight, so it always converges on what is actually persisted.
   */
  const updateSettings = useCallback(
    async (patch: SettingsPatch) => {
      const id = ++requestSeq.current;
      inFlight.current += 1;
      if (inFlight.current > 1) needsReconcile.current = true;
      setSettings((current) => ({ ...current, ...patch }));
      try {
        const next = await client.updateSettings(patch);
        if (id === requestSeq.current && !needsReconcile.current) setSettings(next);
      } catch (error) {
        needsReconcile.current = true;
        toast.show({ tone: "danger", title: "Settings not saved", description: toKalCodeError(error).message });
      } finally {
        inFlight.current -= 1;
        if (inFlight.current === 0 && needsReconcile.current) {
          needsReconcile.current = false;
          try {
            const saved = await client.getSettings();
            if (inFlight.current === 0) setSettings(saved);
          } catch {
            needsReconcile.current = true; // try again after the next update
          }
        }
      }
    },
    [client, toast],
  );

  const [feed] = useState(() => new EventFeed());
  const [eventsState, setEventsState] = useState<LoadState>("loading");
  const [eventsError, setEventsError] = useState<KalCodeError | null>(null);
  const [attempt, setAttempt] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` re-runs the subscription on retry.
  useEffect(() => {
    let cancelled = false;
    let unsubscribe: (() => Promise<void>) | null = null;
    setEventsState("loading");
    (async () => {
      try {
        // Subscribe before backfilling so no event can fall between the two calls.
        const unsub = await client.subscribeEvents((event) => feed.merge([event]));
        if (cancelled) {
          // Cleaned up while subscribing (StrictMode, retry, unmount): release it now.
          void unsub();
          return;
        }
        unsubscribe = unsub;
        const page = await client.recentEvents(INITIAL_PAGE);
        if (cancelled) return;
        feed.merge(page);
        if (page.length < INITIAL_PAGE) feed.markReachedStart();
        setEventsState("ready");
        setEventsError(null);
      } catch (error) {
        if (cancelled) return;
        setEventsError(toKalCodeError(error));
        setEventsState("error");
      }
    })();
    return () => {
      cancelled = true;
      void unsubscribe?.();
    };
  }, [client, feed, attempt]);

  const loadOlderEvents = useCallback(async () => {
    const cursor = feed.oldestSeq;
    if (cursor === undefined || feed.reachedStart) return;
    try {
      const page = await client.recentEvents(OLDER_PAGE, cursor);
      feed.mergeOlder(page);
      if (page.length < OLDER_PAGE) feed.markReachedStart();
    } catch (error) {
      toast.show({ tone: "danger", title: "Couldn't load older activity", description: toKalCodeError(error).message });
    }
  }, [client, feed, toast]);

  const retryEvents = useCallback(() => setAttempt((n) => n + 1), []);

  const value = useMemo<RuntimeValue>(
    () => ({ client, info, settings, updateSettings, feed, eventsState, eventsError, retryEvents, loadOlderEvents }),
    [client, info, settings, updateSettings, feed, eventsState, eventsError, retryEvents, loadOlderEvents],
  );

  return <RuntimeContext.Provider value={value}>{children}</RuntimeContext.Provider>;
}

export function useRuntime(): RuntimeValue {
  const value = useContext(RuntimeContext);
  if (!value) throw new Error("useRuntime must be used inside <RuntimeProvider>");
  return value;
}

export function useEvents() {
  const { feed, eventsState, eventsError, retryEvents, loadOlderEvents } = useRuntime();
  const { events, reachedStart } = useSyncExternalStore(feed.subscribe, feed.getSnapshot);
  return {
    events,
    reachedStart,
    state: eventsState,
    error: eventsError,
    retry: retryEvents,
    loadOlder: loadOlderEvents,
  };
}
