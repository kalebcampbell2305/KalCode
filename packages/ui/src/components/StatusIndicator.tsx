import type { StatusTone as DisplayTone } from "@kalcode/protocol";
import type { ReactNode } from "react";
import { cx } from "./cx.ts";
import styles from "./StatusIndicator.module.css";

/** Pre-Z7 tones, kept for existing call sites. */
export type LegacyStatusTone = "live" | "success" | "waiting" | "danger" | "idle";

/**
 * Either a contract tone (`working`, `waiting`, `muted`, `done`, `failed`, `paused`,
 * `recovering`) or a legacy tone. Legacy tones map onto the contract palette:
 * live → recovering blue, success → working green, waiting → neutral waiting (amber is reserved
 * for paused), danger → failed red, idle → muted.
 */
export type StatusTone = LegacyStatusTone | DisplayTone;

export interface StatusIndicatorProps {
  tone: StatusTone;
  /** Visible label. Status is never conveyed by color alone. */
  children: ReactNode;
  /** Soft breathing halo for states that are actively changing. */
  pulse?: boolean;
  className?: string;
}

/** A dot plus words: the lightest status form, for key/value lists and runtime health. */
export function StatusIndicator({ tone, children, pulse = false, className }: StatusIndicatorProps) {
  return (
    <span className={cx(styles.root, className)} data-tone={tone}>
      <span className={cx(styles.dot, pulse && styles.pulse)} aria-hidden="true" />
      <span>{children}</span>
    </span>
  );
}
