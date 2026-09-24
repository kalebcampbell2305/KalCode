import type { PanelAnchor } from "@kalcode/protocol";
import { IconButton } from "@kalcode/ui/components";
import { ChevronDown, ChevronUp, Circle, GripHorizontal, PanelsTopLeft, X } from "lucide-react";
import { DropdownMenu } from "radix-ui";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { IS_MAC } from "../shell/shortcuts.ts";
import { RequestForm, ResultView, ShortcutHint, UsageFooter } from "./Assistant.tsx";
import { announcement, PHASE_NAMES, stateLine } from "./assistantState.ts";
import styles from "./FloatingAssistant.module.css";
import { useKalVoice } from "./KalVoiceProvider.tsx";
import { ANCHOR_LABELS, nudge, type Point, placementAt, positionFor, type Size } from "./panelGeometry.ts";
import { displayShortcut } from "./shortcutModel.ts";
import { KalVoiceWordmark, Orb, Waveform } from "./Visuals.tsx";

const DOCK_CHOICES: PanelAnchor[] = [
  "top_left",
  "top",
  "top_right",
  "left",
  "right",
  "bottom_left",
  "bottom",
  "bottom_right",
];

const DRAG_THRESHOLD = 4;

function useViewport(): Size {
  const [size, setSize] = useState<Size>(() => ({ width: window.innerWidth, height: window.innerHeight }));
  useEffect(() => {
    const onResize = () => setSize({ width: window.innerWidth, height: window.innerHeight });
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return size;
}

/**
 * KalVoice as a compact floating assistant over the workspace: the orb above a small panel
 * (KALVOICE, a state line, a waveform). Draggable within the window and clamped to it; docks to
 * edges and corners; minimizes, collapses to the orb, expands, and closes (the command shortcut
 * reopens it). Placement and view are remembered per window size class.
 */
export function FloatingAssistant() {
  const kv = useKalVoice();
  const { state, panel, setPanel, setPanelVisible, levelRef, status, focusToken } = kv;
  const viewport = useViewport();
  const ref = useRef<HTMLElement | null>(null);
  const [size, setSize] = useState<Size>({ width: 280, height: 160 });
  const [drag, setDrag] = useState<Point | null>(null);
  const dragStart = useRef<{ pointer: Point; origin: Point; moved: boolean } | null>(null);
  const suppressClick = useRef(false);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () =>
      setSize((prev) =>
        prev.width === el.offsetWidth && prev.height === el.offsetHeight
          ? prev
          : { width: el.offsetWidth, height: el.offsetHeight },
      );
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  });

  if (!panel.visible || !status) return null;

  const resting = positionFor(panel, viewport, size);
  const position = drag ?? resting;
  const view = panel.view;
  const commandKeys = displayShortcut(status.preferences.commandShortcut, IS_MAC);
  // The compact panel has no result area, so it shows a result's message on its state line.
  const stateText =
    view !== "expanded" && (state.phase === "error" || state.phase === "done") && state.message
      ? state.message
      : stateLine(state);

  const onPointerDown = (event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0) return;
    // Controls inside the handle keep their own behaviour.
    // (Events from portalled menus bubble through React but aren't inside the panel.)
    const target = event.target as HTMLElement;
    if (!event.currentTarget.contains(target) || target.closest("[data-no-drag]")) return;
    dragStart.current = { pointer: { left: event.clientX, top: event.clientY }, origin: resting, moved: false };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLElement>) => {
    const start = dragStart.current;
    if (!start) return;
    const dx = event.clientX - start.pointer.left;
    const dy = event.clientY - start.pointer.top;
    if (!start.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
    start.moved = true;
    const maxLeft = Math.max(16, viewport.width - size.width - 16);
    const maxTop = Math.max(16, viewport.height - size.height - 16);
    setDrag({
      left: Math.min(maxLeft, Math.max(16, start.origin.left + dx)),
      top: Math.min(maxTop, Math.max(16, start.origin.top + dy)),
    });
  };

  const onPointerUp = (event: ReactPointerEvent<HTMLElement>) => {
    const start = dragStart.current;
    dragStart.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (!start?.moved || !drag) {
      setDrag(null);
      return;
    }
    suppressClick.current = true;
    setPanel(placementAt(drag, viewport, size));
    setDrag(null);
  };

  const onMoveKey = (event: ReactKeyboardEvent<HTMLElement>) => {
    const step = event.shiftKey ? 64 : 16;
    const delta: Record<string, [number, number]> = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, -step],
      ArrowDown: [0, step],
    };
    const d = delta[event.key];
    if (!d) return;
    event.preventDefault();
    setPanel(nudge(panel, d[0], d[1], viewport, size));
  };

  const dragProps = {
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onPointerCancel: onPointerUp,
  };

  const live = (
    <p className="visually-hidden" role="status" aria-live="polite">
      {announcement(state)}
    </p>
  );

  return (
    <section
      ref={ref}
      className={styles.panel}
      data-view={view}
      data-phase={state.phase}
      data-dragging={drag ? "true" : undefined}
      data-anchor={panel.anchor}
      aria-label="KalVoice assistant"
      style={{ left: position.left, top: position.top }}
    >
      {live}
      {view === "orb" ? (
        <button
          type="button"
          className={styles.orbOnly}
          aria-label={`Open the assistant (${stateLine(state)}). Arrow keys move it.`}
          onClick={() => {
            if (suppressClick.current) {
              suppressClick.current = false;
              return;
            }
            setPanel({ view: "compact" });
          }}
          onKeyDown={onMoveKey}
          {...dragProps}
        >
          <Orb phase={state.phase} levelRef={levelRef} size={56} />
        </button>
      ) : (
        <>
          <div className={styles.orbSeat} aria-hidden="true" {...dragProps}>
            <Orb phase={state.phase} levelRef={levelRef} size={64} />
          </div>
          <div className={styles.card}>
            <header className={styles.header} {...dragProps}>
              <button
                type="button"
                className={styles.handle}
                aria-label="Move the assistant"
                title="Drag to move, or use the arrow keys"
                onKeyDown={onMoveKey}
              >
                <KalVoiceWordmark className={styles.wordmark} />
                <GripHorizontal className={styles.grip} aria-hidden="true" />
              </button>
              <div className={styles.controls} data-no-drag>
                <IconButton
                  size="sm"
                  label={view === "expanded" ? "Minimize the assistant" : "Expand the assistant"}
                  icon={view === "expanded" ? <ChevronDown /> : <ChevronUp />}
                  onClick={() => setPanel({ view: view === "expanded" ? "compact" : "expanded" })}
                />
                <IconButton
                  size="sm"
                  label="Collapse to the orb"
                  icon={<Circle />}
                  onClick={() => setPanel({ view: "orb" })}
                />
                <DropdownMenu.Root>
                  <DropdownMenu.Trigger asChild>
                    <IconButton size="sm" label="Dock the assistant" icon={<PanelsTopLeft />} />
                  </DropdownMenu.Trigger>
                  <DropdownMenu.Portal>
                    <DropdownMenu.Content className={styles.menu} sideOffset={6} align="end">
                      <DropdownMenu.Label className={styles.menuLabel}>Dock to</DropdownMenu.Label>
                      <DropdownMenu.RadioGroup
                        value={panel.anchor}
                        onValueChange={(anchor) => setPanel({ anchor: anchor as PanelAnchor })}
                      >
                        {DOCK_CHOICES.map((anchor) => (
                          <DropdownMenu.RadioItem key={anchor} value={anchor} className={styles.menuItem}>
                            {ANCHOR_LABELS[anchor]}
                          </DropdownMenu.RadioItem>
                        ))}
                      </DropdownMenu.RadioGroup>
                    </DropdownMenu.Content>
                  </DropdownMenu.Portal>
                </DropdownMenu.Root>
                <IconButton
                  size="sm"
                  label={`Close the assistant (reopen with ${commandKeys})`}
                  icon={<X />}
                  onClick={() => setPanelVisible(false)}
                />
              </div>
            </header>
            <p className={styles.stateLine}>
              <span className={styles.phaseName}>{PHASE_NAMES[state.phase]}</span>
              <span className={styles.stateText} title={stateText}>
                {stateText}
              </span>
            </p>
            <Waveform phase={state.phase} levelRef={levelRef} />
            {view === "expanded" ? (
              <div className={styles.body}>
                <RequestForm id="kalvoice-panel-request" autoFocusToken={focusToken} />
                <ResultView />
                <UsageFooter />
                <ShortcutHint />
              </div>
            ) : null}
          </div>
        </>
      )}
    </section>
  );
}
