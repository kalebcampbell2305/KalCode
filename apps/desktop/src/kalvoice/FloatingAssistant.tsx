import type { PanelAnchor } from "@kalcode/protocol";
import { Button, IconButton } from "@kalcode/ui/components";
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
import { useNavigation } from "../shell/navigation.tsx";
import { announcement, STATE_LABELS, usageLine } from "./assistantState.ts";
import styles from "./FloatingAssistant.module.css";
import { useKalVoice } from "./KalVoiceProvider.tsx";
import { ANCHOR_LABELS, nudge, type Point, placementAt, positionFor, type Size } from "./panelGeometry.ts";
import { displayKey } from "./shortcutModel.ts";
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
/** An error collapses back to compact on its own after this long. */
const ERROR_SETTLE_MS = 12_000;

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
 * KalVoice's voice widget, floating over the workspace. Compact by default — the orb,
 * KALVOICE, and the state beside a status dot. It opens up on its own only when there is
 * something to show (the live transcript while you talk, a result, an approval, an error) and
 * settles back afterwards. Draggable within the window, docks to edges and corners, collapses
 * to the orb, and hides; the push-to-talk key brings it back.
 */
export function FloatingAssistant() {
  const kv = useKalVoice();
  const { state, panel, setPanel, setPanelVisible, levelRef, status } = kv;
  const { navigate } = useNavigation();
  const viewport = useViewport();
  const ref = useRef<HTMLElement | null>(null);
  const [size, setSize] = useState<Size>({ width: 240, height: 120 });
  const [drag, setDrag] = useState<Point | null>(null);
  const dragStart = useRef<{ pointer: Point; origin: Point; moved: boolean } | null>(null);
  const suppressClick = useRef(false);
  const holding = useRef(false);

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

  useEffect(() => {
    if (state.phase !== "error") return;
    const timer = setTimeout(kv.dismiss, ERROR_SETTLE_MS);
    return () => clearTimeout(timer);
  }, [state.phase, kv.dismiss]);

  if (!panel.visible || !status) return null;

  const resting = positionFor(panel, viewport, size);
  const position = drag ?? resting;
  const view = panel.view;
  const talkKey = displayKey(status.preferences.talkKey);
  const hint = status.preferences.talkEnabled
    ? `Hold ${talkKey} to talk to KalVoice.`
    : "Push to talk is off in Settings, KalVoice.";

  const onPointerDown = (event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0) return;
    // Events from portalled menus bubble through React but aren't inside the widget.
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

  const dragProps = { onPointerDown, onPointerMove, onPointerUp, onPointerCancel: onPointerUp };

  // Press and hold on the orb: the pointer alternative to the push-to-talk key.
  const holdStart = () => {
    if (holding.current || state.phase === "listening") return;
    holding.current = true;
    void kv.startListening();
  };
  const holdEnd = () => {
    if (!holding.current) return;
    holding.current = false;
    void kv.stopListening();
  };

  // At the top of the window the widget opens downwards; elsewhere upwards.
  const growsDown = panel.anchor.startsWith("top");
  const phase = state.phase;
  const listening = phase === "listening" || phase === "transcribing";
  const showsDetail = listening || phase === "done" || phase === "error" || phase === "waiting_for_permission";
  const fixAction =
    state.code === "needs_provider" ? (
      <Button size="sm" onClick={() => navigate("providers")}>
        Open Providers
      </Button>
    ) : state.code === "model_not_installed" || state.code === "speech_engine_unavailable" ? (
      <Button size="sm" onClick={() => navigate("settings")}>
        Set up speech
      </Button>
    ) : null;

  return (
    <section
      ref={ref}
      className={styles.panel}
      data-view={view}
      data-phase={phase}
      data-dragging={drag ? "true" : undefined}
      data-anchor={panel.anchor}
      aria-label="KalVoice widget"
      style={{ left: position.left, top: position.top }}
    >
      <p className="visually-hidden" role="status" aria-live="polite">
        {announcement(state)}
      </p>
      {view === "orb" ? (
        <button
          type="button"
          className={styles.orbOnly}
          aria-label={`Open the widget (${STATE_LABELS[phase]}). Arrow keys move it.`}
          title={hint}
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
          <Orb phase={phase} levelRef={levelRef} size={52} />
        </button>
      ) : (
        <div className={styles.body}>
          <div className={styles.card}>
            <header className={styles.header} {...dragProps}>
              <button
                type="button"
                className={styles.orbButton}
                data-no-drag
                aria-label="Hold to talk"
                title={`Hold to talk (or hold ${talkKey})`}
                onPointerDown={(e) => {
                  e.currentTarget.setPointerCapture(e.pointerId);
                  holdStart();
                }}
                onPointerUp={holdEnd}
                onPointerCancel={holdEnd}
                onKeyDown={(e) => {
                  if ((e.key === " " || e.key === "Enter") && !e.repeat) {
                    e.preventDefault();
                    holdStart();
                  }
                }}
                onKeyUp={(e) => {
                  if (e.key === " " || e.key === "Enter") holdEnd();
                }}
              >
                <Orb phase={phase} levelRef={levelRef} size={30} />
              </button>
              <button
                type="button"
                className={styles.handle}
                aria-label="Move the widget"
                title="Drag to move, or use the arrow keys"
                onKeyDown={onMoveKey}
              >
                <KalVoiceWordmark className={styles.wordmark} />
                <GripHorizontal className={styles.grip} aria-hidden="true" />
              </button>
              <p className={styles.state}>
                <span className={styles.dot} aria-hidden="true" />
                <span className={styles.stateName}>{STATE_LABELS[phase]}</span>
              </p>
              <div className={styles.controls} data-no-drag>
                <IconButton
                  size="sm"
                  label={view === "expanded" ? "Show less" : "Show more"}
                  icon={(view === "expanded") === growsDown ? <ChevronUp /> : <ChevronDown />}
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
                    <IconButton size="sm" label="Dock the widget" icon={<PanelsTopLeft />} />
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
                  label={`Hide the widget (${talkKey} still works)`}
                  icon={<X />}
                  onClick={() => setPanelVisible(false)}
                />
              </div>
            </header>

            {showsDetail ? (
              <div className={styles.detail}>
                {listening ? (
                  <>
                    <Waveform phase={phase} levelRef={levelRef} />
                    <p className={styles.transcript} data-empty={state.partial ? undefined : "true"}>
                      {state.partial ?? (phase === "listening" ? "Listening…" : "")}
                    </p>
                  </>
                ) : null}
                {phase === "done" && state.message ? (
                  <div className={styles.result}>
                    <p className={styles.message}>{state.message}</p>
                    {kv.canTypeInstead ? (
                      <Button size="sm" variant="ghost" onClick={() => void kv.typeInstead()}>
                        Type it instead
                      </Button>
                    ) : null}
                  </div>
                ) : null}
                {phase === "waiting_for_permission" ? (
                  <div className={styles.result}>
                    {state.lastTalk?.text ? <p className={styles.transcript}>“{state.lastTalk.text}”</p> : null}
                    <p className={styles.message}>{state.message}</p>
                    <div className={styles.actions}>
                      <Button size="sm" variant="ghost" onClick={() => void kv.decideApproval("deny")}>
                        Deny
                      </Button>
                      <Button size="sm" variant="primary" onClick={() => void kv.decideApproval("approve_once")}>
                        Approve once
                      </Button>
                    </div>
                  </div>
                ) : null}
                {phase === "error" && state.message ? (
                  <div className={styles.result}>
                    <p className={styles.message}>{state.message}</p>
                    <div className={styles.actions}>
                      {fixAction}
                      <Button size="sm" variant="ghost" onClick={kv.dismiss}>
                        Dismiss
                      </Button>
                    </div>
                  </div>
                ) : null}
              </div>
            ) : null}

            {view === "expanded" ? (
              <div className={styles.more}>
                <p className={styles.hint}>{hint}</p>
                {phase === "idle" && state.message ? <p className={styles.message}>{state.message}</p> : null}
                <p className={styles.usage}>
                  {usageLine(status.usage)}
                  <span> · dictation is never counted</span>
                </p>
              </div>
            ) : null}
          </div>
        </div>
      )}
    </section>
  );
}
