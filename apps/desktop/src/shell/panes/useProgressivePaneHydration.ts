import type { PaneContent } from "@kalcode/protocol";
import { useEffect, useRef, useState } from "react";

/** Terminal-backed and native-webview panes are deferred until their frame is already painted. */
export function isHeavyPaneContent(content: PaneContent): boolean {
  return content.kind === "terminal" || content.kind === "agent" || content.kind === "browser";
}

export interface PaneHydrationCandidate {
  key: string;
  paneId: string;
  visible: boolean;
}

const HYDRATION_BATCH_SIZE = 2;

type ScheduledFrame = { kind: "animation" | "timeout"; id: number };

function scheduleFrame(callback: FrameRequestCallback): ScheduledFrame {
  if (typeof window.requestAnimationFrame === "function") {
    return { kind: "animation", id: window.requestAnimationFrame(callback) };
  }
  return {
    kind: "timeout",
    id: window.setTimeout(() => callback(performance.now()), 16),
  };
}

function cancelFrame(frame: ScheduledFrame | null) {
  if (!frame) return;
  if (frame.kind === "animation") window.cancelAnimationFrame(frame.id);
  else window.clearTimeout(frame.id);
}

function sameSet(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  return left.size === right.size && [...left].every((key) => right.has(key));
}

/**
 * Hydrates the focused visible heavy pane after the shell paints, then at most two other visible
 * panes per animation frame. Hydrated identities remain mounted while hidden or moved. Removing
 * an identity from `candidates` cancels any queued work and forgets it.
 */
export function useProgressivePaneHydration(
  candidates: readonly PaneHydrationCandidate[],
  focusedPaneId: string | null,
): ReadonlySet<string> {
  const [hydrated, setHydrated] = useState<ReadonlySet<string>>(() => new Set());
  const hydratedRef = useRef(hydrated);
  const candidatesRef = useRef(new Map<string, PaneHydrationCandidate>());
  candidatesRef.current = new Map(candidates.map((candidate) => [candidate.key, candidate]));

  useEffect(() => {
    let disposed = false;
    let frame: ScheduledFrame | null = null;
    const currentKeys = new Set(candidates.map(({ key }) => key));
    const pending = candidates.filter(({ key, visible }) => visible && !hydratedRef.current.has(key));
    const focusedIndex = pending.findIndex(({ paneId }) => paneId === focusedPaneId);
    const focused = focusedIndex >= 0 ? pending.splice(focusedIndex, 1)[0] : undefined;

    const add = (keys: readonly string[]) => {
      if (disposed) return;
      setHydrated((previous) => {
        const next = new Set([...previous].filter((key) => currentKeys.has(key)));
        for (const key of keys) if (currentKeys.has(key)) next.add(key);
        hydratedRef.current = next;
        return sameSet(previous, next) ? previous : next;
      });
    };

    // This effect runs after the pane frames paint. The focused body gets the first follow-up
    // render, before background panes begin their animation-frame batches.
    add(focused ? [focused.key] : []);

    const pump = () => {
      frame = null;
      if (disposed) return;
      const batch: string[] = [];
      while (pending.length > 0 && batch.length < HYDRATION_BATCH_SIZE) {
        const candidate = pending.shift();
        const latest = candidate && candidatesRef.current.get(candidate.key);
        if (latest?.visible) batch.push(latest.key);
      }
      add(batch);
      if (pending.length > 0) frame = scheduleFrame(pump);
    };
    if (pending.length > 0) frame = scheduleFrame(pump);

    return () => {
      disposed = true;
      cancelFrame(frame);
    };
  }, [candidates, focusedPaneId]);

  return hydrated;
}
