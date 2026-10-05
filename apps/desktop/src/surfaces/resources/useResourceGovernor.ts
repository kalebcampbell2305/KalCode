import type { GovernorMode } from "@kalcode/protocol";
import { useCallback, useState, useSyncExternalStore } from "react";
import { toKalCodeError } from "../../ipc/errors.ts";
import { getResourceReport, type ResourceReport, setResourceMode, setResourceViewOpen } from "../../ipc/resources.ts";

export type PresetResourceMode = Exclude<GovernorMode, "custom">;

export interface ResourceGovernorData {
  report: ResourceReport | null;
  error: string | null;
  loading: boolean;
  changingMode: boolean;
  refresh: () => void;
  changeMode: (mode: PresetResourceMode) => void;
}

const VISIBLE_POLL_MS = 1_000;

interface Observation {
  report: ResourceReport | null;
  error: string | null;
}

const EMPTY: Observation = { report: null, error: null };

/**
 * One poller shared by every mounted consumer (ref-counted subscribers): two views never read
 * twice a second, and the native "resource view open" flag has one owner, so one view closing
 * can't clear it under another. Reads only in-memory native state, and pauses while the window is
 * hidden (native sampling remains independently bounded).
 */
const shared = {
  observation: EMPTY,
  listeners: new Set<() => void>(),
  timer: undefined as number | undefined,
  inFlight: false,
  again: false,
  viewOpen: false,
};

const windowVisible = () => document.visibilityState === "visible";

function publish(next: Observation) {
  shared.observation = next;
  for (const listener of [...shared.listeners]) listener();
}

/** Reads after `delay`; nothing is scheduled without subscribers or while the window is hidden. */
function schedule(delay: number) {
  if (shared.timer !== undefined) window.clearTimeout(shared.timer);
  shared.timer = undefined;
  if (shared.listeners.size === 0 || !windowVisible()) return;
  shared.timer = window.setTimeout(() => void poll(), delay);
}

async function poll() {
  shared.timer = undefined;
  if (shared.inFlight) {
    shared.again = true;
    return;
  }
  shared.inFlight = true;
  let next: Observation | null = null;
  try {
    next = { report: await getResourceReport(), error: null };
  } catch (cause) {
    next = { report: shared.observation.report, error: toKalCodeError(cause).message };
  } finally {
    shared.inFlight = false;
    const again = shared.again;
    shared.again = false;
    if (shared.listeners.size > 0) {
      if (next) publish(next);
      schedule(again ? 0 : VISIBLE_POLL_MS);
    }
  }
}

function setViewOpen(open: boolean) {
  if (shared.viewOpen === open) return;
  shared.viewOpen = open;
  void setResourceViewOpen(open).catch(() => undefined);
}

function syncVisibility() {
  setViewOpen(windowVisible());
  schedule(0);
}

function subscribe(listener: () => void): () => void {
  shared.listeners.add(listener);
  if (shared.listeners.size === 1) {
    document.addEventListener("visibilitychange", syncVisibility);
    syncVisibility();
  }
  return () => {
    shared.listeners.delete(listener);
    if (shared.listeners.size > 0) return;
    document.removeEventListener("visibilitychange", syncVisibility);
    schedule(0);
    shared.observation = EMPTY;
    setViewOpen(false);
  };
}

const observe = () => shared.observation;
const refresh = () => {
  if (shared.listeners.size > 0) schedule(0);
};

export function useResourceGovernor(): ResourceGovernorData {
  const { report, error } = useSyncExternalStore(subscribe, observe, observe);
  const [changingMode, setChangingMode] = useState(false);

  const changeMode = useCallback(async (mode: PresetResourceMode) => {
    setChangingMode(true);
    try {
      const next = await setResourceMode({ mode });
      if (shared.listeners.size > 0) publish({ report: next, error: null });
    } catch (cause) {
      if (shared.listeners.size > 0) publish({ ...shared.observation, error: toKalCodeError(cause).message });
    } finally {
      setChangingMode(false);
    }
  }, []);

  return {
    report,
    error,
    loading: report === null && error === null,
    changingMode,
    refresh,
    changeMode: (mode) => void changeMode(mode),
  };
}
