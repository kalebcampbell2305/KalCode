/**
 * The widget framework (Z7-W3). `WidgetDock` is the Dashboard's dock; `WidgetPane` renders one
 * widget as pane content for the pane system (Z7-W1: `PaneContent::Widget { widgetId }`).
 */
export { type LayoutChange, MAX_VISIBLE_WIDGETS, type WidgetLayout } from "./layout.ts";
export { WIDGETS, type WidgetDefinition, widgetById } from "./registry.tsx";
export { AVAILABLE_WIDGETS, WidgetDock } from "./WidgetDock.tsx";
export { WidgetPane, widgetPaneMeta } from "./WidgetPane.tsx";
