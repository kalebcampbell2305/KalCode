import { FlaskConical, GitBranch, Globe, Hand, Zap } from "lucide-react";
import { Fragment, memo } from "react";
import type { PaneController } from "../../../shell/panes/usePaneController.ts";
import { useOptionalPermissions } from "../../permissions/PermissionsProvider.tsx";
import { openBrowser, openTests, showFirst } from "./actions.ts";
import type { HappeningSegment } from "./model.ts";
import styles from "./Organization.module.css";
import type { Organization } from "./useOrganization.ts";

const SEGMENT_TONE: Record<HappeningSegment["kind"], string> = {
  agents: "working",
  "needs-you": "waiting",
  tests: "muted",
  service: "muted",
  git: "muted",
};

function SegmentIcon({ segment }: { segment: HappeningSegment }) {
  if (segment.kind === "agents") return <Zap aria-hidden="true" />;
  if (segment.kind === "needs-you") return <Hand aria-hidden="true" />;
  if (segment.kind === "tests") return <FlaskConical aria-hidden="true" />;
  if (segment.kind === "service") return <Globe aria-hidden="true" />;
  return <GitBranch aria-hidden="true" />;
}

const SEGMENT_ACTION: Record<HappeningSegment["kind"], string> = {
  agents: "Show the first working agent",
  "needs-you": "Show what needs you",
  tests: "Open Tests",
  service: "Open it in the Browser",
  git: "Open Git",
};

/**
 * What's Happening: one thin line of observed facts for this workspace ("4 agents working ·
 * 1 needs you · tests passing · localhost:3000 · main clean"). Each part opens what it describes;
 * parts without data are left out rather than guessed.
 */
export const HappeningStrip = memo(function HappeningStrip({
  organization,
  controller,
  workspaceId,
}: {
  organization: Organization;
  controller: PaneController;
  workspaceId: string;
}) {
  const openApprovals = useOptionalPermissions()?.setPanelOpen ?? null;
  const { segments, items } = organization;
  const act = (segment: HappeningSegment) => {
    if (segment.kind === "agents") showFirst(controller, items, ["working", "testing"], "agent");
    else if (segment.kind === "needs-you") {
      if (!showFirst(controller, items, ["needs_you"], "agent")) openApprovals?.(true);
    } else if (segment.kind === "tests") openTests(controller);
    else if (segment.kind === "service") openBrowser(controller, segment.url);
    else controller.show({ kind: "git", workspaceId }, { placement: "split", focus: true });
  };
  return (
    <fieldset className={styles.happening}>
      <legend className="visually-hidden">What's happening</legend>
      {segments.length === 0 ? (
        <span className={styles.quiet}>Nothing running right now</span>
      ) : (
        segments.map((segment, index) => (
          <Fragment key={segment.kind}>
            {index > 0 ? (
              <span className={styles.separator} aria-hidden="true">
                ·
              </span>
            ) : null}
            <button
              type="button"
              className={styles.segment}
              data-tone={segment.kind === "tests" ? segment.tone : SEGMENT_TONE[segment.kind]}
              title={SEGMENT_ACTION[segment.kind]}
              onClick={() => act(segment)}
            >
              <SegmentIcon segment={segment} />
              {segment.text}
            </button>
          </Fragment>
        ))
      )}
    </fieldset>
  );
});
