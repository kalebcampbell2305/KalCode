import { useEffect, useState } from "react";

/** Re-renders periodically so relative times and run durations stay accurate. */
export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

/** Moves focus to a section so keyboard and screen-reader users land where the summary points. */
export function focusSection(id: string) {
  const section = document.getElementById(id);
  if (!section) return;
  const heading = section.querySelector<HTMLElement>("h2");
  const target = heading ?? section;
  if (!target.hasAttribute("tabindex")) target.setAttribute("tabindex", "-1");
  target.scrollIntoView({ block: "start", behavior: "smooth" });
  target.focus({ preventScroll: true });
}
