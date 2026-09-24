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
  const confirmed = useRef(initialSettings);
  const requestSeq = useRef(0);

  const updateSettings = useCallback(
    async (patch: SettingsPatch) => {
      const id = ++requestSeq.current;
      setSettings((current) => ({ ...current, ...patch }));
      try {
        const next = await client.updateSettings(patch);
        confirmed.current = next;
        // Only the latest request may overwrite local state, so out-of-order responses
        // can't undo a newer change.
        if (id === requestSeq.current) setSettings(next);
      } catch (error) {
        const err = toKalCodeError(error);
        if (id === requestSeq.current) setSettings(confirmed.current);
        toast.show({ tone: "danger", title: "Settings not saved", description: err.message });
      }
    },
    [client, toast],
  );

  const [feed] = useState(() => new EventFeed());
  const [eventsState, setEventsState] = useState<LoadState>("loading");
  const [eventsError, setEventsError] = useState<KalCodeError | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    let unsubscribe: (() => Promise<void>) | null = null;
    setEventsState("loading");
    (async () => {
      try {
        // Subscribe before backfilling so no event can fall between the two calls.
        unsubscribe = await client.subscribeEvents((event) => feed.merge([event]));
        if (cancelled) return;
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
      feed.merge(page);
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
  const events = useSyncExternalStore(feed.subscribe, feed.getSnapshot);
  return { events, state: eventsState, error: eventsError, retry: retryEvents, loadOlder: loadOlderEvents, reachedStart: feed.reachedStart };
}
