import type { CSSProperties } from "react";
import jarvisTaglineUrl from "../assets/brand/jarvis-tagline.png";
import jarvisWordmarkUrl from "../assets/brand/jarvis-wordmark.png";
import mark64Url from "../assets/brand/kalcode-mark-64.png";
import mark128Url from "../assets/brand/kalcode-mark-128.png";
import kalcodeTaglineUrl from "../assets/brand/kalcode-tagline.png";
import kalcodeWordmarkUrl from "../assets/brand/kalcode-wordmark.png";
import styles from "./Brand.module.css";

/*
 * All brand imagery comes from the owner's artwork (packages/ui/src/brand/masters), derived by
 * tooling/generate-brand-assets.py. Lettering is the artwork's own pixels used as an alpha
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
  return <Lettering url={kalcodeWordmarkUrl} label="KalCode" ratio="899 / 82" className={className} />;
}

/** "Code a brighter tomorrow", from the brand artwork. */
export function KalCodeTagline({ className }: LetteringProps) {
  return <Lettering url={kalcodeTaglineUrl} label="Code a brighter tomorrow" ratio="658 / 30" className={className} />;
}

export function JarvisWordmark({ className }: LetteringProps) {
  return <Lettering url={jarvisWordmarkUrl} label="JARVIS" ratio="781 / 83" className={className} />;
}

export function JarvisTagline({ className }: LetteringProps) {
  return (
    <Lettering
      url={jarvisTaglineUrl}
      label="Global thinking. Personal impact."
      ratio="766 / 29"
      className={className}
    />
  );
}

/** The constellation globe from the brand artwork, cut to a circle. `size` in CSS px. */
export function Mark({ size = 28, className }: { size?: number; className?: string }) {
  return (
    <img
      src={size <= 32 ? mark64Url : mark128Url}
      width={size}
      height={size}
      alt=""
      className={className}
      draggable={false}
    />
  );
}
