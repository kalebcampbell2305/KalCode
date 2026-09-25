import type { CSSProperties, MutableRefObject } from "react";
import { useEffect, useRef } from "react";
import kalvoiceWordmarkUrl from "../assets/brand/kalvoice-wordmark.png";
import { KalVoiceMark } from "../shell/Brand.tsx";
import type { AssistantPhase } from "./assistantState.ts";
import styles from "./Visuals.module.css";

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
    <span ref={ref} className={styles.orb} data-phase={phase} style={{ "--orb-size": `${size}px` } as CSSProperties}>
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
