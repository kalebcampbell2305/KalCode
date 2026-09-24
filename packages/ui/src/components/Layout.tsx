import type { ReactNode } from "react";
import { cx } from "./cx.ts";
import styles from "./Layout.module.css";

export interface SectionProps {
  title: string;
  /** Optional id for aria-labelledby wiring and deep links. */
  id?: string;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}

/** A titled region of a page. Structure comes from spacing and a hairline, not a card. */
export function Section({ title, id, description, actions, children, className }: SectionProps) {
  const headingId = id ? `${id}-title` : undefined;
  return (
    <section className={cx(styles.section, className)} aria-labelledby={headingId} id={id}>
      <header className={styles.sectionHeader}>
        <div>
          <h2 id={headingId} className={styles.sectionTitle}>
            {title}
          </h2>
          {description ? <p className={styles.sectionDescription}>{description}</p> : null}
        </div>
        {actions ? <div className={styles.sectionActions}>{actions}</div> : null}
      </header>
      {children}
    </section>
  );
}

export interface KeyValueItem {
  key: string;
  label: ReactNode;
  value: ReactNode;
}

/** Label/value pairs as a semantic description list. */
export function KeyValueList({ items, className }: { items: readonly KeyValueItem[]; className?: string }) {
  return (
    <dl className={cx(styles.kv, className)}>
      {items.map((item) => (
        <div key={item.key} className={styles.kvRow}>
          <dt>{item.label}</dt>
          <dd>{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd>{children}</kbd>;
}
