import type { ThreadSummary, ThreadWorktreeState } from "@kalcode/protocol";
import { memo, useState } from "react";
import { OutcomeStrip } from "./OutcomeStrip.tsx";
import { hasOutcome } from "./outcomeModel.ts";
import { useAgentOutcome } from "./useAgentOutcome.ts";

/**
 * An agent's outcome beside its work (Fleet card, Code pane). Rendered only once it says more
 * than the agent's state: a reported file change, a linked test or release run, or a worktree fact.
 */
export const AgentOutcome = memo(function AgentOutcome({
  thread,
  worktree,
  variant,
}: {
  thread: ThreadSummary;
  worktree?: ThreadWorktreeState;
  variant: "card" | "pane";
}) {
  const [expanded, setExpanded] = useState(false);
  const rows = useAgentOutcome(thread, worktree, expanded);
  if (!hasOutcome(rows)) return null;
  return (
    <OutcomeStrip
      rows={rows}
      expanded={expanded}
      onToggle={() => setExpanded((open) => !open)}
      variant={variant}
      name={thread.name}
    />
  );
});
