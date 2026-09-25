import { forwardRef, type HTMLAttributes, type ReactNode } from "react";
import { cx } from "./cx.ts";
import styles from "./Panel.module.css";

/**
 * Surface levels (tokens.css): 1 panel, 2 panel header / input well, 3 popover.
 * `lit` is the blue-lit hairline for the focused / active surface — use it on one thing at a time.
 */
export interface SurfaceProps extends HTMLAttributes<HTMLDivElement> {
  level?: 1 | 2 | 3;
  /** Active or focused: blue-lit hairline and a faint glow. */
  lit?: boolean;
  /** Hover lights the hairline (clickable cards). */
  interactive?: boolean;
  /** Sunken well (terminals, code, empty states inside a panel). */
  sunken?: boolean;
  as?: "div" | "section" | "article" | "aside";
}

export const Surface = forwardRef<HTMLDivElement, SurfaceProps>(function Surface(
  { level = 1, lit = false, interactive = false, sunken = false, as: As = "div", className, ...rest },
  ref,
) {
  return (
    <As
      ref={ref as never}
      className={cx(styles.surface, sunken && styles.sunken, interactive && styles.interactive, className)}
      data-level={sunken ? undefined : level}
      data-lit={lit || undefined}
      {...rest}
    />
  );
});

export interface PanelProps extends Omit<HTMLAttributes<HTMLElement>, "title"> {
  as?: "section" | "div" | "article" | "aside";
  /** Panel title (TITLE role). Also labels the region when `as="section"`. */
  title?: ReactNode;
  headingLevel?: 2 | 3 | 4;
  /** Small caps label above or beside the title (LABEL role). */
  eyebrow?: ReactNode;
  /** Decorative icon before the title. */
  icon?: ReactNode;
  /** A count shown as a pill after the title. */
  count?: ReactNode;
  /** Emphasize the count (needs you). */
  countTone?: "neutral" | "attention";
  /** Controls on the right of the header. */
  actions?: ReactNode;
  /** One line under the title. */
  description?: ReactNode;
  footer?: ReactNode;
  /** default · lit (active) · flush (no frame: header + hairline only, for dense page sections) */
  tone?: "default" | "lit" | "flush";
  /** Body padding. */
  padding?: "none" | "sm" | "md";
  /** Stable id for aria-labelledby. */
  id?: string;
  bodyClassName?: string;
}

/**
 * The app's framed surface: a navy panel with a fine hairline, a top sheen and a compact header
 * (title · count · actions). Panels compose the workspace; the lit tone marks the one that is
 * active.
 */
export const Panel = forwardRef<HTMLElement, PanelProps>(function Panel(
  {
    as: As = "section",
    title,
    headingLevel = 2,
    eyebrow,
    icon,
    count,
    countTone = "neutral",
    actions,
    description,
    footer,
    tone = "default",
    padding = "md",
    id,
    className,
    bodyClassName,
    children,
    ...rest
  },
  ref,
) {
  const Heading = `h${headingLevel}` as const;
  const headingId = id ? `${id}-title` : undefined;
  const hasHeader = title != null || actions != null || eyebrow != null;
  return (
    <As
      ref={ref as never}
      id={id}
      className={cx(styles.panel, className)}
      data-tone={tone}
      aria-labelledby={As === "section" && headingId && title != null ? headingId : undefined}
      {...rest}
    >
      {hasHeader ? (
        <header className={styles.header}>
          <div className={styles.heading}>
            {icon ? (
              <span className={styles.icon} aria-hidden="true">
                {icon}
              </span>
            ) : null}
            <div className={styles.titles}>
              {eyebrow ? <p className={styles.eyebrow}>{eyebrow}</p> : null}
              {title != null ? (
                <Heading id={headingId} className={styles.title}>
                  {title}
                  {count != null ? (
                    <span className={styles.count} data-tone={countTone}>
                      {count}
                    </span>
                  ) : null}
                </Heading>
              ) : null}
              {description ? <p className={styles.description}>{description}</p> : null}
            </div>
          </div>
          {actions ? <div className={styles.actions}>{actions}</div> : null}
        </header>
      ) : null}
      <div className={cx(styles.body, bodyClassName)} data-padding={padding}>
        {children}
      </div>
      {footer ? <footer className={styles.footer}>{footer}</footer> : null}
    </As>
  );
});

/** A section label inside a panel or sidebar (LABEL role: small caps, wide tracking). */
export function Eyebrow({ children, className, ...rest }: HTMLAttributes<HTMLParagraphElement>) {
  return (
    <p className={cx(styles.eyebrow, className)} {...rest}>
      {children}
    </p>
  );
}
