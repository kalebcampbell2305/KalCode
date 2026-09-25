import { CircleAlert } from "lucide-react";
import type { HTMLAttributes, ReactNode } from "react";
import { cx } from "./cx.ts";
import styles from "./States.module.css";

type HeadingLevel = 1 | 2 | 3 | 4;

export interface EmptyStateProps {
  /** Heading level for the title; defaults to 3 (inside a page section). */
  headingLevel?: HeadingLevel;
  /** Decorative illustration or icon. */
  art?: ReactNode;
  /** tile: the art sits on a lit tile (for icons, the default). free: illustration as-is. */
  artStyle?: "tile" | "free";
  title: string;
  children?: ReactNode;
  actions?: ReactNode;
  /**
   * Frame the state with a quiet sunken surface and border.
   * Default true; pass false when the state already sits inside a Panel.
   */
  framed?: boolean;
  /** Centre the content (large wells) instead of aligning to the start. */
  align?: "start" | "center";
  className?: string;
}

/** Guides the user when a surface has nothing to show yet: what this place is for, and the next step. */
export function EmptyState({
  art,
  artStyle = "tile",
  title,
  children,
  actions,
  className,
  headingLevel = 3,
  framed = true,
  align = "start",
}: EmptyStateProps) {
  const Heading = `h${headingLevel}` as const;
  return (
    <div className={cx(styles.empty, framed && styles.framed, className)} data-align={align}>
      {art ? (
        <div className={cx(styles.art, artStyle === "tile" && styles.tile)} aria-hidden="true">
          {art}
        </div>
      ) : null}
      <div className={styles.copy}>
        <Heading className={styles.title}>{title}</Heading>
        {children ? <div className={styles.body}>{children}</div> : null}
        {actions ? <div className={styles.actions}>{actions}</div> : null}
      </div>
    </div>
  );
}

export interface ErrorStateProps {
  /** Heading level for the title; use 1 when the error is the whole screen. */
  headingLevel?: HeadingLevel;
  title: string;
  /** What failed, what is safe, and what the user can do. */
  children?: ReactNode;
  actions?: ReactNode;
  /** Stable error code, shown small for support. */
  code?: string;
  /** Frame with the failed hairline (default true). */
  framed?: boolean;
  className?: string;
}

export function ErrorState({
  title,
  children,
  actions,
  code,
  className,
  headingLevel = 3,
  framed = true,
}: ErrorStateProps) {
  const Heading = `h${headingLevel}` as const;
  return (
    <div className={cx(styles.error, framed && styles.errorFramed, className)} role="alert">
      <CircleAlert className={styles.errorIcon} aria-hidden="true" />
      <div className={styles.copy}>
        <Heading className={styles.title}>{title}</Heading>
        {children ? <div className={styles.body}>{children}</div> : null}
        {actions ? <div className={styles.actions}>{actions}</div> : null}
        {code ? <p className={styles.code}>Error code: {code}</p> : null}
      </div>
    </div>
  );
}

export interface SkeletonProps extends HTMLAttributes<HTMLSpanElement> {
  width?: string;
  height?: string;
}

/** Loading placeholder. Pair with an accessible busy state on the container. */
export function Skeleton({ width = "100%", height = "0.875rem", className, style, ...rest }: SkeletonProps) {
  return (
    <span aria-hidden="true" className={cx(styles.skeleton, className)} style={{ width, height, ...style }} {...rest} />
  );
}
