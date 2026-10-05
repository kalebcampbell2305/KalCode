import type { ThreadSummary } from "@kalcode/protocol";
import { Tooltip } from "@kalcode/ui/components";
import { GitCompareArrows } from "lucide-react";
import styles from "./OverlapNote.module.css";
import { type AgentOverlap, overlapCount } from "./overlap.ts";

/** The most file names a tooltip lists before "and N more". */
const LISTED = 8;

/** "Codex · Billing Fix": the provider, then the agent's own name. */
function who(agent: ThreadSummary): string {
  const name = agent.name.trim();
  return name && name !== agent.providerName ? `${agent.providerName} · ${name}` : agent.providerName;
}

/**
 * A Fleet card's early warning that another agent in the same project is editing the same files.
 * One chip per overlapping agent; it names the files (tooltip) and clicking it opens that agent's
 * terminal, so the person can redirect one of them before the work meets at merge time.
 */
export function OverlapNote({
  overlaps,
  onFocus,
}: {
  overlaps: readonly AgentOverlap[];
  onFocus: (thread: ThreadSummary) => void;
}) {
  return (
    <ul className={styles.list} aria-label="Overlapping edits">
      {overlaps.map((overlap) => {
        const listed = overlap.files.slice(0, LISTED);
        const more = overlap.files.length - listed.length;
        const count = overlapCount(overlap);
        return (
          <li key={overlap.other.id}>
            <Tooltip
              content={
                <span className={styles.tip}>
                  <span className={styles.tipTitle}>
                    {who(overlap.other)} also changed {count}
                    {overlap.incomplete ? " (not every file was listed)" : ""}
                  </span>
                  {listed.map((file) => (
                    <code key={file} className={styles.file}>
                      {file}
                    </code>
                  ))}
                  {more > 0 ? <span className={styles.more}>and {more} more</span> : null}
                </span>
              }
            >
              <button
                type="button"
                className={styles.chip}
                onClick={(event) => {
                  // The card itself opens this agent: the chip opens the other one.
                  event.stopPropagation();
                  onFocus(overlap.other);
                }}
                aria-label={`Overlaps with ${who(overlap.other)}: both changed ${count}. Open ${overlap.other.name}`}
              >
                <GitCompareArrows aria-hidden="true" />
                <span className={styles.text}>
                  Overlaps with <span className={styles.other}>{overlap.other.name.trim() || who(overlap.other)}</span>
                </span>
                <span className={styles.count}>{count}</span>
              </button>
            </Tooltip>
          </li>
        );
      })}
    </ul>
  );
}
