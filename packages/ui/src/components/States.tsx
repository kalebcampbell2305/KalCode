import type { HTMLAttributes, ReactNode } from "react";
import { cx } from "./cx.ts";
import styles from "./States.module.css";

type HeadingLevel = 1 | 2 | 3 | 4;

export interface EmptyStateProps {
  /** Heading level for the title; defaults to 3 (inside a page section). */
  headingLevel?: HeadingLevel;
  /** Decorative illustration or icon. */
  art?: ReactNode;
  title: string;
  children?: ReactNode;
  actions?: ReactNode;
  className?: string;
}

/** Guides the user when a surface has nothing to show yet. */
export function EmptyState({ art, title, children, actions, className, headingLevel = 3 }: EmptyStateProps) {
  const Heading = `h${headingLevel}` as const;
  return (
    <div className={cx(styles.empty, className)}>
      {art ? (
        <div className={styles.art} aria-hidden="true">
          {art}
        </div>
      ) : null}
      <Heading className={styles.title}>{title}</Heading>
      {children ? <div className={styles.body}>{children}</div> : null}
      {actions ? <div className={styles.actions}>{actions}</div> : null}
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
  className?: string;
}

export function ErrorState({ title, children, actions, code, className, headingLevel = 3 }: ErrorStateProps) {
  const Heading = `h${headingLevel}` as const;
  return (
    <div className={cx(styles.error, className)} role="alert">
      <Heading className={styles.title}>{title}</Heading>
      {children ? <div className={styles.body}>{children}</div> : null}
      {actions ? <div className={styles.actions}>{actions}</div> : null}
      {code ? <p className={styles.code}>Error code: {code}</p> : null}
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
