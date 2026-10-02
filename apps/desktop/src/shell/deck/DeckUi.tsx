/**
 * Command Deck layout state: whether the agents rail is open. Remembered per device. On the
 * Dashboard — whose board already lists every agent — the rail starts as its strip of live counts
 * and opens there only on request, so the board keeps its width.
 */
import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from "react";
import { useNavigation } from "../navigation.tsx";

const STORAGE_KEY = "kalcode.deck.agentsRail";
/** Below this window width the agents rail starts as its narrow strip (until the person chooses). */
const NARROW_PX = 1280;

interface DeckUiValue {
  agentsOpen: boolean;
  setAgentsOpen: (open: boolean) => void;
  /** Opens the rail and moves focus into it (from the top bar's "working" signal). */
  revealAgents: () => void;
}

const DeckUiContext = createContext<DeckUiValue | null>(null);

function initialOpen(): boolean {
  try {
    const saved = window.localStorage.getItem(STORAGE_KEY);
    if (saved === "open") return true;
    if (saved === "closed") return false;
  } catch {
    // Storage unavailable: fall through to the width default.
  }
  return typeof window === "undefined" || window.innerWidth >= NARROW_PX;
}

export function DeckUiProvider({ children }: { children: ReactNode }) {
  const { current } = useNavigation();
  const onDashboard = current === "dashboard";
  const [saved, setSaved] = useState(initialOpen);
  // Opened on the Dashboard for this visit only; leaving the Dashboard resets it.
  const [dashboardOpen, setDashboardOpen] = useState(false);
  const [lastOnDashboard, setLastOnDashboard] = useState(onDashboard);
  if (lastOnDashboard !== onDashboard) {
    setLastOnDashboard(onDashboard);
    setDashboardOpen(false);
  }

  const setAgentsOpen = useCallback(
    (open: boolean) => {
      if (onDashboard) {
        setDashboardOpen(open);
        return;
      }
      setSaved(open);
      try {
        window.localStorage.setItem(STORAGE_KEY, open ? "open" : "closed");
      } catch {
        // Not remembered; the choice still applies now.
      }
    },
    [onDashboard],
  );
  const revealAgents = useCallback(() => {
    setAgentsOpen(true);
    requestAnimationFrame(() => document.getElementById("deck-agents")?.focus());
  }, [setAgentsOpen]);
  const agentsOpen = onDashboard ? dashboardOpen : saved;
  const value = useMemo(() => ({ agentsOpen, setAgentsOpen, revealAgents }), [agentsOpen, setAgentsOpen, revealAgents]);
  return <DeckUiContext.Provider value={value}>{children}</DeckUiContext.Provider>;
}

export function useDeckUi(): DeckUiValue {
  const value = useContext(DeckUiContext);
  if (!value) throw new Error("useDeckUi must be used inside <DeckUiProvider>");
  return value;
}
