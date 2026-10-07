/**
 * Command Deck layout state shared by the top bar, the projects list and the Workspace Dock: the
 * projects list's fold, and the two dock rules that aren't per workspace. On the Dashboard — whose
 * board already lists every agent — the dock starts as its collapsed rail and opens there only on
 * request, so the board keeps its width; a narrow window keeps the dock as its rail until the
 * person opens it. The dock's own arrangement (tabs, width, the person's collapse choice) is kept
 * per workspace by the dock itself (`shell/dock/layout.ts`).
 */

import { useToast } from "@kalcode/ui/components";
import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from "react";
import { useNavigation } from "../navigation.tsx";

const PROJECTS_KEY = "kalcode.deck.projectsCollapsed";
/** Below this window width the dock starts as its narrow rail (until the person chooses). */
const NARROW_PX = 1280;

interface DeckUiValue {
  projectsCollapsed: boolean;
  setProjectsCollapsed: (collapsed: boolean) => void;
  /** The Dashboard is showing: the dock is its rail unless opened for this visit. */
  onDashboard: boolean;
  dashboardDockOpen: boolean;
  setDashboardDockOpen: (open: boolean) => void;
  /** The window was wide enough at launch for the dock to open on its own. */
  wide: boolean;
  /** Bumped by `revealAgents`: the dock shows its Agents tab and takes focus. */
  revealRequest: number;
  /** Shows the dock's Agents now (from the top bar's "working" signal) without pinning it open. */
  revealAgents: () => void;
}

const DeckUiContext = createContext<DeckUiValue | null>(null);

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
  const [wide] = useState(() => typeof window === "undefined" || window.innerWidth >= NARROW_PX);
  // Opened on the Dashboard for this visit only; leaving the Dashboard resets it.
  const [dashboardDockOpen, setDashboardDockOpen] = useState(false);
  const [lastOnDashboard, setLastOnDashboard] = useState(onDashboard);
  if (lastOnDashboard !== onDashboard) {
    setLastOnDashboard(onDashboard);
    setDashboardDockOpen(false);
  }
  const [revealRequest, setRevealRequest] = useState(0);
  const revealAgents = useCallback(() => setRevealRequest((request) => request + 1), []);
  const value = useMemo(
    () => ({
      projectsCollapsed,
      setProjectsCollapsed,
      onDashboard,
      dashboardDockOpen,
      setDashboardDockOpen,
      wide,
      revealRequest,
      revealAgents,
    }),
    [projectsCollapsed, setProjectsCollapsed, onDashboard, dashboardDockOpen, wide, revealRequest, revealAgents],
  );
  return <DeckUiContext.Provider value={value}>{children}</DeckUiContext.Provider>;
}

export function useDeckUi(): DeckUiValue {
  const value = useContext(DeckUiContext);
  if (!value) throw new Error("useDeckUi must be used inside <DeckUiProvider>");
  return value;
}
