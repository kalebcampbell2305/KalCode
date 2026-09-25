import type { FeatureFlag, SurfaceFlag, SurfaceId } from "@kalcode/protocol";
import {
  AudioLines,
  Blocks,
  Bot,
  BrainCircuit,
  CalendarClock,
  Code2,
  Flag,
  FolderGit2,
  House,
  LayoutDashboard,
  type LucideIcon,
  MessagesSquare,
  PanelsTopLeft,
  PlugZap,
  Settings as SettingsIcon,
  Workflow,
} from "lucide-react";
import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from "react";

export interface SurfaceMeta {
  id: SurfaceId;
  label: string;
  icon: LucideIcon;
  /** One line describing what the surface is for (used on gated pages and in the palette). */
  summary: string;
  /** What must exist before the surface can ship (gated pages only). */
  dependsOn?: string;
}

export const SURFACES: Record<SurfaceId, SurfaceMeta> = {
  dashboard: {
    id: "dashboard",
    label: "Dashboard",
    icon: LayoutDashboard,
    summary: "What's running, who is doing it, and what needs your approval.",
  },
  kalvoice: {
    id: "kalvoice",
    label: "KalVoice",
    icon: AudioLines,
    summary:
      "Dictate prompts into any input and run KalCode by voice or text. Dictation runs on your computer; reasoning uses your own connected provider.",
    dependsOn: "Local speech recognition and the thread runtime",
  },
  code: {
    id: "code",
    label: "Code",
    icon: Code2,
    summary: "Your project folders with real terminals, restored after a restart.",
  },
  threads: {
    id: "threads",
    label: "Threads",
    icon: MessagesSquare,
    summary: "Persistent units of AI work that run Claude Code, Codex or Gemini CLI in your projects.",
  },
  agents: {
    id: "agents",
    label: "Agents",
    icon: Bot,
    summary: "Persistent AI teammates with a role, instructions, provider and permissions.",
    dependsOn: "Threads and permissions",
  },
  missions: {
    id: "missions",
    label: "Missions",
    icon: Flag,
    summary: "Hand KalCode an outcome; it plans tasks, runs agents in parallel and verifies the result.",
    dependsOn: "Agents and the verification engine",
  },
  automations: {
    id: "automations",
    label: "Automations",
    icon: CalendarClock,
    summary: "Scheduled and event-triggered runs of agents and missions.",
    dependsOn: "Agents and missions",
  },
  skills: {
    id: "skills",
    label: "Skills",
    icon: Workflow,
    summary: "Reusable, versioned procedures you can assign to agents and workspaces.",
    dependsOn: "Agents",
  },
  plugins: {
    id: "plugins",
    label: "Plugins",
    icon: Blocks,
    summary: "Connect services like GitHub or Linear with capability-level permissions.",
    dependsOn: "The permission engine",
  },
  memory: {
    id: "memory",
    label: "Memory",
    icon: BrainCircuit,
    summary: "Scoped, inspectable memory for you, your projects and your agents.",
    dependsOn: "Agents and workspaces",
  },
  providers: {
    id: "providers",
    label: "Providers",
    icon: PlugZap,
    summary:
      "See which provider CLIs are installed, signed in and healthy, and how KalCode's permission modes map to each.",
  },
  command_center: {
    id: "command_center",
    label: "Command Center",
    icon: PanelsTopLeft,
    summary:
      "The deep operations view above the Dashboard: agents, tasks, providers, resources and recovery in one place.",
    dependsOn: "Agents, missions and the systems whose panels it shows",
  },
  settings: {
    id: "settings",
    label: "Settings",
    icon: SettingsIcon,
    summary: "Appearance, diagnostics and information about this build.",
  },
};

/**
 * Places in the app that aren't contract surfaces (Z7-W2): the returning-user home and the
 * folder/project surface of the active workspace. They follow the `workspace_home` and
 * `workspace_rail` feature flags.
 */
export type AppView = "home" | "folder";
export type Destination = SurfaceId | AppView;

export interface ViewMeta {
  id: AppView;
  label: string;
  icon: LucideIcon;
  summary: string;
}

export const VIEWS: Record<AppView, ViewMeta> = {
  home: {
    id: "home",
    label: "Home",
    icon: House,
    summary: "Where you left off: what's running, what needs you and what finished.",
  },
  folder: {
    id: "folder",
    label: "Project",
    icon: FolderGit2,
    summary: "The active workspace: files, Git status, recent files, threads and terminals.",
  },
};

/** Label and icon of any destination. */
export function destinationMeta(id: Destination): { label: string; icon: LucideIcon; summary: string } {
  return id === "home" || id === "folder" ? VIEWS[id] : SURFACES[id];
}

/** Whether the build shows a view (its feature flag is visible). */
export function viewVisible(view: AppView, features: readonly FeatureFlag[] | undefined): boolean {
  const feature = view === "home" ? "workspace_home" : "workspace_rail";
  return features?.some((f) => f.id === feature && f.visible) ?? false;
}

/** Navigation order within the sidebar. Settings is pinned to the bottom separately. */
export const PRIMARY_ORDER: readonly SurfaceId[] = [
  "dashboard",
  "kalvoice",
  "code",
  "threads",
  "agents",
  "missions",
  "automations",
  "skills",
  "plugins",
  "memory",
  "command_center",
  "providers",
];

interface NavigationValue {
  current: Destination;
  navigate: (id: Destination) => void;
}

const NavigationContext = createContext<NavigationValue | null>(null);

export function NavigationProvider({
  flags,
  features,
  children,
}: {
  flags: readonly SurfaceFlag[];
  /** Feature flags (Z7-W2 views follow `workspace_home` / `workspace_rail`). */
  features?: readonly FeatureFlag[];
  children: ReactNode;
}) {
  // Home is where a session starts once its feature is available (not merely visible in a
  // development build), so gated builds keep the Dashboard as the first page.
  const [current, setCurrent] = useState<Destination>(() =>
    features?.some((f) => f.id === "workspace_home" && f.state === "available" && f.visible) ? "home" : "dashboard",
  );
  const visible = useMemo(() => {
    const ids = new Set<Destination>(flags.filter((f) => f.visible).map((f) => f.id));
    for (const view of ["home", "folder"] as const) if (viewVisible(view, features)) ids.add(view);
    return ids;
  }, [flags, features]);
  const navigate = useCallback(
    (id: Destination) => {
      if (visible.has(id)) setCurrent(id);
    },
    [visible],
  );
  const value = useMemo(() => ({ current, navigate }), [current, navigate]);
  return <NavigationContext.Provider value={value}>{children}</NavigationContext.Provider>;
}

export function useNavigation(): NavigationValue {
  const value = useContext(NavigationContext);
  if (!value) throw new Error("useNavigation must be used inside <NavigationProvider>");
  return value;
}
