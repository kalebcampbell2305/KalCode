import type { HTMLAttributes } from "react";
import styles from "./Badge.module.css";
import { cx } from "./cx.ts";

export type BadgeTone = "neutral" | "accent" | "success" | "waiting" | "danger" | "outline";

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone;
}

export function Badge({ tone = "neutral", className, ...rest }: BadgeProps) {
  return <span className={cx(styles.badge, styles[tone], className)} {...rest} />;
}
