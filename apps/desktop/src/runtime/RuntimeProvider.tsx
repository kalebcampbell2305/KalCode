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
  const requests = useMemo(() => ({ client, seq: 0, inFlight: 0, needsReconcile: false }), [client]);
  const currentRequests = useRef(requests);
  currentRequests.current = requests;

  /**
   * Optimistic update. A lone request applies its own response. When requests overlap (their
   * responses may arrive in any order) or one fails, the UI re-reads the saved settings once
   * nothing is in flight, so it always converges on what is actually persisted.
   */
  const updateSettings = useCallback(
    async (patch: SettingsPatch) => {
      if (requests !== currentRequests.current) return;
      const id = ++requests.seq;
      requests.inFlight += 1;
      if (requests.inFlight > 1) requests.needsReconcile = true;
      setSettings((current) => ({ ...current, ...patch }));
      try {
        const next = await requests.client.updateSettings(patch);
        if (requests === currentRequests.current && id === requests.seq && !requests.needsReconcile) setSettings(next);
      } catch (error) {
        requests.needsReconcile = true;
        if (requests === currentRequests.current) {
          toast.show({ tone: "danger", title: "Settings not saved", description: toKalCodeError(error).message });
        }
      } finally {
        requests.inFlight -= 1;
        if (requests === currentRequests.current && requests.inFlight === 0 && requests.needsReconcile) {
          requests.needsReconcile = false;
          const reconcileSeq = requests.seq;
          try {
            const saved = await requests.client.getSettings();
            // A newer write can start and finish while this read is still pending.
            if (requests === currentRequests.current && reconcileSeq === requests.seq) setSettings(saved);
          } catch {
            if (requests === currentRequests.current && reconcileSeq === requests.seq) {
              requests.needsReconcile = true; // try again after the next update
            }
          }
        }
      }
    },
    [requests, toast],
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
        const evictionVersion = feed.evictionVersion;
        const page = await client.recentEvents(INITIAL_PAGE);
        if (cancelled) return;
        feed.merge(page);
        if (page.length < INITIAL_PAGE) feed.markReachedStart(evictionVersion);
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
    const evictionVersion = feed.evictionVersion;
    try {
      const page = await client.recentEvents(OLDER_PAGE, cursor);
      // Eviction moved the cursor: merging this page would skip the intervening history.
      if (evictionVersion !== feed.evictionVersion) return;
      feed.mergeOlder(page);
      if (page.length < OLDER_PAGE) feed.markReachedStart(evictionVersion);
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
