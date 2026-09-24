import { RadioGroup } from "radix-ui";
import type { ReactNode } from "react";
import { cx } from "./cx.ts";
import styles from "./SegmentedControl.module.css";

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
  icon?: ReactNode;
}

export interface SegmentedControlProps<T extends string> {
  value: T;
  options: readonly SegmentedOption<T>[];
  onValueChange: (value: T) => void;
  "aria-labelledby"?: string;
  "aria-label"?: string;
  disabled?: boolean;
  className?: string;
}

const ARROW_KEYS = new Set(["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"]);

/**
 * A single-choice control with radio-group semantics. Per the WAI-ARIA radio group pattern,
 * arrow keys move focus and select the newly focused option.
 */
export function SegmentedControl<T extends string>({
  value,
  options,
  onValueChange,
  disabled,
  className,
  ...aria
}: SegmentedControlProps<T>) {
  return (
    <RadioGroup.Root
      className={cx(styles.root, className)}
      value={value}
      onValueChange={(next) => onValueChange(next as T)}
      orientation="horizontal"
      loop
      disabled={disabled}
      onKeyDown={(event) => {
        if (!ARROW_KEYS.has(event.key)) return;
        // Radix moves focus in a zero-delay timeout scheduled by the item's handler, which runs
        // before this bubbled handler; a timeout here therefore observes the new focus.
        setTimeout(() => {
          const focused = document.activeElement;
          const next = focused?.getAttribute("role") === "radio" ? focused.getAttribute("value") : null;
          if (next && next !== value && options.some((option) => option.value === next)) onValueChange(next as T);
        }, 0);
      }}
      {...aria}
    >
      {options.map((option) => (
        <RadioGroup.Item key={option.value} value={option.value} className={styles.item}>
          {option.icon ? <span aria-hidden="true">{option.icon}</span> : null}
          {option.label}
        </RadioGroup.Item>
      ))}
    </RadioGroup.Root>
  );
}
