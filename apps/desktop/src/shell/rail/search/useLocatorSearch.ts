import type { LocatorEntityKind, LocatorResponse } from "@kalcode/protocol";
import { useEffect, useRef, useState } from "react";
import { type KalCodeError, toKalCodeError } from "../../../ipc/errors.ts";
import { useRuntime } from "../../../runtime/RuntimeProvider.tsx";

export interface LocatorSearchState {
  response: LocatorResponse | null;
  /** The text `response` answers (results for older text are never shown as current). */
  forText: string;
  loading: boolean;
  error: KalCodeError | null;
}

/**
 * Debounced Session Locator search. Only the latest query's answer is kept; an empty query
 * clears. The query text goes to the local index only (never stored).
 */
export function useLocatorSearch(
  query: string,
  {
    kinds = [],
    limit = 12,
    delayMs = 90,
    enabled = true,
  }: { kinds?: readonly LocatorEntityKind[]; limit?: number; delayMs?: number; enabled?: boolean } = {},
): LocatorSearchState {
  const { client } = useRuntime();
  const [state, setState] = useState<LocatorSearchState>({ response: null, forText: "", loading: false, error: null });
  const latest = useRef(0);
  const kindKey = kinds.join(",");

  useEffect(() => {
    const text = query.trim();
    const id = ++latest.current;
    if (!enabled || text === "") {
      setState({ response: null, forText: "", loading: false, error: null });
      return;
    }
    // Results and errors belong to the complete previous query, including filters/client.
    setState({ response: null, forText: text, loading: true, error: null });
    const timer = setTimeout(() => {
      client
        .locatorSearch({
          text,
          kinds: kindKey ? (kindKey.split(",") as LocatorEntityKind[]) : [],
          page: { limit, cursor: null },
        })
        .then((response) => {
          if (latest.current === id) setState({ response, forText: text, loading: false, error: null });
        })
        .catch((cause) => {
          if (latest.current === id)
            setState({ response: null, forText: text, loading: false, error: toKalCodeError(cause) });
        });
    }, delayMs);
    return () => {
      clearTimeout(timer);
      latest.current += 1;
    };
  }, [client, query, kindKey, limit, delayMs, enabled]);

  return state;
}
