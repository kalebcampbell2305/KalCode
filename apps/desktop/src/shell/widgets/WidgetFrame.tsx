import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  IconButton,
  Panel,
} from "@kalcode/ui/components";
import { GripVertical, MoreHorizontal } from "lucide-react";
import { type KeyboardEvent, type PointerEvent, useEffect, useRef, useState } from "react";
import { HEIGHT_STEP, MAX_WIDGET_HEIGHT, MIN_WIDGET_HEIGHT } from "./layout.ts";
import type { WidgetDefinition } from "./registry.tsx";
import styles from "./WidgetDock.module.css";

const SIZES: readonly { label: string; height: number }[] = [
  { label: "Small", height: 180 },
  { label: "Medium", height: 300 },
  { label: "Large", height: 480 },
];

function useNoCount(): number | null {
  return null;
}

export interface WidgetFrameProps {
  widget: WidgetDefinition;
  height: number;
  index: number;
  total: number;
  onMove: (to: number) => void;
  onHide: () => void;
  onResize: (height: number) => void;
  /** Drag reorder: returns the index under the pointer. */
  indexAt: (clientY: number) => number;
}

/**
 * One docked widget: a framed panel with a compact header (title, count, move handle, menu) and a
 * resizable body. Everything is keyboard-operable: the handle moves the widget with the arrow
 * keys, the menu moves, sizes and hides it, and the bottom edge resizes it with the arrow keys.
 */
export function WidgetFrame({ widget, height, index, total, onMove, onHide, onResize, indexAt }: WidgetFrameProps) {
  const useCount = widget.useCount ?? useNoCount;
  const count = useCount();
  const Body = widget.Body;
  const Icon = widget.icon;
  const [dragging, setDragging] = useState(false);
  const dragActive = useRef(false);
  const [resizing, setResizing] = useState(false);
  const resizeStart = useRef<{ y: number; height: number } | null>(null);
  const handleId = `${widget.anchor}-move-hint`;
  const handleRef = useRef<HTMLButtonElement>(null);
  // Moving reorders the DOM, which can drop focus; keyboard moves keep it on the handle.
  const keepFocus = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `index` changing is the trigger.
  useEffect(() => {
    if (!keepFocus.current) return;
    keepFocus.current = false;
    handleRef.current?.focus();
  }, [index]);

  const onHandleKey = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "ArrowUp" && index > 0) {
      event.preventDefault();
      keepFocus.current = true;
      onMove(index - 1);
    } else if (event.key === "ArrowDown" && index < total - 1) {
      event.preventDefault();
      keepFocus.current = true;
      onMove(index + 1);
    }
  };

  const onHandleDown = (event: PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragActive.current = true;
    setDragging(true);
  };
  const onHandleMove = (event: PointerEvent<HTMLButtonElement>) => {
    if (!dragActive.current) return;
    const target = indexAt(event.clientY);
    if (target !== index) onMove(target);
  };
  const onHandleUp = (event: PointerEvent<HTMLButtonElement>) => {
    // Capture loss and the following pointer move can arrive before React commits state.
    dragActive.current = false;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    setDragging(false);
  };

  const onResizeKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? HEIGHT_STEP * 4 : HEIGHT_STEP;
    if (event.key === "ArrowUp") onResize(height - step);
    else if (event.key === "ArrowDown") onResize(height + step);
    else if (event.key === "Home") onResize(MIN_WIDGET_HEIGHT);
    else if (event.key === "End") onResize(MAX_WIDGET_HEIGHT);
    else return;
    event.preventDefault();
  };
  const onResizeDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    resizeStart.current = { y: event.clientY, height };
    setResizing(true);
  };
  const onResizeMove = (event: PointerEvent<HTMLDivElement>) => {
    const start = resizeStart.current;
    if (!start) return;
    onResize(start.height + (event.clientY - start.y));
  };
  const onResizeUp = (event: PointerEvent<HTMLDivElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    resizeStart.current = null;
    setResizing(false);
  };

  return (
    <Panel
      id={widget.anchor}
      title={widget.title}
      icon={<Icon />}
      count={count ?? undefined}
      countTone={widget.countTone}
      padding="sm"
      className={styles.frame}
      data-widget-id={widget.id}
      data-dragging={dragging || undefined}
      data-resizing={resizing || undefined}
      actions={
        <div className={styles.frameActions}>
          <span id={handleId} className="visually-hidden">
            Use the up and down arrow keys to move this widget.
          </span>
          <button
            ref={handleRef}
            type="button"
            className={styles.handle}
            aria-label={`Move ${widget.title}`}
            aria-describedby={handleId}
            onKeyDown={onHandleKey}
            onPointerDown={onHandleDown}
            onPointerMove={onHandleMove}
            onPointerUp={onHandleUp}
            onPointerCancel={onHandleUp}
            onLostPointerCapture={onHandleUp}
          >
            <GripVertical aria-hidden="true" />
          </button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <IconButton size="sm" label={`${widget.title} options`} icon={<MoreHorizontal />} />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem disabled={index === 0} onSelect={() => onMove(index - 1)}>
                Move up
              </DropdownMenuItem>
              <DropdownMenuItem disabled={index >= total - 1} onSelect={() => onMove(index + 1)}>
                Move down
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuLabel>Height</DropdownMenuLabel>
              {SIZES.map((size) => (
                <DropdownMenuItem key={size.label} onSelect={() => onResize(size.height)}>
                  {size.label}
                </DropdownMenuItem>
              ))}
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={onHide}>Hide widget</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      }
    >
      {/* Focusable so its scrolling content is reachable from the keyboard. */}
      {/* biome-ignore lint/a11y/noNoninteractiveTabindex: a scroll container must take focus to scroll by keyboard. */}
      <div className={styles.body} style={{ maxHeight: height }} tabIndex={0}>
        <Body />
      </div>
      {/* biome-ignore lint/a11y/useSemanticElements: a focusable splitter is the ARIA window-splitter pattern; <hr> can't take focus. */}
      <div
        role="separator"
        tabIndex={0}
        aria-orientation="horizontal"
        aria-label={`Resize ${widget.title}`}
        aria-valuemin={MIN_WIDGET_HEIGHT}
        aria-valuemax={MAX_WIDGET_HEIGHT}
        aria-valuenow={height}
        className={styles.resize}
        onKeyDown={onResizeKey}
        onPointerDown={onResizeDown}
        onPointerMove={onResizeMove}
        onPointerUp={onResizeUp}
        onPointerCancel={onResizeUp}
        onLostPointerCapture={onResizeUp}
      />
    </Panel>
  );
}
