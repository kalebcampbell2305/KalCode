import {
  DISPLAY_QUALIFIER_LABEL,
  DISPLAY_STATUS_TONE,
  type DisplayQualifier,
  type DisplayStatus,
  type StatusTone as DisplayTone,
} from "@kalcode/protocol";
import {
  Activity,
  CircleCheck,
  CircleDashed,
  CirclePause,
  CircleX,
  CloudOff,
  FlaskConical,
  Hourglass,
  LoaderCircle,
  type LucideIcon,
  MessageCircleQuestion,
  RotateCw,
  ScanEye,
  ShieldAlert,
} from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { cx } from "./cx.ts";
import styles from "./StatusChip.module.css";

export type { DisplayTone };

/** Sentence-case words for each display status. Chips render them as caps visually (CSS), so
 *  screen readers hear words, not letters. Mirrors `DISPLAY_STATUS_LABEL` in @kalcode/protocol. */
export const DISPLAY_STATUS_TEXT = {
  starting: "Starting",
  working: "Working",
  testing: "Testing",
  reviewing: "Reviewing",
  permission_required: "Permission required",
  waiting_for_you: "Waiting for you",
  waiting: "Waiting",
  idle: "Idle",
  paused: "Paused",
  done: "Done",
  failed: "Failed",
  recovering: "Recovering",
  offline: "Offline",
} as const satisfies Record<DisplayStatus, string>;

/** One glyph per display status (§16.3): status is never colour alone. */
export const DISPLAY_STATUS_GLYPH: Record<DisplayStatus, LucideIcon> = {
  starting: LoaderCircle,
  working: Activity,
  testing: FlaskConical,
  reviewing: ScanEye,
  permission_required: ShieldAlert,
  waiting_for_you: MessageCircleQuestion,
  waiting: Hourglass,
  idle: CircleDashed,
  paused: CirclePause,
  done: CircleCheck,
  failed: CircleX,
  recovering: RotateCw,
  offline: CloudOff,
};

export interface StatusChipProps {
  /** A normalized display status; derives tone, glyph and words. */
  status?: DisplayStatus;
  /** Tone override, or the tone when no `status` is given. */
  tone?: DisplayTone;
  /** Words override (e.g. a more specific "Running command"). Required when no `status`. */
  label?: ReactNode;
  /** A qualifier from the contract ("stopped · resumable") or free text. */
  qualifier?: DisplayQualifier | (string & {}) | null;
  /** Glyph override; `null` draws a dot instead. */
  icon?: LucideIcon | null;
  /**
   * chip   bordered, caps label: Dashboard cards, pane headers, tables
   * inline glyph + sentence text: rows, detail headers
   * dot    dot + sentence text: the densest lists
   */
  variant?: "chip" | "inline" | "dot";
  size?: "sm" | "md";
  className?: string;
}

/**
 * The status of a thread, pane or task as tone + glyph + words. WORKING breathes softly,
 * WAITING / PERMISSION REQUIRED stay calm and emphasized, and a change of status (e.g. to DONE)
 * gets a brief one-shot highlight. Reduced motion removes all animation.
 */
export function StatusChip({
  status,
  tone,
  label,
  qualifier,
  icon,
  variant = "chip",
  size = "md",
  className,
}: StatusChipProps) {
  const resolvedTone: DisplayTone = tone ?? (status ? DISPLAY_STATUS_TONE[status] : "muted");
  const Glyph = icon === null ? null : (icon ?? (status ? DISPLAY_STATUS_GLYPH[status] : null));
  const words = label ?? (status ? DISPLAY_STATUS_TEXT[status] : null);
  const qualifierText =
    qualifier && qualifier in DISPLAY_QUALIFIER_LABEL
      ? DISPLAY_QUALIFIER_LABEL[qualifier as DisplayQualifier]
      : (qualifier ?? null);

  const key = `${status ?? ""}|${resolvedTone}`;
  const previous = useRef(key);
  const [changes, setChanges] = useState(0);
  useEffect(() => {
    if (previous.current !== key) {
      previous.current = key;
      setChanges((n) => n + 1);
    }
  }, [key]);

  return (
    <span
      key={changes}
      className={cx(styles.status, styles[variant], size === "sm" && styles.sm, className)}
      data-tone={resolvedTone}
      data-status={status}
      data-changed={changes > 0 || undefined}
    >
      {variant === "dot" || !Glyph ? (
        <span className={styles.dot} aria-hidden="true" />
      ) : (
        <Glyph className={styles.glyph} aria-hidden="true" strokeWidth={2} />
      )}
      <span className={styles.text}>{words}</span>
      {qualifierText ? <span className={styles.qualifier}>{qualifierText}</span> : null}
    </span>
  );
}
