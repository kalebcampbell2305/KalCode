import type { ThreadSummary } from "@kalcode/protocol";
import { Tooltip } from "@kalcode/ui/components";
import { Check, GitCompareArrows, RotateCcw } from "lucide-react";
import { allowOverlap, disallowOverlap } from "../../../runtime/ownership/allowed.ts";
import {
  type AgentClaim,
  type AgentOverlap,
  areaBase,
  describeOverlap,
  fileCount,
  needsAttention,
  RISK_LABEL,
} from "../../../runtime/ownership/model.ts";
import styles from "./OverlapNote.module.css";

/** The most file names a tooltip lists before "and N more". */
const LISTED = 8;
/** The most owned areas a claim note names before "+N". */
const AREAS_LISTED = 2;

/** "Codex · Billing Fix": the provider, then the agent's own name. */
function who(agent: ThreadSummary): string {
  const name = agent.name.trim();
  return name && name !== agent.providerName ? `${agent.providerName} · ${name}` : agent.providerName;
}

function short(agent: ThreadSummary): string {
  return agent.name.trim() || who(agent);
}

/** The chip's words, kept short: who, and how many files where that helps. */
function chipText(entry: AgentOverlap): string {
  const { overlap, other } = entry;
  const name = short(other);
  if (overlap.allowed) return `Allowed with ${name}`;
  switch (overlap.risk) {
    case "live":
      return `Editing the same files as ${name}`;
    case "conflict":
      return `Conflicts with ${name}`;
    case "area":
      // The entrant sees whose area it is in; the owner sees who came in.
      return overlap.area?.entrant === other.id ? `${name} entered this area` : `In ${name}'s area`;
    case "compatible":
      return `Merges cleanly with ${name}`;
    default:
      return `Overlaps with ${name} · ${fileCount(overlap)}`;
  }
}

/**
 * A Fleet card's early warning that another agent in the same project is editing the same files
 * or entered this agent's area. One chip per overlapping agent, toned by how expensive the
 * collision will be; it names the files (tooltip) and clicking it opens that agent's terminal, so
 * the person can redirect one of them before the work meets at merge time. "Allow" accepts an
 * intentional overlap (it then reads quietly); "Warn again" undoes that. Merge-clean overlaps
 * collapse to one quiet chip.
 */
export function OverlapNote({
  overlaps,
  selfName,
  onFocus,
}: {
  overlaps: readonly AgentOverlap[];
  /** This card's agent, named in the tooltip sentence. */
  selfName: string;
  onFocus: (thread: ThreadSummary) => void;
}) {
  const compatible = overlaps.filter((entry) => entry.overlap.risk === "compatible");
  const shown = [...overlaps.filter((entry) => entry.overlap.risk !== "compatible"), ...compatible.slice(0, 1)];
  const extra = compatible.length - 1;
  return (
    <ul className={styles.list} aria-label="Overlapping edits">
      {shown.map((entry) => {
        const { overlap, other } = entry;
        const listed = overlap.files.slice(0, LISTED);
        const more = overlap.files.length - listed.length;
        const allowed = overlap.allowed;
        const text = chipText(entry);
        const tone = allowed || overlap.risk === "compatible" ? "quiet" : overlap.risk;
        const sentence = describeOverlap(overlap, (id) => (id === other.id ? short(other) : selfName));
        return (
          <li key={overlap.key} className={styles.row}>
            <Tooltip
              content={
                <span className={styles.tip}>
                  <span className={styles.tipTitle}>
                    {RISK_LABEL[overlap.risk]}: {who(other)}
                  </span>
                  <span>{sentence}</span>
                  {listed.map((file) => (
                    <code key={file} className={styles.file}>
                      {file}
                    </code>
                  ))}
                  {more > 0 ? <span className={styles.more}>and {more} more</span> : null}
                  {overlap.incomplete ? <span className={styles.more}>Not every file was listed.</span> : null}
                </span>
              }
            >
              <button
                type="button"
                className={styles.chip}
                data-tone={tone}
                onClick={(event) => {
                  // The card itself opens this agent: the chip opens the other one.
                  event.stopPropagation();
                  onFocus(other);
                }}
                aria-label={`${text}: ${sentence} Open ${short(other)}`}
              >
                <GitCompareArrows aria-hidden="true" />
                <span className={styles.text}>{text}</span>
                {overlap.risk === "compatible" && extra > 0 ? <span className={styles.count}>+{extra}</span> : null}
              </button>
            </Tooltip>
            {needsAttention(overlap) ? (
              <button
                type="button"
                className={styles.control}
                title="Allow both to edit these files"
                aria-label={`Allow both to edit these files (${short(other)})`}
                onClick={(event) => {
                  event.stopPropagation();
                  allowOverlap(overlap.key, overlap.files, overlap.risk);
                }}
              >
                <Check aria-hidden="true" />
              </button>
            ) : allowed ? (
              <button
                type="button"
                className={styles.control}
                title="Warn again about these files"
                aria-label={`Warn again about these files (${short(other)})`}
                onClick={(event) => {
                  event.stopPropagation();
                  disallowOverlap(overlap.key);
                }}
              >
                <RotateCcw aria-hidden="true" />
              </button>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * One quiet line about what this agent holds: files handed to it, work it handed on, or the areas
 * it was given to own. Nothing when it holds none of those.
 */
export function ClaimNote({
  claim,
  nameOf,
}: {
  claim: AgentClaim | undefined;
  nameOf: (agentId: string) => string | null;
}) {
  if (!claim) return null;
  const parts: string[] = [];
  if (claim.received) {
    const n = claim.received.files.length;
    const from = nameOf(claim.received.from) ?? "another agent";
    parts.push(n > 0 ? `From ${from} · ${n} ${n === 1 ? "file" : "files"}` : `From ${from}`);
  }
  if (claim.handedTo) parts.push(`Handed to ${nameOf(claim.handedTo.to) ?? "another agent"}`);
  const areas = [...new Set(claim.areas.map((area) => areaBase(area) || area))];
  if (areas.length > 0) {
    const more = areas.length - AREAS_LISTED;
    parts.push(`Owns ${areas.slice(0, AREAS_LISTED).join(", ")}${more > 0 ? ` +${more}` : ""}`);
  }
  if (parts.length === 0) return null;
  const text = parts.join(" · ");
  return (
    <p className={styles.claim} title={text}>
      {text}
    </p>
  );
}
