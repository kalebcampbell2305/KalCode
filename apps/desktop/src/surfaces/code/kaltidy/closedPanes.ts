import { useEffect, useRef } from "react";
import { contentKey } from "../../../shell/panes/model.ts";

/**
 * How KalTidy closes panes. The Code canvas owns its pane layout, so KalTidy announces each
 * terminal or agent it actually ended and the canvas takes that pane out (a closed terminal
 * would also leave on the next terminal list read; a removed agent's pane would otherwise stay).
 * Pane content keys are unique across workspaces, so a canvas that doesn't show it ignores it.
 */
type Listener = (keys: ReadonlySet<string>) => void;

const listeners = new Set<Listener>();

/** Tells the Code canvas that this terminal or agent has ended, so its pane closes. */
export function announceClosedPane(item: { kind: "terminal" | "agent"; id: string }): void {
  const key =
    item.kind === "terminal"
      ? contentKey({ kind: "terminal", terminalId: item.id })
      : contentKey({ kind: "agent", agentId: item.id });
  const keys = new Set([key]);
  for (const listener of listeners) listener(keys);
}

/** For the Code canvas: `forget` receives the pane content keys KalTidy closed. */
export function useKalTidyClosedPanes(forget: (keys: ReadonlySet<string>) => void): void {
  const latest = useRef(forget);
  latest.current = forget;
  useEffect(() => {
    const listener: Listener = (keys) => latest.current(keys);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);
}
