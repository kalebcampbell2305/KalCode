/**
 * Command Deck layout state: whether the agents rail is open. Until the person pins it open or
 * collapses it (remembered per device), the rail follows the agents: it stays a strip while no
 * agent is running and nothing needs the person, and opens on its own when one is. On the
 * Dashboard — whose board already lists every agent — the rail starts as its strip of live counts
 * and opens there only on request, so the board keeps its width.
 */

import { useToast } from "@kalcode/ui/components";
import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from "react";
import { useNavigation } from "../navigation.tsx";

// v2: choices made before the rail followed the agents are not carried over (everyone starts on auto).
const STORAGE_KEY = "kalcode.deck.agentsRail.v2";
const PROJECTS_KEY = "kalcode.deck.projectsCollapsed";
/** Below this window width the agents rail starts as its narrow strip (until the person chooses). */
const NARROW_PX = 1280;

interface DeckUiValue {
  projectsCollapsed: boolean;
  setProjectsCollapsed: (collapsed: boolean) => void;
  agentsOpen: boolean;
  /** The person's own choice: pins the rail open or collapsed, remembered across restarts. */
  setAgentsOpen: (open: boolean) => void;
  /** The agents rail reports whether any agent is running or needs the person (auto mode). */
  setAgentsActive: (active: boolean) => void;
  /** Opens the rail and moves focus into it (from the top bar's "working" signal). */
  revealAgents: () => void;
}

const DeckUiContext = createContext<DeckUiValue | null>(null);

type RailChoice = "open" | "closed" | null;

function initialChoice(): RailChoice {
  try {
    const saved = window.localStorage.getItem(STORAGE_KEY);
    if (saved === "open" || saved === "closed") return saved;
  } catch {
    // Storage unavailable: the rail follows the agents.
  }
  return null;
}

export function DeckUiProvider({ children }: { children: ReactNode }) {
  const toast = useToast();
  const [projectsCollapsed, setProjects] = useState(() => {
    try {
      return window.localStorage.getItem(PROJECTS_KEY) === "true";
    } catch {
      return false;
    }
  });
  const setProjectsCollapsed = useCallback(
    (collapsed: boolean) => {
      setProjects(collapsed);
      try {
        window.localStorage.setItem(PROJECTS_KEY, String(collapsed));
      } catch {
        toast.show({
          tone: "danger",
          title: "Couldn't remember the Projects layout",
          description: "Your choice applies until KalCode closes.",
        });
      }
    },
    [toast],
  );
  const { current } = useNavigation();
  const onDashboard = current === "dashboard";
  const [choice, setChoice] = useState<RailChoice>(initialChoice);
  const [agentsActive, setAgentsActive] = useState(false);
  // A narrow window keeps the rail as its strip unless the person opens it.
  const [wide] = useState(() => typeof window === "undefined" || window.innerWidth >= NARROW_PX);
  // Opened on the Dashboard for this visit only; leaving the Dashboard resets it.
  const [dashboardOpen, setDashboardOpen] = useState(false);
  const [lastOnDashboard, setLastOnDashboard] = useState(onDashboard);
  if (lastOnDashboard !== onDashboard) {
    setLastOnDashboard(onDashboard);
    setDashboardOpen(false);
  }

  const choose = useCallback(
    (open: boolean, remember: boolean) => {
      if (onDashboard) {
        setDashboardOpen(open);
        return;
      }
      setChoice(open ? "open" : "closed");
      if (!remember) return;
      try {
        window.localStorage.setItem(STORAGE_KEY, open ? "open" : "closed");
      } catch {
        // Not remembered; the choice still applies now.
      }
    },
    [onDashboard],
  );
  const setAgentsOpen = useCallback((open: boolean) => choose(open, true), [choose]);
  // The top bar's "working" signal shows the rail now without pinning it for later.
  const revealAgents = useCallback(() => {
    choose(true, false);
    requestAnimationFrame(() => document.getElementById("deck-agents")?.focus());
  }, [choose]);
  const agentsOpen = onDashboard ? dashboardOpen : choice !== null ? choice === "open" : agentsActive && wide;
  const value = useMemo(
    () => ({ agentsOpen, setAgentsOpen, setAgentsActive, revealAgents, projectsCollapsed, setProjectsCollapsed }),
    [agentsOpen, setAgentsOpen, revealAgents, projectsCollapsed, setProjectsCollapsed],
  );
  return <DeckUiContext.Provider value={value}>{children}</DeckUiContext.Provider>;
}

export function useDeckUi(): DeckUiValue {
  const value = useContext(DeckUiContext);
  if (!value) throw new Error("useDeckUi must be used inside <DeckUiProvider>");
  return value;
}
