import { EmptyState } from "@kalcode/ui/components";
import { Blocks } from "lucide-react";
import { DashboardDataBoundary } from "../../surfaces/dashboard/data/DashboardData.tsx";
import { widgetById } from "./registry.tsx";
import styles from "./WidgetPane.module.css";

/**
 * A widget as pane content (`PaneContent::Widget { widgetId }`, Z7-W1). The pane system supplies
 * the frame (title bar, split, close); this renders the widget's body filling the pane. An id this
 * build doesn't know renders as unavailable, like any unknown pane leaf.
 */
export function WidgetPane({ widgetId }: { widgetId: string }) {
  const widget = widgetById(widgetId);
  if (!widget) {
    return (
      <EmptyState art={<Blocks />} title="Widget unavailable" framed={false}>
        <p>This build doesn't include that widget.</p>
      </EmptyState>
    );
  }
  const Body = widget.Body;
  return (
    <DashboardDataBoundary>
      <section className={styles.pane} aria-label={widget.title} data-widget-pane={widget.id}>
        <Body />
      </section>
    </DashboardDataBoundary>
  );
}

/** Title and icon for a widget pane's header (the pane system renders them). */
export function widgetPaneMeta(widgetId: string) {
  const widget = widgetById(widgetId);
  return widget ? { title: widget.title, icon: widget.icon } : null;
}
