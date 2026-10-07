import type { Chain, ChainStep, ChainStepIntent, ChainStepPhase, OperationRecord } from "@kalcode/protocol";
import { ProviderGlyph, Tooltip } from "@kalcode/ui/components";
import {
  Ban,
  Check,
  CircleSlash,
  Clock3,
  Code2,
  FilePenLine,
  FlaskConical,
  Forward,
  GitMerge,
  type LucideIcon,
  MessageCircleQuestion,
  Pause,
  Play,
  ScanSearch,
  SkipForward,
  Wrench,
  X,
  Zap,
} from "lucide-react";
import { type CSSProperties, memo, type ReactElement } from "react";
import styles from "./ChainRail.module.css";
import {
  dependenciesSatisfied,
  INTENT_LABEL,
  railLayout,
  SATISFIED,
  STEP_PHASE_META,
  stepAriaLabel,
  stepDetail,
  stepRoute,
} from "./model.ts";

export const INTENT_ICON: Record<ChainStepIntent, LucideIcon> = {
  implement: Code2,
  review: ScanSearch,
  fix: Wrench,
  test: FlaskConical,
  continue: Forward,
};

export const PHASE_ICON: Record<ChainStepPhase, LucideIcon> = {
  waiting: Clock3,
  starting: Play,
  working: Zap,
  needs_report: MessageCircleQuestion,
  passed: Check,
  changes_requested: FilePenLine,
  failed: X,
  blocked: Ban,
  paused: Pause,
  skipped: SkipForward,
  cancelled: CircleSlash,
  superseded: GitMerge,
};

/** Details longer than this are truncated on the node and shown whole in a tooltip. */
const DETAIL_TOOLTIP_AT = 48;

export interface ChainRailProps {
  chain: Chain;
  operationsById: ReadonlyMap<string, OperationRecord>;
  /** `compact` for popovers and pane chips: intent, model and phase only. */
  variant?: "full" | "compact";
  /** The step whose details are shown below the rail (full variant). */
  selectedKey?: string | null;
  /** Full: select a step. Compact: open that step's agent. */
  onStep?: (step: ChainStep) => void;
  /** Label for the compact variant's node action ("Open agent"). */
  stepActionLabel?: string;
  /** Hide the next-action line (when the host shows it elsewhere). */
  hideNextAction?: boolean;
}

/**
 * The progress rail: one node per step, left to right, parallel steps stacked in one column.
 * Connectors light when the step before is satisfied; the running step carries one electric-blue
 * energy trace that settles into a lit edge (no loop). Every node is a button with a full spoken
 * label, so colour is never the only signal.
 */
export const ChainRail = memo(function ChainRail({
  chain,
  operationsById,
  variant = "full",
  selectedKey = null,
  onStep,
  stepActionLabel = "Open agent",
  hideNextAction = false,
}: ChainRailProps) {
  const { cells, columns, rows } = railLayout(chain.steps);
  const hasDependents = new Set(chain.steps.flatMap((step) => step.dependsOn));
  const total = chain.steps.length;
  const compact = variant === "compact";
  return (
    <div className={styles.rail} data-variant={variant} data-chain-rail={chain.id}>
      <ol
        className={styles.track}
        aria-label={`Steps of ${chain.name}`}
        style={{ "--rail-columns": columns, "--rail-rows": rows } as CSSProperties}
      >
        {cells.map(({ step, column, row }) => {
          const route = stepRoute(operationsById.get(step.operationId));
          const meta = STEP_PHASE_META[step.phase];
          const label = stepAriaLabel(step, total, route);
          const detail = compact ? null : stepDetail(step);
          const IntentIcon = INTENT_ICON[step.intent];
          const PhaseIcon = PHASE_ICON[step.phase];
          const inLit = dependenciesSatisfied(step, chain.steps);
          const inTone =
            step.phase === "working" || step.phase === "starting"
              ? "active"
              : step.phase === "blocked"
                ? "blocked"
                : inLit
                  ? "lit"
                  : "idle";
          const selected = selectedKey === step.key;
          const node = (
            <button
              type="button"
              className={styles.node}
              data-tone={meta.tone}
              data-phase={step.phase}
              data-step-key={step.key}
              data-selected={selected || undefined}
              aria-label={compact ? `${label}. ${stepActionLabel}` : label}
              aria-pressed={compact ? undefined : selected}
              onClick={onStep ? () => onStep(step) : undefined}
            >
              {meta.tone === "active" && step.phase === "working" ? (
                <span className={styles.trace} aria-hidden="true" />
              ) : null}
              <span className={styles.nodeHead} aria-hidden="true">
                <span className={styles.badge}>
                  <PhaseIcon />
                </span>
                <span className={styles.eyebrow}>
                  <IntentIcon />
                  {compact
                    ? INTENT_LABEL[step.intent]
                    : step.name === INTENT_LABEL[step.intent]
                      ? `Step ${step.position + 1}`
                      : `Step ${step.position + 1} · ${INTENT_LABEL[step.intent]}`}
                </span>
                {step.attempt > 1 ? <span className={styles.attempt}>×{step.attempt}</span> : null}
              </span>
              {compact ? null : (
                <span className={styles.name} aria-hidden="true">
                  {step.name}
                </span>
              )}
              <span className={styles.route} aria-hidden="true">
                {route.providerId ? <ProviderGlyph provider={route.providerId} size="xs" /> : null}
                <span className={styles.model}>{route.model ?? route.providerName}</span>
              </span>
              <span className={styles.phase} aria-hidden="true">
                {meta.label}
              </span>
              {detail ? (
                <span className={styles.detail} aria-hidden="true">
                  {detail}
                </span>
              ) : null}
            </button>
          );
          return (
            <li
              key={step.key}
              className={styles.cell}
              data-column={column}
              data-row={row}
              style={{ "--col": column, "--row": row } as CSSProperties}
            >
              {column > 0 ? <span className={styles.connectorIn} data-state={inTone} aria-hidden="true" /> : null}
              {withTooltip(node, detail)}
              {hasDependents.has(step.key) ? (
                <span
                  className={styles.connectorOut}
                  data-state={SATISFIED.has(step.phase) ? "lit" : "idle"}
                  aria-hidden="true"
                />
              ) : null}
            </li>
          );
        })}
      </ol>
      {!hideNextAction && chain.nextAction ? (
        <p className={styles.next} data-chain-next>
          <span className={styles.nextLabel}>Next</span>
          <span className={styles.nextText}>{chain.nextAction}</span>
        </p>
      ) : null}
    </div>
  );
});

function withTooltip(node: ReactElement, detail: string | null): ReactElement {
  if (!detail || detail.length < DETAIL_TOOLTIP_AT) return node;
  return <Tooltip content={<span className={styles.tooltipText}>{detail}</span>}>{node}</Tooltip>;
}
