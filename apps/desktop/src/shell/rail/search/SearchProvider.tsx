import type { LocatorEntityKind } from "@kalcode/protocol";
import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from "react";

/**
 * The command palette's open state and query, shared so search can be opened with a query from
 * anywhere (the rail, Home, KalVoice's "search for …" / "what was I working on yesterday").
 */
export interface SearchValue {
  open: boolean;
  setOpen: (open: boolean) => void;
  query: string;
  setQuery: (query: string) => void;
  /** Kinds the results are limited to (empty = everything). */
  kinds: readonly LocatorEntityKind[];
  setKinds: (kinds: readonly LocatorEntityKind[]) => void;
  /** Opens the palette showing `query`. */
  openWith: (query: string, kinds?: readonly LocatorEntityKind[]) => void;
}

const SearchContext = createContext<SearchValue | null>(null);

export function SearchProvider({ children }: { children: ReactNode }) {
  const [open, setOpenState] = useState(false);
  const [query, setQuery] = useState("");
  const [kinds, setKinds] = useState<readonly LocatorEntityKind[]>([]);
  const setOpen = useCallback((next: boolean) => {
    setOpenState(next);
    // A fresh palette starts empty; a closed one forgets what was typed (never stored).
    if (!next) {
      setQuery("");
      setKinds([]);
    }
  }, []);
  const openWith = useCallback((text: string, only: readonly LocatorEntityKind[] = []) => {
    setQuery(text);
    setKinds(only);
    setOpenState(true);
  }, []);
  const value = useMemo(
    () => ({ open, setOpen, query, setQuery, kinds, setKinds, openWith }),
    [open, setOpen, query, kinds, openWith],
  );
  return <SearchContext.Provider value={value}>{children}</SearchContext.Provider>;
}

export function useSearch(): SearchValue {
  const value = useContext(SearchContext);
  if (!value) throw new Error("useSearch must be used inside <SearchProvider>");
  return value;
}

/** For components that may render outside the shell (tests): `null` without a provider. */
export function useOptionalSearch(): SearchValue | null {
  return useContext(SearchContext);
}
