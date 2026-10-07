import type { Chain, ChainStepIntent, ChainStepRoute, ChainWorktree, ThreadSummary } from "@kalcode/protocol";
import { Button, IconButton, SegmentedControl, TextArea, TextInput } from "@kalcode/ui/components";
import { ArrowDown, ArrowUp, GitFork, Link2, Plus, Sparkles, X } from "lucide-react";
import { type FormEvent, type KeyboardEvent, useEffect, useId, useMemo, useRef, useState } from "react";
import { toKalCodeError } from "../../ipc/errors.ts";
import { useOptionalChains } from "../../runtime/chains/useChains.tsx";
import styles from "./ChainComposer.module.css";
import { INTENT_ICON } from "./ChainRail.tsx";
import {
  buildStartRequest,
  type DraftIssue,
  type DraftRoute,
  type DraftStep,
  draftLevels,
  draftNames,
  draftStepId,
  INTENT_LABEL,
  INTENTS,
  MAX_ACCEPTANCE,
  MAX_STEPS,
  PRESETS,
  presetSteps,
  requestFingerprint,
  suggestName,
  validateDraft,
  WRITER_INTENTS,
} from "./model.ts";
import { RoutePicker } from "./RoutePicker.tsx";
import { resolveRoute, useRouteOptions } from "./routeOptions.ts";

const INTENT_OPTIONS = INTENTS.map((intent) => ({ value: intent, label: INTENT_LABEL[intent] }));

const WORKTREE_OPTIONS: readonly { value: ChainWorktree; label: string }[] = [
  { value: "shared", label: "Shared worktree" },
  { value: "project", label: "Project checkout" },
];

const WORKTREE_HELP: Record<ChainWorktree, string> = {
  shared:
    "KalCode creates one worktree and branch for the chain; every step sees the exact work before it, uncommitted changes included.",
  project: "Every step runs in the project's own checkout.",
};

export interface ChainComposerProps {
  workspaceId: string | null;
  /** The agent the chain was started from: step 1 reviews its work, routes default to it. */
  source?: ThreadSummary | null;
  /** The plan includes chains (MAX and above); the host shows the plan boundary. */
  featureAvailable: boolean;
  onStarted: (chain: Chain) => void;
  onCancel?: () => void;
  /** Rendered inside another dialog's tab (no own footer chrome). */
  embedded?: boolean;
}

/** Fields that show their message only after the person tried to start. */
const SUBMIT_ONLY = new Set(["goal", "name"]);

/**
 * Start a handoff chain. The common case needs no choices: the goal (prefilled from the source
 * agent), a preset, and every step on the remembered or current agent's configuration. Everything
 * else (acceptance criteria, worktree, per-step agent, instructions, parallel branches) is there
 * when needed. Validation mirrors native `chains_start` with clear inline messages.
 */
