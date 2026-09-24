import { RadioGroup } from "radix-ui";
import type { ReactNode } from "react";
import styles from "./SegmentedControl.module.css";
import { cx } from "./cx.ts";

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

/** A single-choice control with radio-group semantics and arrow-key navigation. */
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
