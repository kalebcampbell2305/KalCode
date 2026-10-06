import type { CSSProperties, MutableRefObject } from "react";
import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import kalvoiceWordmarkUrl from "../assets/brand/kalvoice-wordmark.png";
import { KalVoiceMark } from "../shell/Brand.tsx";
import type { AssistantPhase } from "./assistantState.ts";
import styles from "./Visuals.module.css";
import { motionReduced, VOICE_ROUTE_EVENT, type VoiceRouteDetail } from "./voiceRoute.ts";

/** "KALVOICE" lettering from the KalVoice board, tinted with the current text color. */
export function KalVoiceWordmark({ className }: { className?: string }) {
  return (
    <span
      role="img"
      aria-label="KalVoice"
      className={[styles.wordmark, className].filter(Boolean).join(" ")}
      style={{ "--wordmark-url": `url("${kalvoiceWordmarkUrl}")` } as CSSProperties}
    />
  );
}

/**
 * Follows the live microphone level while listening by writing a CSS variable every frame
 * (no React re-render). Outside listening the variable rests at 0.
 */
function useLevelVariable(
  ref: MutableRefObject<HTMLElement | null>,
  levelRef: MutableRefObject<number>,
  live: boolean,
) {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (!live) {
      el.style.setProperty("--level", "0");
      return;
    }
    let frame = 0;
    let smoothed = 0;
    const tick = () => {
      smoothed += (levelRef.current - smoothed) * 0.35;
      el.style.setProperty("--level", smoothed.toFixed(3));
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [ref, levelRef, live]);
}

interface OrbProps {
  phase: AssistantPhase;
  levelRef: MutableRefObject<number>;
  size: number;
}

/** The KalVoice orb with state-driven light. Decorative; state is announced separately. */
export function Orb({ phase, levelRef, size }: OrbProps) {
  const ref = useRef<HTMLSpanElement | null>(null);
  useLevelVariable(ref, levelRef, phase === "listening");
  return (
    <span
      ref={ref}
      className={styles.orb}
      data-phase={phase}
      data-voice-orb=""
      style={{ "--orb-size": `${size}px` } as CSSProperties}
    >
      <span className={styles.halo} aria-hidden="true" />
      <span className={styles.ring} aria-hidden="true" />
      <KalVoiceMark size={size} className={styles.mark} />
    </span>
  );
}

const BARS = 28;

interface WaveformProps {
  phase: AssistantPhase;
  levelRef: MutableRefObject<number>;
}

/**
 * While listening, each bar is a recent microphone level (newest on the right), sampled from
 * the live level the native capture reports. Other states show a quiet, state-specific pattern.
 */
export function Waveform({ phase, levelRef }: WaveformProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  const live = phase === "listening";

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const bars = Array.from(el.children) as HTMLElement[];
    if (!live) {
      for (const bar of bars) bar.style.removeProperty("--bar");
      return;
    }
    const history = new Array<number>(BARS).fill(0);
    let frame = 0;
    let last = 0;
    const tick = (now: number) => {
      if (now - last >= 50) {
        last = now;
        history.shift();
        history.push(levelRef.current);
        history.forEach((level, i) => {
          bars[i]?.style.setProperty("--bar", Math.max(0.06, level).toFixed(3));
        });
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [live, levelRef]);

  return (
    <div ref={ref} className={styles.wave} data-phase={phase} aria-hidden="true">
      {Array.from({ length: BARS }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: fixed, positional bars.
        <span key={i} className={styles.bar} style={{ "--i": i } as CSSProperties} />
      ))}
    </div>
  );
}

const COMET_MS = 280;

/**
 * The routing comet: when a voice command lands somewhere (voiceRoute.ts), a short electric streak
 * travels from this widget's orb to the destination. One element, one Web Animation of transform
 * and opacity; nothing runs between routes. Skipped under reduced motion (the destination still
 * lights). `origin` is the widget that owns the orb.
 */
export function VoiceRoute({ origin }: { origin: MutableRefObject<HTMLElement | null> }) {
  const comet = useRef<HTMLSpanElement | null>(null);
  useEffect(() => {
    const onRoute = (event: Event) => {
      const el = comet.current;
      const from = origin.current?.querySelector("[data-voice-orb]") ?? origin.current;
      if (!el || !from || motionReduced()) return;
      const { to } = (event as CustomEvent<VoiceRouteDetail>).detail;
      const a = from.getBoundingClientRect();
      if (a.width === 0) return;
      const x0 = a.left + a.width / 2;
      const y0 = a.top + a.height / 2;
      const x1 = to.x + to.width / 2;
      const y1 = to.y + Math.min(to.height / 2, 28);
      const angle = Math.atan2(y1 - y0, x1 - x0);
      const at = (x: number, y: number, scale: number) =>
        `translate(${x}px, ${y}px) rotate(${angle}rad) scaleX(${scale})`;
      for (const animation of el.getAnimations()) animation.cancel();
      el.animate(
        [
          { transform: at(x0, y0, 0.3), opacity: 0 },
          { transform: at(x0 + (x1 - x0) * 0.35, y0 + (y1 - y0) * 0.35, 1), opacity: 1, offset: 0.35 },
          { transform: at(x1, y1, 0.4), opacity: 0 },
        ],
        { duration: COMET_MS, easing: "cubic-bezier(0.22, 1, 0.36, 1)" },
      );
    };
    window.addEventListener(VOICE_ROUTE_EVENT, onRoute);
    return () => window.removeEventListener(VOICE_ROUTE_EVENT, onRoute);
  }, [origin]);
  return typeof document === "undefined"
    ? null
    : createPortal(<span ref={comet} className={styles.comet} aria-hidden="true" />, document.body);
}
