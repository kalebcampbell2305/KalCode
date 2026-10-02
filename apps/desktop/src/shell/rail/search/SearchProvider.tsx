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

/** The stable setters: never change, so callers that only open search never re-render on typing. */
export type SearchActions = Pick<SearchValue, "setOpen" | "setQuery" | "setKinds" | "openWith">;

/** Open state only: changes when the palette opens or closes, not on each keystroke. */
export type SearchOpenValue = Pick<SearchValue, "open" | "setOpen">;

const SearchContext = createContext<SearchValue | null>(null);
const SearchActionsContext = createContext<SearchActions | null>(null);
const SearchOpenContext = createContext<SearchOpenValue | null>(null);

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
  const actions = useMemo(() => ({ setOpen, setQuery, setKinds, openWith }), [setOpen, openWith]);
  const openValue = useMemo(() => ({ open, setOpen }), [open, setOpen]);
  const value = useMemo(
    () => ({ open, setOpen, query, setQuery, kinds, setKinds, openWith }),
    [open, setOpen, query, kinds, openWith],
  );
  return (
    <SearchActionsContext.Provider value={actions}>
      <SearchOpenContext.Provider value={openValue}>
        <SearchContext.Provider value={value}>{children}</SearchContext.Provider>
      </SearchOpenContext.Provider>
    </SearchActionsContext.Provider>
  );
}

/** Everything, including the query: re-renders on every keystroke (the palette itself). */
export function useSearch(): SearchValue {
  const value = useContext(SearchContext);
  if (!value) throw new Error("useSearch must be used inside <SearchProvider>");
  return value;
}

/** Open state and its setter only (the shell): unaffected by typing in the palette. */
export function useSearchOpen(): SearchOpenValue {
  const value = useContext(SearchOpenContext);
  if (!value) throw new Error("useSearchOpen must be used inside <SearchProvider>");
  return value;
}

/** For components that may render outside the shell (tests): `null` without a provider. */
export function useOptionalSearch(): SearchValue | null {
  return useContext(SearchContext);
}

/** Stable setters only, `null` without a provider: for callers that open search but never read it. */
export function useOptionalSearchActions(): SearchActions | null {
  return useContext(SearchActionsContext);
}
