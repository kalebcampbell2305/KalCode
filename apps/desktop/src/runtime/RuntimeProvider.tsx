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
  /** True only when this write succeeded and its runtime session is still current. */
  updateSettings: (patch: SettingsPatch) => Promise<boolean>;
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

function settingsSession() {
  return { seq: 0, inFlight: 0, needsReconcile: false, active: false };
}

export function RuntimeProvider({ client, info, initialSettings, children }: RuntimeProviderProps) {
  const toast = useToast();
  // biome-ignore lint/correctness/useExhaustiveDependencies: bootstrap settings are captured once per client lifetime.
  const requests = useMemo(() => ({ client, initialSettings, session: settingsSession() }), [client]);
  const currentRequests = useRef(requests);
  currentRequests.current = requests;
  const [settingsSnapshot, setSettings] = useState({ owner: requests, value: initialSettings });
  // A replacement client must never render the previous client's settings, even before
  // effects run. Returning to the same client object also starts a new lifetime.
  const settings = settingsSnapshot.owner === requests ? settingsSnapshot.value : requests.initialSettings;

  useEffect(() => {
    // StrictMode cleanup/setup must not revive unfinished writes or their counters.
    const session = settingsSession();
    session.active = true;
    requests.session = session;
    return () => {
      session.active = false;
    };
  }, [requests]);

  /**
   * Optimistic update. A lone request applies its own response. When requests overlap (their
   * responses may arrive in any order) or one fails, the UI re-reads the saved settings once
   * nothing is in flight, so it always converges on what is actually persisted.
   */
  const updateSettings = useCallback(
    async (patch: SettingsPatch) => {
      const session = requests.session;
      const isCurrentRequest = () =>
        requests === currentRequests.current && session === requests.session && session.active;
      if (!isCurrentRequest()) return false;
      const id = ++session.seq;
      session.inFlight += 1;
      if (session.inFlight > 1) session.needsReconcile = true;
      setSettings((current) => ({
        owner: requests,
        value: { ...(current.owner === requests ? current.value : requests.initialSettings), ...patch },
      }));
      let succeeded = false;
      try {
        const next = await requests.client.updateSettings(patch);
        succeeded = true;
        if (isCurrentRequest() && id === session.seq && !session.needsReconcile) {
          setSettings({ owner: requests, value: next });
        }
      } catch (error) {
        session.needsReconcile = true;
        if (isCurrentRequest()) {
          toast.show({ tone: "danger", title: "Settings not saved", description: toKalCodeError(error).message });
        }
      } finally {
        session.inFlight -= 1;
        if (isCurrentRequest() && session.inFlight === 0 && session.needsReconcile) {
          session.needsReconcile = false;
          const reconcileSeq = session.seq;
          try {
            const saved = await requests.client.getSettings();
            // A newer write can start and finish while this read is still pending.
            if (isCurrentRequest() && reconcileSeq === session.seq) {
              setSettings({ owner: requests, value: saved });
            }
          } catch {
            if (isCurrentRequest() && reconcileSeq === session.seq) {
              session.needsReconcile = true; // try again after the next update
            }
          }
        }
      }
      return succeeded && isCurrentRequest();
    },
    [requests, toast],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: each client lifetime owns a separate event log.
  const feed = useMemo(() => new EventFeed(), [requests]);
  const [attempt, setAttempt] = useState(0);
  const lifetime = useMemo(() => ({ feed, attempt, generation: 0, active: false }), [feed, attempt]);
  const currentLifetime = useRef(lifetime);
  currentLifetime.current = lifetime;
  const [events, setEvents] = useState<{ owner: typeof lifetime; state: LoadState; error: KalCodeError | null }>({
    owner: lifetime,
    state: "loading",
    error: null,
  });
  const eventsState = events.owner === lifetime ? events.state : "loading";
  const eventsError = events.owner === lifetime ? events.error : null;
  const isCurrent = useCallback(
    (generation: number) =>
      lifetime === currentLifetime.current && lifetime.active && lifetime.generation === generation,
    [lifetime],
  );

  useEffect(() => {
    const generation = ++lifetime.generation;
    lifetime.active = true;
    let unsubscribe: (() => Promise<void>) | null = null;
    (async () => {
      try {
        // Subscribe before backfilling so no event can fall between the two calls.
        const unsub = await client.subscribeEvents((event) => {
          if (isCurrent(generation)) feed.merge([event]);
        });
        if (!isCurrent(generation)) {
          // Cleaned up while subscribing (StrictMode, retry, unmount): release it now.
          void unsub();
          return;
        }
        unsubscribe = unsub;
        const evictionVersion = feed.evictionVersion;
        const page = await client.recentEvents(INITIAL_PAGE);
        if (!isCurrent(generation)) return;
        feed.merge(page);
        if (page.length < INITIAL_PAGE) feed.markReachedStart(evictionVersion);
        setEvents({ owner: lifetime, state: "ready", error: null });
      } catch (error) {
        if (!isCurrent(generation)) return;
        setEvents({ owner: lifetime, state: "error", error: toKalCodeError(error) });
      }
    })();
    return () => {
      lifetime.active = false;
      void unsubscribe?.();
    };
  }, [client, feed, lifetime, isCurrent]);

  const loadOlderEvents = useCallback(async () => {
    const generation = lifetime.generation;
    if (!isCurrent(generation)) return;
    const cursor = feed.oldestSeq;
    if (cursor === undefined || feed.reachedStart) return;
    const evictionVersion = feed.evictionVersion;
    try {
      const page = await client.recentEvents(OLDER_PAGE, cursor);
      // Eviction moved the cursor: merging this page would skip the intervening history.
      if (!isCurrent(generation) || evictionVersion !== feed.evictionVersion) return;
      feed.mergeOlder(page);
      if (page.length < OLDER_PAGE) feed.markReachedStart(evictionVersion);
    } catch (error) {
      if (!isCurrent(generation)) return;
      toast.show({ tone: "danger", title: "Couldn't load older activity", description: toKalCodeError(error).message });
    }
  }, [client, feed, toast, lifetime, isCurrent]);

  const retryEvents = useCallback(() => {
    if (isCurrent(lifetime.generation)) setAttempt((n) => n + 1);
  }, [lifetime, isCurrent]);

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

/** The runtime when this component renders inside a RuntimeProvider (isolated tests may not). */
export function useOptionalRuntime(): RuntimeValue | null {
  return useContext(RuntimeContext);
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
