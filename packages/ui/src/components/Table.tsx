import { forwardRef, type HTMLAttributes, type ReactNode, type TableHTMLAttributes } from "react";
import { cx } from "./cx.ts";
import styles from "./Table.module.css";

export interface TableProps extends TableHTMLAttributes<HTMLTableElement> {
  /** Visible or visually hidden caption; tables need a name. */
  caption?: ReactNode;
  captionHidden?: boolean;
  /** Tighter rows for long operational lists. */
  dense?: boolean;
  /** Keep the header visible while the body scrolls (inside a scroll container). */
  stickyHeader?: boolean;
  /** Frame the table as a panel (border, radius, surface). */
  framed?: boolean;
}

/**
 * Native table with KalCode styling: LABEL-role column heads, hairline rows, hover highlight,
 * tabular figures. Write <thead>/<tbody> as usual; add `data-selected` to a <tr> to light it,
 * and `data-numeric` to a cell to right-align numbers.
 */
export const Table = forwardRef<HTMLTableElement, TableProps>(function Table(
  { caption, captionHidden = false, dense = false, stickyHeader = false, framed = false, className, children, ...rest },
  ref,
) {
  const table = (
    <table
      ref={ref}
      className={cx(styles.table, dense && styles.dense, stickyHeader && styles.sticky, className)}
      {...rest}
    >
      {caption ? <caption className={cx(styles.caption, captionHidden && "visually-hidden")}>{caption}</caption> : null}
      {children}
    </table>
  );
  return framed ? <div className={styles.frame}>{table}</div> : table;
});

export interface RowListProps extends HTMLAttributes<HTMLUListElement> {
  /** Accessible name of the list. */
  label: string;
  dense?: boolean;
}

/** A dense list of rows (threads, terminals, events) separated by hairlines. */
export function RowList({ label, dense = false, className, ...rest }: RowListProps) {
  return (
    // biome-ignore lint/a11y/noRedundantRoles: list-style: none removes the implicit role in Safari/WebKit.
    <ul role="list" aria-label={label} className={cx(styles.rows, dense && styles.dense, className)} {...rest} />
  );
}

export interface RowItemProps extends HTMLAttributes<HTMLLIElement> {
  /** Light the row (the item shown in a detail pane, the focused pane). */
  selected?: boolean;
  /** Hover highlight for rows that contain a primary button/link. */
  interactive?: boolean;
}

export function RowItem({ selected = false, interactive = false, className, ...rest }: RowItemProps) {
  return (
    <li
      className={cx(styles.row, interactive && styles.interactive, className)}
      data-selected={selected || undefined}
      {...rest}
    />
  );
}
