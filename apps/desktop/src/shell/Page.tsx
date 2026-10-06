import type { ReactNode } from "react";
import styles from "./Page.module.css";

interface PageProps {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  width?: "default" | "narrow";
}

/**
 * Standard page frame: a quiet header, then content. The page fills the area right of the
 * sidebar at every window size; surfaces lay out their own columns, and only prose keeps a
 * readable measure. `narrow` keeps a short, single-purpose page (an empty state, a gated
 * surface) in a readable column.
 */
export function Page({ title, description, actions, children, width = "default" }: PageProps) {
  return (
    <div className={styles.page} data-width={width} data-page-content>
      <header className={styles.header}>
        <div className={styles.heading}>
          <h1 className={styles.title}>{title}</h1>
          {description ? <p className={styles.description}>{description}</p> : null}
        </div>
        {actions ? <div className={styles.actions}>{actions}</div> : null}
        <span className={styles.rule} aria-hidden="true" />
      </header>
      {children}
    </div>
  );
}
