import { ChevronDown } from "lucide-react";
import { useId } from "react";
import styles from "./OutcomeStrip.module.css";
import type { OutcomeRow } from "./outcomeModel.ts";

interface OutcomeStripProps {
  rows: readonly OutcomeRow[];
  expanded: boolean;
  onToggle: () => void;
  /** `card`: the list opens inside the Fleet card. `pane`: it floats over the terminal (no reflow). */
  variant: "card" | "pane";
  /** The agent's name, for assistive technology. */
  name: string;
}

/**
 * An agent's outcome in one quiet line: changed → tests → merge → release, each stage
 * with its own observed value. Stages KalCode hasn't observed are left out of the line and shown,
 * marked unknown, in the full list. Agent done, change verified, merged and released are always
 * separate stages: none implies another.
 */
export function OutcomeStrip({ rows, expanded, onToggle, variant, name }: OutcomeStripProps) {
  const listId = useId();
  const known = rows.filter((row) => row.known);
  const summary = known.map((row) => `${row.label}: ${row.value}`).join(", ");
  // The agent's own state already sits beside the strip (card or pane header); the line carries
  // what came of the work. The full list keeps every stage, the agent's included.
  const shown = known.filter((row) => row.stage !== "agent");
  return (
    <div className={styles.strip} data-variant={variant} data-expanded={expanded || undefined}>
      <button
        type="button"
        className={styles.line}
        aria-expanded={expanded}
        aria-controls={listId}
        aria-label={`Outcome of ${name}: ${summary}`}
        title={expanded ? "Hide the outcome" : "Show the full outcome"}
        onClick={(event) => {
          event.stopPropagation();
          onToggle();
        }}
      >
        <span className={styles.stages} aria-hidden="true">
          {shown.map((row) => (
            <span key={row.stage} className={styles.stage} data-tone={row.tone} data-stage={row.stage}>
              <span className={styles.dot} />
              <span className={styles.value}>{row.short}</span>
            </span>
          ))}
        </span>
        <ChevronDown className={styles.chevron} aria-hidden="true" />
      </button>
      {expanded ? (
        <dl className={styles.list} id={listId} data-outcome-list>
          {rows.map((row) => (
            <div key={row.stage} className={styles.row} data-tone={row.tone} data-known={row.known || undefined}>
              <dt className={styles.rowLabel}>
                <span className={styles.dot} aria-hidden="true" />
                {row.label}
              </dt>
              <dd className={styles.rowValue}>
                <span className={styles.rowMain}>{row.value}</span>
                {row.detail ? <span className={styles.rowDetail}>{row.detail}</span> : null}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
    </div>
  );
}
