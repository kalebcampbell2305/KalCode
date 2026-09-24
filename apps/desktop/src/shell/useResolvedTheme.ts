import { useSyncExternalStore } from "react";

/** The theme currently applied to <html> (`data-theme`), kept in sync as it changes. */
export function useResolvedTheme(): "light" | "dark" {
  return useSyncExternalStore(subscribe, read, () => "dark");
}

function read(): "light" | "dark" {
  return document.documentElement.dataset.theme === "light" ? "light" : "dark";
}

function subscribe(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  return () => observer.disconnect();
}
