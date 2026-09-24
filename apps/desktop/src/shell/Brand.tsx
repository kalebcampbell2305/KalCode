import markUrl from "@kalcode/ui/brand/mark.svg?url";
import markSmallUrl from "@kalcode/ui/brand/mark-small.svg?url";
import wordmarkUrl from "@kalcode/ui/brand/wordmark.svg?url";
import type { CSSProperties } from "react";
import styles from "./Brand.module.css";

/** The KALCODE wordmark. Rendered as a mask so it takes the current text color in any theme. */
export function Wordmark({ className }: { className?: string }) {
  return (
    <span
      role="img"
      aria-label="KalCode"
      className={[styles.wordmark, className].filter(Boolean).join(" ")}
      style={{ "--wordmark-url": `url("${wordmarkUrl}")` } as CSSProperties}
    />
  );
}

/** The constellation-globe mark. `size` in px; ≤ 32px uses the simplified variant. */
export function Mark({ size = 28, className }: { size?: number; className?: string }) {
  return (
    <img
      src={size <= 32 ? markSmallUrl : markUrl}
      width={size}
      height={size}
      alt=""
      className={className}
      draggable={false}
    />
  );
}
