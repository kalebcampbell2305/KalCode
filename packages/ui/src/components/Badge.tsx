import type { HTMLAttributes } from "react";
import styles from "./Badge.module.css";
import { cx } from "./cx.ts";

/**
 * neutral · accent · success (green) · waiting (neutral, emphasized: needs you) ·
 * paused (amber: the only amber) · danger (red) · outline (quiet hairline).
 */
export type BadgeTone = "neutral" | "accent" | "success" | "waiting" | "paused" | "danger" | "outline";

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone;
}

export function Badge({ tone = "neutral", className, ...rest }: BadgeProps) {
  return <span className={cx(styles.badge, styles[tone], className)} {...rest} />;
}
