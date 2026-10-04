import { ChevronDown } from "lucide-react";
import {
  forwardRef,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from "react";
import { cx } from "./cx.ts";
import styles from "./Field.module.css";

export interface FieldProps {
  /** Id of the control this field labels. */
  htmlFor: string;
  label: string;
  /** Help text below the control. Wire it with `aria-describedby={`${htmlFor}-hint`}`. */
  hint?: ReactNode;
  optional?: boolean;
  children: ReactNode;
  className?: string;
}

/** A labelled form control with optional help text. */
export function Field({ htmlFor, label, hint, optional, children, className }: FieldProps) {
  return (
    <div className={cx(styles.field, className)}>
      <label htmlFor={htmlFor} className={styles.label}>
        {label}
        {optional ? <span className={styles.optional}>Optional</span> : null}
      </label>
      {children}
      {hint ? (
        <p id={`${htmlFor}-hint`} className={styles.hint}>
          {hint}
        </p>
      ) : null}
    </div>
  );
}

export const TextInput = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function TextInput(
  { className, type = "text", ...rest },
  ref,
) {
  return <input ref={ref} type={type} className={cx(styles.control, className)} {...rest} />;
});

export const TextArea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function TextArea(
  { className, ...rest },
  ref,
) {
  return <textarea ref={ref} className={cx(styles.control, styles.textarea, className)} {...rest} />;
});

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(function Select(
  { className, children, ...rest },
  ref,
) {
  return (
    <span className={cx(styles.selectWrap, className)}>
      <select ref={ref} className={cx(styles.control, styles.select)} data-chevron="icon" {...rest}>
        {children}
      </select>
      <ChevronDown className={styles.chevron} aria-hidden="true" />
    </span>
  );
});
