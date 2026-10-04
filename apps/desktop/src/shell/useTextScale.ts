import type { TextSize } from "@kalcode/protocol";
import { useSyncExternalStore } from "react";
import { TEXT_SCALE } from "./appearance.ts";

/** The interface text scale applied to <html> (`data-text-size`), kept in sync as it changes. */
export function useTextScale(): number {
  return useSyncExternalStore(subscribe, read, () => 1);
}

function read(): number {
  const size = document.documentElement.dataset.textSize as TextSize | undefined;
  return (size && TEXT_SCALE[size]) || 1;
}

function subscribe(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-text-size"] });
  return () => observer.disconnect();
}
