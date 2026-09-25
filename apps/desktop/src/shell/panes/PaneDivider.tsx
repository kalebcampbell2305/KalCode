import type { PaneLayout } from "@kalcode/protocol";
import { type KeyboardEvent, type PointerEvent, useRef } from "react";
import { beginLiveResize } from "./liveResize.ts";
import { type Divider, type Rect, resizeDivider } from "./model.ts";
import styles from "./PaneCanvas.module.css";

/** Keyboard steps, in pixels. */
const STEP = 24;
const BIG_STEP = 96;

interface PaneDividerProps {
  divider: Divider;
  layout: PaneLayout;
  /** Titles of the panes on each side, for the accessible name. */
  before: string;
  after: string;
  controls: string;
  onResize: (next: PaneLayout) => void;
  onEven: () => void;
  onFocus: () => void;
}

function percentOfFirst(divider: Divider): number {
  const a = divider.sizes[divider.index] ?? 0;
  const b = divider.sizes[divider.index + 1] ?? 0;
  return a + b > 0 ? Math.round((a / (a + b)) * 100) : 50;
}

/**
 * The divider between two panes: a WAI-ARIA window splitter. Drag with the pointer, or focus it
 * and use the arrow keys (Shift for bigger steps; Alt+arrows work too), Home / End for the
 * smallest / largest size, Enter to even the two panes out.
 */
export function PaneDivider({ divider, layout, before, after, controls, onResize, onEven, onFocus }: PaneDividerProps) {
  const drag = useRef<{ start: number; layout: PaneLayout; divider: Divider; end: () => void; frame: number } | null>(
    null,
  );
  const horizontal = divider.axis === "horizontal";
  const rect: Rect = divider.rect;
  const fixed = divider.fixed[divider.index] || divider.fixed[divider.index + 1];

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || fixed) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    event.currentTarget.focus({ preventScroll: true });
    drag.current = {
      start: horizontal ? event.clientX : event.clientY,
      layout,
      divider,
      end: beginLiveResize(),
      frame: 0,
    };
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    if (!current) return;
    const delta = (horizontal ? event.clientX : event.clientY) - current.start;
    cancelAnimationFrame(current.frame);
    current.frame = requestAnimationFrame(() => onResize(resizeDivider(current.layout, current.divider, delta)));
  };

  const endDrag = (event: PointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    if (!current) return;
    drag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    // Let the last frame's size land before terminals re-fit.
    requestAnimationFrame(() => current.end());
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (fixed) return;
    const back = horizontal ? "ArrowLeft" : "ArrowUp";
    const forward = horizontal ? "ArrowRight" : "ArrowDown";
    const step = event.shiftKey ? BIG_STEP : STEP;
    let delta: number | null = null;
    if (event.key === back) delta = -step;
    else if (event.key === forward) delta = step;
    else if (event.key === "Home") delta = -100_000;
    else if (event.key === "End") delta = 100_000;
    else if (event.key === "Enter") {
      event.preventDefault();
      onEven();
      return;
    }
    if (delta === null || event.ctrlKey || event.metaKey) return;
    event.preventDefault();
    event.stopPropagation();
    onResize(resizeDivider(layout, divider, delta));
  };

  return (
    // biome-ignore lint/a11y/useSemanticElements: a focusable window splitter (separator role with a value) has no native element.
    <div
      role="separator"
      tabIndex={0}
      aria-orientation={horizontal ? "vertical" : "horizontal"}
      aria-label={`Resize ${before} and ${after}`}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percentOfFirst(divider)}
      aria-valuetext={`${before} ${percentOfFirst(divider)}%, ${after} ${100 - percentOfFirst(divider)}%`}
      aria-controls={controls}
      aria-disabled={fixed || undefined}
      className={styles.divider}
      data-axis={divider.axis}
      style={{ left: rect.x, top: rect.y, width: rect.width, height: rect.height }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onDoubleClick={onEven}
      onKeyDown={onKeyDown}
      onFocus={onFocus}
    >
      <span className={styles.dividerLine} aria-hidden="true" />
    </div>
  );
}
