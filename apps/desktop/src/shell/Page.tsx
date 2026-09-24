import type { ReactNode } from "react";
import styles from "./Page.module.css";

interface PageProps {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  width?: "default" | "narrow";
}

/** Standard page frame: a quiet header, then content in a readable column. */
export function Page({ title, description, actions, children, width = "default" }: PageProps) {
  return (
    <div className={styles.page} data-width={width}>
      <header className={styles.header}>
        <div className={styles.heading}>
          <h1 className={styles.title}>{title}</h1>
          {description ? <p className={styles.description}>{description}</p> : null}
        </div>
        {actions ? <div className={styles.actions}>{actions}</div> : null}
      </header>
      {children}
    </div>
  );
}
