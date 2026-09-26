import type { GovernorMode } from "@kalcode/protocol";
import { useCallback, useEffect, useRef, useState } from "react";
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
const HIDDEN_POLL_MS = 15_000;

/** Polls only in-memory native state; native sampling remains independently bounded. */
export function useResourceGovernor(): ResourceGovernorData {
  const [report, setReport] = useState<ResourceReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [changingMode, setChangingMode] = useState(false);
  const refreshRef = useRef<() => void>(() => undefined);

  useEffect(() => {
    let disposed = false;
    let inFlight = false;
    let timer: number | undefined;

    const schedule = (delay: number) => {
      if (disposed) return;
      if (timer !== undefined) window.clearTimeout(timer);
      timer = window.setTimeout(() => void poll(), delay);
    };
    const poll = async () => {
      if (disposed || inFlight) return;
      inFlight = true;
      try {
        const next = await getResourceReport();
        if (!disposed) {
          setReport(next);
          setError(null);
        }
      } catch (cause) {
        if (!disposed) setError(toKalCodeError(cause).message);
      } finally {
        inFlight = false;
        schedule(document.visibilityState === "visible" ? VISIBLE_POLL_MS : HIDDEN_POLL_MS);
      }
    };
    const syncVisibility = () => {
      const visible = document.visibilityState === "visible";
      void setResourceViewOpen(visible).catch(() => undefined);
      schedule(0);
    };

    refreshRef.current = () => schedule(0);
    document.addEventListener("visibilitychange", syncVisibility);
    syncVisibility();
    return () => {
      disposed = true;
      refreshRef.current = () => undefined;
      if (timer !== undefined) window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", syncVisibility);
      void setResourceViewOpen(false).catch(() => undefined);
    };
  }, []);

  const refresh = useCallback(() => refreshRef.current(), []);
  const changeMode = useCallback(async (mode: PresetResourceMode) => {
    setChangingMode(true);
    try {
      const next = await setResourceMode({ mode });
      setReport(next);
      setError(null);
    } catch (cause) {
      setError(toKalCodeError(cause).message);
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
