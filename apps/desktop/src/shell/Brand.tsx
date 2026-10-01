import type { CSSProperties } from "react";
import mark64Url from "../assets/brand/kalcode-mark-64.png";
import mark128Url from "../assets/brand/kalcode-mark-128.png";
import mark256Url from "../assets/brand/kalcode-mark-256.png";
import kalcodeTaglineUrl from "../assets/brand/kalcode-tagline.png";
import kalcodeWordmarkUrl from "../assets/brand/kalcode-wordmark.png";
import voiceMark64Url from "../assets/brand/kalvoice-mark-64.png";
import voiceMark128Url from "../assets/brand/kalvoice-mark-128.png";
import voiceMark256Url from "../assets/brand/kalvoice-mark-256.png";
import styles from "./Brand.module.css";

/*
 * All brand imagery comes from the owner's brand artwork (packages/ui/src/brand/masters), derived
 * by tooling/generate-brand-assets.py. The KalCode mark is the mascot on its app-icon tile, so it
 * reads the same in light and dark themes. Lettering is the artwork's own pixels used as an alpha
 * mask, so it takes the current text color in light and dark themes.
 */

interface LetteringProps {
  className?: string;
}

function Lettering({ url, label, ratio, className }: LetteringProps & { url: string; label: string; ratio: string }) {
  return (
    <span
      role="img"
      aria-label={label}
      className={[styles.lettering, className].filter(Boolean).join(" ")}
      style={{ "--lettering-url": `url("${url}")`, aspectRatio: ratio } as CSSProperties}
    />
  );
}

/** The KALCODE wordmark from the brand artwork. */
export function Wordmark({ className }: LetteringProps) {
  return <Lettering url={kalcodeWordmarkUrl} label="KalCode" ratio="687 / 69" className={className} />;
}

/** "One intelligence. A brighter tomorrow.", from the KalCode board. */
export function KalCodeTagline({ className }: LetteringProps) {
  return (
    <Lettering
      url={kalcodeTaglineUrl}
      label="One intelligence. A brighter tomorrow."
      ratio="645 / 21"
      className={className}
    />
  );
}

function markSource(size: number, urls: readonly [string, string, string]): string {
  // Sources are 2x the largest CSS size they serve, so marks stay sharp on high-DPI displays.
  if (size <= 32) return urls[0];
  if (size <= 64) return urls[1];
  return urls[2];
}

interface MarkProps {
  /** CSS px. */
  size?: number;
  className?: string;
}

/** The KalCode mark: the mascot on its app-icon tile. Decorative. */
export function Mark({ size = 28, className }: MarkProps) {
  return (
    <img
      src={markSource(size, [mark64Url, mark128Url, mark256Url])}
      width={size}
      height={size}
      alt=""
      className={className}
      draggable={false}
    />
  );
}

/** The KalVoice orb isolated from the KalVoice board. Decorative. */
export function KalVoiceMark({ size = 28, className }: MarkProps) {
  return (
    <img
      src={markSource(size, [voiceMark64Url, voiceMark128Url, voiceMark256Url])}
      width={size}
      height={size}
      alt=""
      className={className}
      draggable={false}
    />
  );
}

/** Symbol and wordmark side by side, for standalone screens (startup, errors). */
export function Lockup({ className }: { className?: string }) {
  return (
    <span className={[styles.lockup, className].filter(Boolean).join(" ")}>
      <Mark size={36} />
      <Wordmark className={styles.lockupWordmark} />
    </span>
  );
}
