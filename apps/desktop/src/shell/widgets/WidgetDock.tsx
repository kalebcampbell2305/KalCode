import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@kalcode/ui/components";
import { SlidersHorizontal } from "lucide-react";
import { useCallback, useRef } from "react";
import { DashboardDataBoundary } from "../../surfaces/dashboard/data/DashboardData.tsx";
import { MAX_VISIBLE_WIDGETS } from "./layout.ts";
import { WIDGETS, widgetById } from "./registry.tsx";
import { useWidgetLayout } from "./useWidgetLayout.ts";
import styles from "./WidgetDock.module.css";
import { WidgetFrame } from "./WidgetFrame.tsx";

/**
 * The widget dock (Z7-W3): a column of small widgets beside the Dashboard board with sensible
 * defaults — approvals, active agents, provider health, activity, terminals. Widgets move (handle,
 * arrow keys, menu), resize (bottom edge, arrow keys, menu), hide and restore; at most
 * `MAX_VISIBLE_WIDGETS` show at once. The layout is remembered for this viewer.
 */
export function WidgetDock() {
  const [layout, change] = useWidgetLayout();
  const listRef = useRef<HTMLDivElement>(null);
  const hidden = layout.hidden.map(widgetById).filter((w) => w !== undefined);
  const full = layout.order.length >= MAX_VISIBLE_WIDGETS;

  const indexAt = useCallback(
    (clientY: number) => {
      const frames = listRef.current?.querySelectorAll<HTMLElement>(":scope > [data-widget-id]") ?? [];
      let index = 0;
      frames.forEach((frame, i) => {
        const rect = frame.getBoundingClientRect();
        if (clientY > rect.top + rect.height / 2) index = i;
      });
      return Math.min(index, layout.order.length - 1);
    },
    [layout.order.length],
  );

  return (
    <DashboardDataBoundary>
      <aside className={styles.dock} aria-label="Widgets">
        <div className={styles.dockHead}>
          <h2 className={styles.dockTitle}>Widgets</h2>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="ghost" icon={<SlidersHorizontal />}>
                Customize
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuLabel>{hidden.length > 0 ? "Hidden widgets" : "Every widget is shown"}</DropdownMenuLabel>
              {hidden.map((widget) => (
                <DropdownMenuItem
                  key={widget.id}
                  disabled={full}
                  description={full ? `At most ${MAX_VISIBLE_WIDGETS} widgets show at once.` : widget.description}
                  onSelect={() => change({ kind: "show", id: widget.id })}
                >
                  Show {widget.title}
                </DropdownMenuItem>
              ))}
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => change({ kind: "reset" })}>Reset to defaults</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        <div className={styles.list} ref={listRef}>
          {layout.order.map((id, index) => {
            const widget = widgetById(id);
            if (!widget) return null;
            return (
              <WidgetFrame
                key={id}
                widget={widget}
                height={layout.heights[id] ?? widget.defaultHeight}
                index={index}
                total={layout.order.length}
                onMove={(to) => change({ kind: "move", id, to })}
                onHide={() => change({ kind: "hide", id })}
                onResize={(height) => change({ kind: "resize", id, height })}
                indexAt={indexAt}
              />
            );
          })}
          {layout.order.length === 0 ? (
            <div className={styles.allHidden}>
              <p>Every widget is hidden.</p>
              <Button size="sm" onClick={() => change({ kind: "reset" })}>
                Show the defaults
              </Button>
            </div>
          ) : null}
        </div>
      </aside>
    </DashboardDataBoundary>
  );
}

/** The registered widgets, for palettes and the pane system's "add widget" menu. */
export const AVAILABLE_WIDGETS = WIDGETS.map(({ id, title, description }) => ({ id, title, description }));
