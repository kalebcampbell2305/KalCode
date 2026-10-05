/**
 * Contents other surfaces provide to the pane canvas (Z7-W1 ↔ Z7-W3): the live Dashboard
 * (`PaneContent::Dashboard`) and every widget of the widget framework (`PaneContent::Widget`).
 * Registered once, when the Code surface loads.
 */
import { LayoutDashboard, Puzzle } from "lucide-react";
import { registerPaneContent, registerPaneWidget } from "../../shell/panes/contentRegistry.ts";
import { AVAILABLE_WIDGETS, WidgetPane, widgetPaneMeta } from "../../shell/widgets/index.ts";
import { DashboardPane } from "../dashboard/index.ts";

registerPaneContent("dashboard", {
  describe: () => ({ title: "Agent Fleet", glyph: <LayoutDashboard />, statusText: "Live" }),
  render: () => <DashboardPane />,
});

for (const widget of AVAILABLE_WIDGETS) {
  registerPaneWidget(widget.id, {
    describe: ({ widgetId }) => {
      const meta = widgetPaneMeta(widgetId);
      const Icon = meta?.icon ?? Puzzle;
      return { title: meta?.title ?? widget.title, glyph: <Icon />, statusText: widget.description };
    },
    render: ({ widgetId }) => <WidgetPane widgetId={widgetId} />,
  });
}
