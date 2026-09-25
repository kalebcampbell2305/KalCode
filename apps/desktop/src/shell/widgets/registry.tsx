import { Activity, Gauge, type LucideIcon, PlugZap, ShieldAlert, SquareTerminal, Users } from "lucide-react";
import type { ComponentType } from "react";
import type { WidgetSpec } from "./layout.ts";
import { ActiveAgentsWidget, useActiveAgentCount } from "./widgets/ActiveAgentsWidget.tsx";
import { ActivityWidget } from "./widgets/ActivityWidget.tsx";
import { ApprovalsWidget, usePendingApprovalCount } from "./widgets/ApprovalsWidget.tsx";
import { ProviderHealthWidget } from "./widgets/ProviderHealthWidget.tsx";
import { RuntimeHealthWidget } from "./widgets/RuntimeHealthWidget.tsx";
import { TerminalsWidget, useRunningTerminalCount } from "./widgets/TerminalsWidget.tsx";

/**
 * A small dockable widget (Z7-W3). Widgets render in the Dashboard's dock and, through
 * `WidgetPane`, as pane content (`PaneContent::Widget { widgetId }`, Z7-W1). Other systems add
 * widgets by appending a definition here (resources after RG, missions after Z9).
 */
export interface WidgetDefinition extends WidgetSpec {
  title: string;
  icon: LucideIcon;
  /** One line: what the widget shows (the dock's customize menu). */
  description: string;
  /** Stable id of the widget's region (other views can link to it). */
  anchor: string;
  Body: ComponentType;
  /** A count after the title; called as a hook inside the widget frame. */
  useCount?: () => number | null;
  countTone?: "neutral" | "attention";
}

export const WIDGETS: readonly WidgetDefinition[] = [
  {
    id: "approvals",
    title: "Needs your approval",
    icon: ShieldAlert,
    description: "Every pending permission request, oldest first.",
    anchor: "widget-approvals",
    Body: ApprovalsWidget,
    useCount: usePendingApprovalCount,
    countTone: "attention",
    defaultHeight: 260,
    defaultVisible: true,
  },
  {
    id: "active-agents",
    title: "Active agents",
    icon: Users,
    description: "Agents working right now and what each is doing.",
    anchor: "widget-active-agents",
    Body: ActiveAgentsWidget,
    useCount: useActiveAgentCount,
    defaultHeight: 260,
    defaultVisible: true,
  },
  {
    id: "provider-health",
    title: "Provider health",
    icon: PlugZap,
    description: "Each provider's health: sign-in, sessions, recent failures and reported rate limits. Read-only.",
    anchor: "widget-provider-health",
    Body: ProviderHealthWidget,
    defaultHeight: 200,
    defaultVisible: true,
  },
  {
    id: "activity",
    title: "Activity",
    icon: Activity,
    description: "Recorded by KalCode's event log. Updates live.",
    anchor: "activity",
    Body: ActivityWidget,
    defaultHeight: 360,
    defaultVisible: true,
  },
  {
    id: "terminals",
    title: "Terminals",
    icon: SquareTerminal,
    description: "Terminals running now, by workspace.",
    anchor: "terminals",
    Body: TerminalsWidget,
    useCount: useRunningTerminalCount,
    defaultHeight: 200,
    defaultVisible: true,
  },
  {
    id: "runtime-health",
    title: "Runtime health",
    icon: Gauge,
    description: "KalCode's core, local database, credential store and build.",
    anchor: "widget-runtime-health",
    Body: RuntimeHealthWidget,
    defaultHeight: 320,
    defaultVisible: true,
  },
];

export function widgetById(id: string): WidgetDefinition | undefined {
  return WIDGETS.find((w) => w.id === id);
}
