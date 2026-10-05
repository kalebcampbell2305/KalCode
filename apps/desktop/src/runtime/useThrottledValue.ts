import { useEffect, useRef, useState } from "react";

/** How often an event-driven re-read may run: one event passes at once, a burst becomes one more read. */
export const EVENT_REFRESH_MS = 500;

/**
 * Follows `value` at most once per `ms`. The first change after a quiet period passes through at
 * once; a burst of changes collapses into one trailing update. While the window is hidden, changes
 * wait and the newest one passes when it is shown again.
 */
export function useThrottledValue<T>(value: T, ms: number = EVENT_REFRESH_MS): T {
  const [shown, setShown] = useState(value);
  const lastPassed = useRef(0);

  useEffect(() => {
    if (Object.is(value, shown)) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const hidden = () => typeof document !== "undefined" && document.visibilityState === "hidden";
    const pass = () => {
      if (hidden()) return;
      lastPassed.current = Date.now();
      setShown(value);
    };
    const onVisible = () => {
      if (!hidden()) schedule();
    };
    const schedule = () => {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      const wait = lastPassed.current + ms - Date.now();
      if (wait <= 0) pass();
      else timer = setTimeout(pass, wait);
    };
    schedule();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      if (timer !== undefined) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [value, shown, ms]);

  return shown;
}