export function ChainComposer({
  workspaceId,
  source = null,
  featureAvailable,
  onStarted,
  onCancel,
  embedded = false,
}: ChainComposerProps) {
  const id = useId();
  const chains = useOptionalChains();
  const options = useRouteOptions();
  const formRef = useRef<HTMLFormElement>(null);
  const [goal, setGoal] = useState(() =>
    source
      ? `Review the work in ${source.name}${source.branch ? ` (${source.branch})` : ""} and fix what the review finds.`
      : "",
  );
  const [name, setName] = useState("");
  const [nameTouched, setNameTouched] = useState(false);
  const [acceptance, setAcceptance] = useState<{ id: string; text: string }[]>([]);
  const [worktree, setWorktree] = useState<ChainWorktree>("shared");
  const [presetId, setPresetId] = useState<string | null>(source ? "review-fix" : "full");
  const [steps, setSteps] = useState<DraftStep[]>(() =>
    presetSteps(PRESETS.find((p) => p.id === (source ? "review-fix" : "full")) ?? (PRESETS[0] as (typeof PRESETS)[0])),
  );
  const [instructionsOpen, setInstructionsOpen] = useState<ReadonlySet<string>>(new Set());
  const [attempted, setAttempted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [routeErrors, setRouteErrors] = useState<ReadonlyMap<string, string>>(new Map());
  const request = useRef<{ fingerprint: string; id: string } | null>(null);
  // A start still finishes natively if the composer closes meanwhile, but a closed composer
  // never navigates or updates state afterwards.
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );

  const chainName = nameTouched ? name : suggestName(goal);
  const seed = useMemo<Partial<DraftRoute> | null>(
    () =>
      source
        ? {
            providerId: source.providerId,
            providerAccountId: source.providerAccountId ?? "",
            model: source.model ?? "",
            effort: source.effort ?? "",
          }
        : null,
    [source],
  );
  const fallbackRoute = options.defaultRoute(workspaceId ?? "", seed);
  const effective = steps.map((step) => ({ ...step, route: step.route ?? fallbackRoute }));
  const names = draftNames(steps);
  const levels = draftLevels(steps);
  // A chain started from an agent continues where that agent's work is: its own worktree, or
  // the project checkout. Native resolves the same rule from `sourceThreadId`.
  const chainWorktree: ChainWorktree = source ? (source.worktreeId ? "shared" : "project") : worktree;
  const issues = validateDraft({
    name: chainName,
    goal,
    worktree: chainWorktree,
    acceptance: acceptance.map((item) => item.text),
    existingWorktree: Boolean(source?.worktreeId),
    steps: effective,
  });
  const visibleIssues = issues.filter(
    (issue) => attempted || (!SUBMIT_ONLY.has(issue.field) && !issue.message.startsWith("Choose an account")),
  );
  const issueFor = (field: string) => visibleIssues.find((issue) => issue.field === field)?.message ?? null;
  const stepsIssue = issueFor("steps");

  const update = (rowId: string, patch: Partial<DraftStep>) => {
    setSteps((current) => current.map((step) => (step.id === rowId ? { ...step, ...patch } : step)));
    setPresetId(null);
    setError(null);
  };
  const move = (index: number, delta: number) => {
    setSteps((current) => {
      const next = [...current];
      const target = index + delta;
      if (target < 0 || target >= next.length) return current;
      [next[index], next[target]] = [next[target] as DraftStep, next[index] as DraftStep];
      // The first step can never run alongside a previous one.
      if (next[0]?.parallel) next[0] = { ...next[0], parallel: false };
      return next;
    });
    setPresetId(null);
  };
  const remove = (rowId: string) => {
    setSteps((current) => {
      const next = current.filter((step) => step.id !== rowId);
      if (next[0]?.parallel) next[0] = { ...next[0], parallel: false };
      return next;
    });
    setPresetId(null);
  };
  const addStep = () => {
    const last = steps[steps.length - 1];
    const intent: ChainStepIntent = !last
      ? "implement"
      : last.intent === "implement"
        ? "review"
        : last.intent === "review"
          ? "fix"
          : last.intent === "fix"
            ? "test"
            : "review";
    setSteps((current) => [
      ...current,
      { id: draftStepId(), intent, instructions: "", parallel: false, route: last?.route ? { ...last.route } : null },
    ]);
    setPresetId(null);
  };
  const applyPreset = (presetKey: string) => {
    const preset = PRESETS.find((p) => p.id === presetKey);
    if (!preset) return;
    setSteps(presetSteps(preset));
    setPresetId(preset.id);
    setInstructionsOpen(new Set());
    setRouteErrors(new Map());
    setError(null);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setAttempted(true);
    setError(null);
    if (!featureAvailable) return;
    if (!chains) {
      setError("Chains are not available in this window. Reload KalCode and try again.");
      return;
    }
    if (!workspaceId) {
      setError("Open a project first: a chain runs in one project.");
      return;
    }
    if (issues.length > 0) {
      focusFirstIssue(formRef.current, issues, id);
      return;
    }
    const resolved: ChainStepRoute[] = [];
    const nextRouteErrors = new Map<string, string>();
    for (const step of effective) {
      const result = resolveRoute(step.route as DraftRoute, options);
      if ("error" in result) nextRouteErrors.set(step.id, result.error);
      else resolved.push(result.route);
    }
    setRouteErrors(nextRouteErrors);
    if (nextRouteErrors.size > 0) return;
    const payload = {
      workspaceId,
      name: chainName,
      goal,
      acceptance: acceptance.map((item) => item.text),
      worktree: chainWorktree,
      sourceThreadId: source?.id ?? null,
      steps: effective.map((step, index) => ({
        intent: step.intent,
        instructions: step.instructions,
        parallel: step.parallel,
        route: resolved[index] as ChainStepRoute,
      })),
    };
    const draft = buildStartRequest({ ...payload, requestId: "" });
    const { requestId: _unused, ...rest } = draft;
    const fingerprint = requestFingerprint(rest);
    // A retry of the same draft reuses its request id (native start is idempotent by it).
    if (request.current?.fingerprint !== fingerprint) request.current = { fingerprint, id: crypto.randomUUID() };
    setBusy(true);
    try {
      const chain = await chains.start({ ...draft, requestId: request.current.id });
      request.current = null;
      if (mounted.current) onStarted(chain);
    } catch (cause) {
      if (mounted.current) setError(toKalCodeError(cause).message);
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  const onFormKey = (event: KeyboardEvent<HTMLFormElement>) => {
    if (event.key !== "Enter") return;
    const target = event.target as HTMLElement;
    if (event.metaKey || event.ctrlKey) {
      event.preventDefault();
      formRef.current?.requestSubmit();
      return;
    }
    // Plain Enter in a one-line field never starts a chain by accident.
    if (target instanceof HTMLInputElement && target.type !== "checkbox") event.preventDefault();
  };

  return (
    <form
      ref={formRef}
      className={styles.composer}
      data-embedded={embedded || undefined}
      onSubmit={submit}
      onKeyDown={onFormKey}
      aria-label="New handoff chain"
      noValidate
    >
      <div className={styles.field}>
        <label className={styles.label} htmlFor={`${id}-goal`}>
          Goal
        </label>
        <TextArea
          id={`${id}-goal`}
          className={styles.goal}
          value={goal}
          maxLength={16_000}
          placeholder="What should the chain deliver? Every step receives this, so no one re-explains it."
          disabled={busy}
          aria-invalid={issueFor("goal") ? true : undefined}
          aria-describedby={issueFor("goal") ? `${id}-goal-error` : undefined}
          onChange={(event) => {
            setGoal(event.target.value);
            setError(null);
          }}
        />
        {issueFor("goal") ? (
          <p id={`${id}-goal-error`} className={styles.fieldError}>
            {issueFor("goal")}
          </p>
        ) : null}
      </div>

      <div className={styles.split}>
        <div className={styles.field}>
          <label className={styles.label} htmlFor={`${id}-name`}>
            Name
            {!nameTouched && chainName ? (
              <span className={styles.auto} aria-hidden="true">
                <Sparkles aria-hidden="true" />
                From the goal
              </span>
            ) : null}
          </label>
          <TextInput
            id={`${id}-name`}
            value={chainName}
            maxLength={120}
            placeholder="Named from the goal"
            disabled={busy}
            aria-invalid={issueFor("name") ? true : undefined}
            aria-describedby={issueFor("name") ? `${id}-name-error` : undefined}
            onChange={(event) => {
              setNameTouched(true);
              setName(event.target.value);
            }}
          />
          {issueFor("name") ? (
            <p id={`${id}-name-error`} className={styles.fieldError}>
              {issueFor("name")}
            </p>
          ) : null}
        </div>
        <div className={styles.field}>
          <span className={styles.label} id={`${id}-worktree`}>
            Where steps work
          </span>
          {source ? (
            <p className={styles.hint} id={`${id}-worktree-note`}>
              {source.worktreeId
                ? `Continues in ${source.name}'s worktree${source.branch ? ` (${source.branch})` : ""}, so every step sees its work, uncommitted changes included.`
                : `Continues in the project checkout, where ${source.name} works.`}
            </p>
          ) : (
            <>
              <SegmentedControl
                value={worktree}
                options={WORKTREE_OPTIONS}
                onValueChange={setWorktree}
                aria-labelledby={`${id}-worktree`}
                disabled={busy}
              />
              <p className={styles.hint}>{WORKTREE_HELP[worktree]}</p>
            </>
          )}
        </div>
      </div>

      <div className={styles.field}>
        <div className={styles.labelRow}>
          <span className={styles.label} id={`${id}-acceptance`}>
            Acceptance criteria <span className={styles.optional}>Optional</span>
          </span>
        </div>
        {acceptance.length > 0 ? (
          <ul className={styles.criteria} aria-labelledby={`${id}-acceptance`}>
            {acceptance.map((item, index) => (
              <li key={item.id} className={styles.criterion}>
                <span className={styles.criterionMark} aria-hidden="true" />
                <TextInput
                  value={item.text}
                  maxLength={500}
                  aria-label={`Acceptance criterion ${index + 1}`}
                  placeholder="A check every step can verify"
                  disabled={busy}
                  autoFocus={index === acceptance.length - 1 && item.text === ""}
                  onChange={(event) =>
                    setAcceptance((current) =>
                      current.map((entry) => (entry.id === item.id ? { ...entry, text: event.target.value } : entry)),
                    )
                  }
                  onKeyDown={(event) => {
                    if (
                      event.key === "Enter" &&
                      !event.ctrlKey &&
                      !event.metaKey &&
                      item.text.trim() &&
                      acceptance.length < MAX_ACCEPTANCE
                    ) {
                      event.preventDefault();
                      setAcceptance((current) => [...current, { id: draftStepId(), text: "" }]);
                    }
                  }}
                />
                <IconButton
                  size="sm"
                  label={`Remove acceptance criterion ${index + 1}`}
                  icon={<X />}
                  disabled={busy}
                  onClick={() => setAcceptance((current) => current.filter((entry) => entry.id !== item.id))}
                />
              </li>
            ))}
          </ul>
        ) : null}
        <Button
          size="sm"
          variant="ghost"
          className={styles.addLink}
          icon={<Plus />}
          disabled={busy || acceptance.length >= MAX_ACCEPTANCE}
          onClick={() => setAcceptance((current) => [...current, { id: draftStepId(), text: "" }])}
        >
          Add criterion
        </Button>
      </div>

      <section className={styles.steps} aria-labelledby={`${id}-steps`}>
        <div className={styles.stepsHead}>
          <h3 className={styles.stepsTitle} id={`${id}-steps`}>
            Steps
          </h3>
          {/* biome-ignore lint/a11y/useSemanticElements: a labelled group of preset buttons. */}
          <div className={styles.presets} role="group" aria-label="Presets">
            {PRESETS.map((preset) => (
              <button
                key={preset.id}
                type="button"
                className={styles.preset}
                aria-pressed={presetId === preset.id}
                disabled={busy}
                onClick={() => applyPreset(preset.id)}
              >
                {preset.label}
              </button>
            ))}
          </div>
        </div>

        <ol className={styles.stepList}>
          {steps.map((step, index) => {
            const n = index + 1;
            const name = names[index] as string;
            const Icon = INTENT_ICON[step.intent];
            const rowIssue = issueFor(step.id) ?? routeErrors.get(step.id) ?? null;
            const showInstructions = instructionsOpen.has(step.id) || step.instructions.length > 0;
            const route = step.route ?? fallbackRoute;
            const alongside = steps[index - 1];
            return (
              <li
                key={step.id}
                className={styles.step}
                data-parallel={step.parallel || undefined}
                data-writer={WRITER_INTENTS.has(step.intent) || undefined}
                data-level={levels[index]}
                data-invalid={rowIssue ? true : undefined}
                aria-label={`Step ${n}: ${name}`}
              >
                <span className={styles.stepMarker} aria-hidden="true">
                  <span className={styles.stepIndex}>{step.parallel ? <GitFork /> : n}</span>
                  <span className={styles.spine} />
                </span>
                <div className={styles.stepBody}>
                  <div className={styles.stepTop}>
                    <span className={styles.stepName}>
                      <Icon aria-hidden="true" />
                      {name}
                    </span>
                    <div className={styles.stepTools}>
                      <IconButton
                        size="sm"
                        label={`Move step ${n} up`}
                        icon={<ArrowUp />}
                        disabled={busy || index === 0}
                        onClick={() => move(index, -1)}
                      />
                      <IconButton
                        size="sm"
                        label={`Move step ${n} down`}
                        icon={<ArrowDown />}
                        disabled={busy || index === steps.length - 1}
                        onClick={() => move(index, 1)}
                      />
                      <IconButton
                        size="sm"
                        label={`Remove step ${n}`}
                        icon={<X />}
                        disabled={busy || steps.length === 1}
                        onClick={() => remove(step.id)}
                      />
                    </div>
                  </div>
                  <SegmentedControl
                    className={styles.intents}
                    value={step.intent}
                    options={INTENT_OPTIONS}
                    onValueChange={(intent) => update(step.id, { intent })}
                    aria-label={`Step ${n} task`}
                    disabled={busy}
                  />
                  <RoutePicker
                    route={route}
                    options={options}
                    label={`Step ${n} agent`}
                    disabled={busy}
                    invalid={Boolean(routeErrors.get(step.id))}
                    onChange={(next) => {
                      update(step.id, { route: next });
                      setRouteErrors((current) => {
                        if (!current.has(step.id)) return current;
                        const copy = new Map(current);
                        copy.delete(step.id);
                        return copy;
                      });
                    }}
                  />
                  {showInstructions ? (
                    <TextArea
                      className={styles.instructions}
                      aria-label={`Step ${n} instructions`}
                      value={step.instructions}
                      maxLength={8_000}
                      placeholder={`Anything specific for ${name}? It follows the goal and earlier steps' reports.`}
                      disabled={busy}
                      autoFocus={instructionsOpen.has(step.id) && step.instructions === ""}
                      onChange={(event) => update(step.id, { instructions: event.target.value })}
                    />
                  ) : null}
                  <div className={styles.stepOptions}>
                    {showInstructions ? null : (
                      <button
                        type="button"
                        className={styles.linkButton}
                        disabled={busy}
                        onClick={() => setInstructionsOpen((current) => new Set(current).add(step.id))}
                      >
                        <Plus aria-hidden="true" />
                        Instructions
                      </button>
                    )}
                    {index > 0 && alongside ? (
                      <label className={styles.toggle}>
                        <input
                          type="checkbox"
                          checked={step.parallel}
                          disabled={busy}
                          onChange={(event) => update(step.id, { parallel: event.target.checked })}
                        />
                        <span className={styles.toggleTrack} aria-hidden="true" />
                        Runs alongside {names[index - 1]}
                      </label>
                    ) : null}
                  </div>
                  {rowIssue ? (
                    <p className={styles.fieldError} data-step-issue={step.id}>
                      {rowIssue}
                    </p>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ol>
        <div className={styles.stepsFoot}>
          <Button
            size="sm"
            variant="ghost"
            icon={<Plus />}
            disabled={busy || steps.length >= MAX_STEPS}
            onClick={addStep}
          >
            Add step
          </Button>
          {stepsIssue ? <p className={styles.fieldError}>{stepsIssue}</p> : null}
        </div>
      </section>

      {error ? (
        <p className={styles.error} role="alert">
          {error}
        </p>
      ) : null}

      <div className={styles.footer}>
        <p className={styles.footHint}>
          <kbd>Ctrl</kbd>
          <kbd>↵</kbd> start
        </p>
        <div className={styles.footActions}>
          {onCancel ? (
            <Button variant="ghost" disabled={busy} onClick={onCancel}>
              Cancel
            </Button>
          ) : null}
          <Button type="submit" variant="primary" icon={<Link2 />} busy={busy} disabled={!featureAvailable}>
            Start chain
          </Button>
        </div>
      </div>
    </form>
  );
}

function focusFirstIssue(form: HTMLFormElement | null, issues: readonly DraftIssue[], id: string) {
  const first = issues[0];
  if (!form || !first) return;
  requestAnimationFrame(() => {
    const target =
      first.field === "goal" || first.field === "name"
        ? form.querySelector<HTMLElement>(`#${CSS.escape(`${id}-${first.field}`)}`)
        : form.querySelector<HTMLElement>(`[data-step-issue="${CSS.escape(first.field)}"]`);
    target?.scrollIntoView?.({ block: "nearest" });
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) target.focus();
  });
}
