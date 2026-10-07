import type { Chain, ChainStep, ChainStepResult, ChainStepRoute, OperationRecord } from "@kalcode/protocol";
import { Badge, Button, ProviderGlyph, SegmentedControl, TextArea } from "@kalcode/ui/components";
import {
  Ban,
  Check,
  CircleX,
  ExternalLink,
  GitBranch,
  Link2,
  Pause,
  Play,
  RotateCcw,
  Route,
  SkipForward,
  X,
} from "lucide-react";
import { type FormEvent, memo, useEffect, useId, useRef, useState } from "react";
import { toKalCodeError } from "../../ipc/errors.ts";
import type { ChainsValue } from "../../runtime/chains/useChains.tsx";
import { effortLabel } from "../code/panes/agentLaunch.ts";
import styles from "./ChainCard.module.css";
import { ChainRail, INTENT_ICON } from "./ChainRail.tsx";
import {
  CHAIN_PHASE_META,
  chainActions,
  chainProgress,
  type DraftRoute,
  focusStep,
  INTENT_LABEL,
  STEP_PHASE_META,
  type StepAction,
  stepActions,
  stepRoute,
} from "./model.ts";
import { RoutePicker } from "./RoutePicker.tsx";
import { resolveRoute, useRouteOptions } from "./routeOptions.ts";

export type ChainControls = Pick<
  ChainsValue,
  "pause" | "resume" | "cancel" | "retryStep" | "skipStep" | "rerouteStep" | "recordStep"
>;

export interface ChainCardProps {
  chain: Chain;
  operationsById: ReadonlyMap<string, OperationRecord>;
  controls: ChainControls;
  /** Focus the step's coding-agent pane. */
  onOpenAgent: (chain: Chain, step: ChainStep) => void;
  /** Brought into view by `focusChain` (a one-shot highlight). */
  highlighted?: boolean;
}

const OUTCOMES: readonly { value: ChainStepResult; label: string }[] = [
  { value: "passed", label: "Passed" },
  { value: "changes_requested", label: "Changes requested" },
  { value: "failed", label: "Failed" },
];

/**
 * One chain in Activity: its name, goal and phase, the rail, and the selected step's details with
 * only the actions that are safe for its phase. Every action shows its busy state at once and
 * keeps an actionable error inline.
 */
