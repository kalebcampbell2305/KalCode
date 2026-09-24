import { RadioGroup } from "radix-ui";
import { type ReactNode, useRef } from "react";
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
  // Tracks the latest selection so each change is reported exactly once, whichever path
  // (Radix's own selection or the arrow-key fallback below) observes it first.
  const latest = useRef(value);
  latest.current = value;
  const select = (next: string) => {
    if (next === latest.current || !options.some((option) => option.value === next)) return;
    latest.current = next as T;
    onValueChange(next as T);
  };

  return (
    <RadioGroup.Root
      className={cx(styles.root, className)}
      value={value}
      onValueChange={select}
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
          if (next) select(next);
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
