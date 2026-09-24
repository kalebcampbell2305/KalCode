import type { ReactNode } from "react";
import { cx } from "./cx.ts";
import styles from "./StatusIndicator.module.css";

export type StatusTone = "live" | "success" | "waiting" | "danger" | "idle";

export interface StatusIndicatorProps {
  tone: StatusTone;
  /** Visible label. Status is never conveyed by color alone. */
  children: ReactNode;
  /** Animated halo for states that are actively changing. */
  pulse?: boolean;
  className?: string;
}

export function StatusIndicator({ tone, children, pulse = false, className }: StatusIndicatorProps) {
  return (
    <span className={cx(styles.root, className)}>
      <span className={cx(styles.dot, styles[tone], pulse && styles.pulse)} aria-hidden="true" />
      <span>{children}</span>
    </span>
  );
}