export const ChainCard = memo(function ChainCard({
  chain,
  operationsById,
  controls,
  onOpenAgent,
  highlighted = false,
}: ChainCardProps) {
  const id = useId();
  const [picked, setPicked] = useState<string | null | undefined>(undefined);
  const [busy, setBusy] = useState<"pause" | "resume" | "cancel" | null>(null);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const keepRef = useRef<HTMLButtonElement>(null);
  // Focus follows the inline confirmation: into it on open, back to Cancel when it closes.
  const wasConfirming = useRef(false);
  useEffect(() => {
    if (confirmCancel) keepRef.current?.focus();
    else if (wasConfirming.current) cancelRef.current?.focus();
    wasConfirming.current = confirmCancel;
  }, [confirmCancel]);
  const [error, setError] = useState<string | null>(null);
  const meta = CHAIN_PHASE_META[chain.phase];
  const progress = chainProgress(chain);
  const allowed = chainActions(chain);
  // The person's pick wins while that step exists; otherwise the step that most needs them.
  const selectedKey =
    picked === null
      ? null
      : picked && chain.steps.some((s) => s.key === picked)
        ? picked
        : (focusStep(chain)?.key ?? null);
  const selected = chain.steps.find((step) => step.key === selectedKey) ?? null;

  const run = async (kind: "pause" | "resume" | "cancel", action: () => Promise<unknown>) => {
    setBusy(kind);
    setError(null);
    try {
      await action();
      if (kind === "cancel") setConfirmCancel(false);
    } catch (cause) {
      setError(toKalCodeError(cause).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <article
      className={styles.card}
      data-chain-card={chain.id}
      data-chain-phase={chain.phase}
      data-highlighted={highlighted || undefined}
      aria-labelledby={`${id}-title`}
    >
      {highlighted ? <span className={styles.highlight} aria-hidden="true" /> : null}
      <header className={styles.head}>
        <span className={styles.glyph} data-tone={meta.tone} aria-hidden="true">
          <Link2 />
        </span>
        <div className={styles.titles}>
          <div className={styles.titleRow}>
            <h3 id={`${id}-title`} className={styles.title}>
              {chain.name}
            </h3>
            <Badge tone={meta.tone}>{meta.label}</Badge>
          </div>
          <p className={styles.goal} title={chain.goal}>
            {chain.goal}
          </p>
        </div>
        <div className={styles.facts}>
          <span className={styles.progress}>
            <span className={styles.progressNum} aria-hidden="true">
              {progress.done}
            </span>
            <span className={styles.progressOf} aria-hidden="true">
              /{progress.total}
            </span>
            <span className="visually-hidden">
              {progress.done} of {progress.total} steps done
            </span>
          </span>
          {chain.branch ? (
            <span className={styles.branch} title={chain.branch}>
              <GitBranch aria-hidden="true" />
              <span>{chain.branch}</span>
            </span>
          ) : (
            <span className={styles.branch}>
              {chain.worktree === "shared" ? "Shared worktree" : "Project checkout"}
            </span>
          )}
        </div>
        {allowed.pause || allowed.resume || allowed.cancel ? (
          <div className={styles.chainActions}>
            {allowed.resume ? (
              <Button
                size="sm"
                variant="secondary"
                icon={<Play />}
                busy={busy === "resume"}
                disabled={busy !== null}
                onClick={() => void run("resume", () => controls.resume(chain.id))}
              >
                Resume
              </Button>
            ) : null}
            {allowed.pause ? (
              <Button
                size="sm"
                variant="ghost"
                icon={<Pause />}
                busy={busy === "pause"}
                disabled={busy !== null}
                onClick={() => void run("pause", () => controls.pause(chain.id))}
              >
                Pause
              </Button>
            ) : null}
            {allowed.cancel ? (
              <Button
                ref={cancelRef}
                size="sm"
                variant="ghost"
                icon={<Ban />}
                disabled={busy !== null || confirmCancel}
                aria-expanded={confirmCancel}
                onClick={() => setConfirmCancel(true)}
              >
                Cancel
              </Button>
            ) : null}
          </div>
        ) : null}
      </header>

      {confirmCancel ? (
        // biome-ignore lint/a11y/useSemanticElements: an inline confirmation group, not a form.
        <div
          className={styles.confirm}
          role="group"
          aria-label={`Cancel ${chain.name}`}
          onKeyDown={(event) => {
            if (event.key === "Escape" && busy === null) {
              event.stopPropagation();
              setConfirmCancel(false);
            }
          }}
        >
          <p>Steps that have not started will not run. Agents already working keep running under your control.</p>
          <div className={styles.confirmActions}>
            <Button
              ref={keepRef}
              size="sm"
              variant="ghost"
              disabled={busy !== null}
              onClick={() => setConfirmCancel(false)}
            >
              Keep chain
            </Button>
            <Button
              size="sm"
              variant="danger"
              icon={<CircleX />}
              busy={busy === "cancel"}
              onClick={() => void run("cancel", () => controls.cancel(chain.id))}
            >
              Cancel chain
            </Button>
          </div>
        </div>
      ) : null}

      <ChainRail
        chain={chain}
        operationsById={operationsById}
        selectedKey={selectedKey}
        onStep={(step) => setPicked(step.key === selectedKey ? null : step.key)}
      />

      {selected ? (
        <StepPanel
          key={`${selected.key}:${selected.operationId}`}
          chain={chain}
          step={selected}
          operation={operationsById.get(selected.operationId)}
          controls={controls}
          onOpenAgent={() => onOpenAgent(chain, selected)}
        />
      ) : null}

      {error ? (
        <p className={styles.error} role="alert">
          {error}
        </p>
      ) : null}
    </article>
  );
});

type Mode = "record" | "retry" | "reroute" | null;

export interface StepPanelProps {
  chain: Chain;
  step: ChainStep;
  operation: OperationRecord | undefined;
  controls: ChainControls;
  onOpenAgent: () => void;
}

/** The selected step: what happened, who ran it, and the actions that are safe right now. */
export function StepPanel({ chain, step, operation, controls, onOpenAgent }: StepPanelProps) {
  const id = useId();
  const [mode, setMode] = useState<Mode>(null);
  const [busy, setBusy] = useState<StepAction | null>(null);
  const [error, setError] = useState<string | null>(null);
  const meta = STEP_PHASE_META[step.phase];
  const route = stepRoute(operation);
  const actions = stepActions(step, chain);
  const IntentIcon = INTENT_ICON[step.intent];
  const report = step.report;
  // A phase change (the step moved on) closes a form that no longer applies.
  useEffect(() => {
    if (mode && !actions.includes(mode)) setMode(null);
  }, [mode, actions]);

  const act = async (kind: StepAction, action: () => Promise<unknown>) => {
    setBusy(kind);
    setError(null);
    try {
      await action();
      setMode(null);
    } catch (cause) {
      setError(toKalCodeError(cause).message);
    } finally {
      setBusy(null);
    }
  };

  const initialRoute: DraftRoute = {
    providerId: operation?.spec.providerId ?? "claude-code",
    providerAccountId: operation?.spec.providerAccountId ?? "",
    model: operation?.spec.model ?? "",
    effort: operation?.spec.effort ?? "",
  };

  return (
    <section className={styles.panel} data-step-panel={step.key} data-tone={meta.tone} aria-labelledby={`${id}-title`}>
      <div className={styles.panelHead}>
        <span className={styles.panelIcon} aria-hidden="true">
          <IntentIcon />
        </span>
        <h4 id={`${id}-title`} className={styles.panelTitle}>
          <span className="visually-hidden">
            Step {step.position + 1} of {chain.steps.length}:{" "}
          </span>
          {step.name}
          {step.name !== INTENT_LABEL[step.intent] ? (
            <span className={styles.panelIntent}> · {INTENT_LABEL[step.intent]}</span>
          ) : null}
        </h4>
        <span className={styles.phaseText} data-tone={meta.tone}>
          {meta.label}
        </span>
        {step.attempt > 1 ? <span className={styles.attempt}>Attempt {step.attempt}</span> : null}
        <span className={styles.panelRoute}>
          {route.providerId ? <ProviderGlyph provider={route.providerId} size="xs" /> : null}
          <span>
            {[
              route.providerName,
              route.accountLabel,
              route.model ?? "Provider default",
              route.effort ? effortLabel(route.effort) : null,
            ]
              .filter(Boolean)
              .join(" · ")}
          </span>
        </span>
      </div>

      {report ? (
        <div className={styles.report}>
          <p className={styles.reportSummary}>
            <span className={styles.reportSource}>{report.source === "you" ? "Recorded by you" : "Agent report"}</span>
            {report.summary}
          </p>
          {report.tests.length > 0 ? (
            <ul className={styles.tests} aria-label="Tests run">
              {report.tests.map((test) => (
                <li key={test.command} data-passed={test.passed}>
                  {test.passed ? <Check aria-hidden="true" /> : <X aria-hidden="true" />}
                  <code>{test.command}</code>
                  <span className="visually-hidden">{test.passed ? "passed" : "failed"}</span>
                </li>
              ))}
            </ul>
          ) : null}
          {report.blockers.length > 0 ? (
            <ul className={styles.blockers} aria-label="Blockers">
              {report.blockers.map((blocker) => (
                <li key={blocker}>{blocker}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : step.waitingReason ? (
        <p className={styles.reason}>{step.waitingReason}</p>
      ) : step.phase === "working" ? (
        <p className={styles.reason}>{operation?.currentAction ?? "The agent is working on this step."}</p>
      ) : step.phase === "needs_report" ? (
        <p className={styles.reason}>
          The agent finished without a step report. It may have asked a question: open it, or record the outcome.
        </p>
      ) : null}

      {actions.length > 0 ? (
        <div className={styles.stepActions}>
          {actions.includes("open") ? (
            <Button size="sm" variant="secondary" icon={<ExternalLink />} onClick={onOpenAgent}>
              Open agent
            </Button>
          ) : null}
          {actions.includes("record") ? (
            <Button
              size="sm"
              variant={step.phase === "needs_report" ? "primary" : "ghost"}
              icon={<Check />}
              aria-expanded={mode === "record"}
              disabled={busy !== null}
              onClick={() => setMode(mode === "record" ? null : "record")}
            >
              Record outcome
            </Button>
          ) : null}
          {actions.includes("retry") ? (
            <Button
              size="sm"
              variant={step.phase === "failed" ? "primary" : "secondary"}
              icon={<RotateCcw />}
              aria-expanded={mode === "retry"}
              disabled={busy !== null}
              onClick={() => setMode(mode === "retry" ? null : "retry")}
            >
              Retry
            </Button>
          ) : null}
          {actions.includes("reroute") ? (
            <Button
              size="sm"
              variant="ghost"
              icon={<Route />}
              aria-expanded={mode === "reroute"}
              disabled={busy !== null}
              onClick={() => setMode(mode === "reroute" ? null : "reroute")}
            >
              Change agent
            </Button>
          ) : null}
          {actions.includes("skip") ? (
            <Button
              size="sm"
              variant="ghost"
              icon={<SkipForward />}
              busy={busy === "skip"}
              disabled={busy !== null}
              onClick={() => void act("skip", () => controls.skipStep(chain.id, step.key))}
            >
              Skip
            </Button>
          ) : null}
        </div>
      ) : null}

      {mode === "record" ? (
        <RecordForm
          stepName={step.name}
          busy={busy === "record"}
          onCancel={() => setMode(null)}
          onSubmit={(result, summary) => act("record", () => controls.recordStep(chain.id, step.key, result, summary))}
        />
      ) : null}
      {mode === "retry" || mode === "reroute" ? (
        <RouteForm
          kind={mode}
          stepName={step.name}
          workspaceId={chain.workspaceId}
          initial={initialRoute}
          busy={busy === mode}
          onCancel={() => setMode(null)}
          onSubmit={(next) =>
            mode === "retry"
              ? act("retry", () => controls.retryStep(chain.id, step.key, next))
              : act("reroute", () => controls.rerouteStep(chain.id, step.key, next as ChainStepRoute))
          }
        />
      ) : null}

      {error ? (
        <p className={styles.error} role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}

function RecordForm({
  stepName,
  busy,
  onCancel,
  onSubmit,
}: {
  stepName: string;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (result: ChainStepResult, summary: string) => Promise<void>;
}) {
  const id = useId();
  const [result, setResult] = useState<ChainStepResult>("passed");
  const [summary, setSummary] = useState("");
  const [invalid, setInvalid] = useState(false);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!summary.trim()) {
      setInvalid(true);
      return;
    }
    void onSubmit(result, summary.trim());
  };
  return (
    <form className={styles.form} onSubmit={submit} aria-label={`Record the outcome of ${stepName}`}>
      <span className={styles.formLabel} id={`${id}-result`}>
        Outcome
      </span>
      <SegmentedControl
        value={result}
        options={OUTCOMES}
        onValueChange={setResult}
        aria-labelledby={`${id}-result`}
        disabled={busy}
      />
      <label className={styles.formLabel} htmlFor={`${id}-summary`}>
        Summary
      </label>
      <TextArea
        id={`${id}-summary`}
        className={styles.summaryInput}
        value={summary}
        maxLength={8_000}
        placeholder="What the agent did, what you checked, and anything left to do"
        disabled={busy}
        aria-invalid={invalid || undefined}
        aria-describedby={invalid ? `${id}-summary-error` : undefined}
        onChange={(event) => {
          setSummary(event.target.value);
          if (invalid) setInvalid(false);
        }}
      />
      {invalid ? (
        <p id={`${id}-summary-error`} className={styles.fieldError} role="alert">
          Add a short summary so the next step knows what happened.
        </p>
      ) : null}
      <div className={styles.formActions}>
        <Button size="sm" variant="ghost" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
        <Button size="sm" variant="primary" type="submit" icon={<Check />} busy={busy}>
          Record outcome
        </Button>
      </div>
    </form>
  );
}

function RouteForm({
  kind,
  stepName,
  workspaceId,
  initial,
  busy,
  onCancel,
  onSubmit,
}: {
  kind: "retry" | "reroute";
  stepName: string;
  workspaceId: string;
  initial: DraftRoute;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (route: ChainStepRoute | null) => Promise<void>;
}) {
  const options = useRouteOptions();
  const [route, setRoute] = useState<DraftRoute>(() =>
    initial.providerAccountId ? initial : options.defaultRoute(workspaceId, initial),
  );
  const [error, setError] = useState<string | null>(null);
  const changed =
    route.providerId !== initial.providerId ||
    route.providerAccountId !== initial.providerAccountId ||
    route.model !== initial.model ||
    route.effort !== initial.effort;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    // Retry on the same agent sends no route; a changed route is resolved to exact values first.
    if (kind === "retry" && !changed) {
      void onSubmit(null);
      return;
    }
    const resolved = resolveRoute(route, options);
    if ("error" in resolved) {
      setError(resolved.error);
      return;
    }
    setError(null);
    void onSubmit(resolved.route);
  };
  return (
    <form
      className={styles.form}
      onSubmit={submit}
      aria-label={kind === "retry" ? `Retry ${stepName}` : `Change the agent for ${stepName}`}
    >
      <p className={styles.formHint}>
        {kind === "retry"
          ? "A new attempt starts in the same worktree. Keep the same agent or choose another."
          : "Choose who runs this step. It has not started, so nothing is interrupted."}
      </p>
      <RoutePicker
        route={route}
        onChange={(next) => {
          setRoute(next);
          setError(null);
        }}
        options={options}
        label={`${stepName} agent`}
        disabled={busy}
        defaultOpen={kind === "reroute"}
      />
      {error ? (
        <p className={styles.fieldError} role="alert">
          {error}
        </p>
      ) : null}
      <div className={styles.formActions}>
        <Button size="sm" variant="ghost" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
        <Button
          size="sm"
          variant="primary"
          type="submit"
          icon={kind === "retry" ? <RotateCcw /> : <Route />}
          busy={busy}
          disabled={kind === "reroute" && !changed}
        >
          {kind === "retry" ? (changed ? "Retry on this agent" : "Retry step") : "Use this agent"}
        </Button>
      </div>
    </form>
  );
}
