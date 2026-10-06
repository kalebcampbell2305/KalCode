import type { StatusTone as DisplayTone } from "@kalcode/protocol";
import type { HTMLAttributes, ReactNode } from "react";
import { cx } from "./cx.ts";
import styles from "./Stat.module.css";

export interface StatProps extends Omit<HTMLAttributes<HTMLDivElement>, "children"> {
  /** What is counted (LABEL role). */
  label: ReactNode;
  /** The number or short value (tabular figures). */
  value: ReactNode;
  /** Decorative glyph, tinted by `tone`. */
  icon?: ReactNode;
  /** Contract tone for the glyph and accent hairline. Omit for neutral. */
  tone?: DisplayTone;
  /** A line under the value ("+2 since 9:00", "across 3 workspaces"). */
  hint?: ReactNode;
  /** Right-hand visual (e.g. a Sparkline). Decorative; the value carries the meaning. */
  trend?: ReactNode;
  /** Dim a zero or empty value. */
  quiet?: boolean;
  /** Renders as a button when set (filters). */
  onSelect?: () => void;
  selected?: boolean;
}

/**
 * A KPI tile: label, value, optional glyph, hint and trend. Group tiles with `StatGroup` to build
 * the Dashboard's KPI strip. Never colour-only: the label always says what the number is.
 */
export function Stat({
  label,
  value,
  icon,
  tone,
  hint,
  trend,
  quiet = false,
  onSelect,
  selected,
  className,
  ...rest
}: StatProps) {
  const content = (
    <>
      {/* The lit top edge on an inert element, not ::before (see Stat.module.css). */}
      <span className={styles.edge} aria-hidden="true" />
      <span className={styles.top}>
        {icon ? (
          <span className={styles.icon} aria-hidden="true">
            {icon}
          </span>
        ) : null}
        <span className={styles.label}>{label}</span>
      </span>
      <span className={styles.row}>
        <span className={styles.value}>{value}</span>
        {trend ? (
          <span className={styles.trend} aria-hidden="true">
            {trend}
          </span>
        ) : null}
      </span>
      {hint ? <span className={styles.hint}>{hint}</span> : null}
    </>
  );
  const shared = {
    className: cx(styles.stat, onSelect && styles.selectable, className),
    "data-tone": tone,
    "data-quiet": quiet || undefined,
    "data-selected": selected || undefined,
  };
  if (onSelect) {
    return (
      <button type="button" {...shared} aria-pressed={selected} onClick={onSelect}>
        {content}
      </button>
    );
  }
  return (
    <div {...shared} {...rest}>
      {content}
    </div>
  );
}

/** A row of Stat tiles that share hairline dividers (the KPI strip). */
export function StatGroup({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cx(styles.group, className)} {...rest} />;
}

export interface SparklineProps {
  values: readonly number[];
  /** Contract tone of the line; defaults to the accent. */
  tone?: DisplayTone | "accent";
  width?: number;
  height?: number;
  /** Bars instead of a line (activity per interval). */
  variant?: "line" | "bars";
  className?: string;
}

/** A tiny decorative trend. Always accompanied by the value it summarises. */
export function Sparkline({
  values,
  tone = "accent",
  width = 72,
  height = 22,
  variant = "line",
  className,
}: SparklineProps) {
  const max = Math.max(1, ...values);
  const n = values.length;
  if (n === 0) return null;
  if (variant === "bars") {
    const gap = 1.5;
    const w = (width - gap * (n - 1)) / n;
    return (
      <svg className={cx(styles.spark, className)} data-tone={tone} width={width} height={height} aria-hidden="true">
        {values.map((v, i) => {
          const h = Math.max(1.5, (v / max) * (height - 1));
          // biome-ignore lint/suspicious/noArrayIndexKey: bars are positional and never reorder.
          return <rect key={i} x={i * (w + gap)} y={height - h} width={w} height={h} rx={1} />;
        })}
      </svg>
    );
  }
  const step = n > 1 ? width / (n - 1) : 0;
  const points = values.map((v, i) => `${(i * step).toFixed(1)},${(height - 2 - (v / max) * (height - 4)).toFixed(1)}`);
  return (
    <svg className={cx(styles.spark, className)} data-tone={tone} width={width} height={height} aria-hidden="true">
      <polyline points={`0,${height} ${points.join(" ")} ${width},${height}`} className={styles.area} />
      <polyline points={points.join(" ")} className={styles.line} />
    </svg>
  );
}
