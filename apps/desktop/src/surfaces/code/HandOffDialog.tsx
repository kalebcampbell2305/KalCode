import {
  featureIncluded,
  type HandoffCompletion,
  type HandoffPreview,
  type HandoffRecord,
  type HandoffStatus,
  type HandoffTask,
  type ThreadSummary,
} from "@kalcode/protocol";
import { Badge, Button, Field, ProviderGlyph, SegmentedControl, TextArea } from "@kalcode/ui/components";
import {
  ArrowLeft,
  ArrowRight,
  Bot,
  Check,
  ExternalLink,
  Handshake,
  Plus,
  RefreshCw,
  RotateCcw,
  Send,
} from "lucide-react";
import { Dialog } from "radix-ui";
import { type FormEvent, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { useOptionalAccount } from "../../account/AccountProvider.tsx";
import { planTier } from "../../ipc/account.ts";
import { toKalCodeError } from "../../ipc/errors.ts";
import { useRuntime } from "../../runtime/RuntimeProvider.tsx";
import { useOptionalUiIntents } from "../../runtime/uiIntents.tsx";
import { HUB_SECTIONS } from "../../shell/AccountHub.tsx";
import { useNavigation } from "../../shell/navigation.tsx";
import { useCodingAgents } from "../dashboard/data/DashboardData.tsx";
import { STATUS_META } from "../dashboard/data/status.ts";
import { fleetHandles } from "../dashboard/fleet/fleetModel.ts";
import { focusSection } from "../dashboard/useNow.ts";
import styles from "./HandOffDialog.module.css";

const TASK_OPTIONS: readonly { value: HandoffTask; label: string }[] = [
  { value: "review", label: "Review" },
  { value: "test", label: "Test" },
  { value: "fix", label: "Fix" },
  { value: "continue", label: "Continue" },
];

const TASK_HELP: Record<HandoffTask, string> = {
  review: "Inspect the exact changes and report findings. Editing stays with the sender.",
  test: "Run focused checks and report the evidence. Editing stays with the sender.",
  fix: "Take editing responsibility for the described issue. KalCode verifies that the target can work safely.",
  continue: "Continue the work from the prepared context. KalCode verifies that ownership can transfer safely.",
};

const STATUS_LABEL: Record<HandoffStatus, string> = {
  queued: "Queued",
  delivered: "Delivered",
  working: "Agent working",
  needs_you: "Needs you",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
  interrupted: "Interrupted",
};

const STATUS_TONE: Record<HandoffStatus, "neutral" | "accent" | "success" | "waiting" | "danger" | "outline"> = {
  queued: "neutral",
  delivered: "accent",
  working: "accent",
  needs_you: "waiting",
  completed: "success",
  failed: "danger",
  cancelled: "outline",
  interrupted: "danger",
};

interface PreviewDraft {
  sourceThreadId: string;
  targetThreadId: string;
  task: HandoffTask;
  instructions: string;
}

export interface HandOffDialogProps {
  open: boolean;
  source: ThreadSummary;
  preferredTargetId?: string | null;
  onNewAgent: () => void;
  onClose: () => void;
}

/**
 * One governed, inspectable handoff flow for a real coding-agent terminal. Native owns eligibility,
 * delivery and durable outcomes; the UI never writes into a provider terminal directly.
 */
export function HandOffDialog({ open, source, preferredTargetId, onNewAgent, onClose }: HandOffDialogProps) {
  const { client } = useRuntime();
  const account = useOptionalAccount();
  const { navigate } = useNavigation();
  const uiIntents = useOptionalUiIntents();
  const codingAgents = useCodingAgents();
  const id = useId();
  const [targetId, setTargetId] = useState("");
  const [task, setTask] = useState<HandoffTask>("review");
  const [instructions, setInstructions] = useState("");
  const [preview, setPreview] = useState<HandoffPreview | null>(null);
  const [previewDraft, setPreviewDraft] = useState<PreviewDraft | null>(null);
  const [previewText, setPreviewText] = useState("");
  const [busy, setBusy] = useState<"preview" | "send" | "return" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [records, setRecords] = useState<HandoffRecord[]>([]);
  const [recordsState, setRecordsState] = useState<"loading" | "ready" | "error">("loading");
  const [recordsError, setRecordsError] = useState<string | null>(null);
  const recordsRequest = useRef(0);
  const featureAvailable = account ? featureIncluded(planTier(account.snapshot), "provider_handoff") : true;

  const allAgents = codingAgents.state.status === "ready" ? codingAgents.state.data : [];
  const recipients = useMemo(() => allAgents.filter((agent) => agent.id !== source.id), [allAgents, source.id]);
  const handles = useMemo(() => fleetHandles(allAgents), [allAgents]);
  const selectedTarget = recipients.find((agent) => agent.id === targetId) ?? null;
  const staleTarget = targetId.length > 0 && selectedTarget === null;

  useEffect(() => {
    if (!preferredTargetId) return;
    setTargetId(preferredTargetId);
    setPreview(null);
    setPreviewDraft(null);
    setNotice("New agent opened. Review the handoff before sending it.");
    codingAgents.reload();
  }, [preferredTargetId, codingAgents.reload]);

  const loadRecords = useCallback(
    async (quiet = false) => {
      const request = ++recordsRequest.current;
      if (!quiet) setRecordsState("loading");
      try {
        const next = await client.handoffs.list(source.id);
        if (request !== recordsRequest.current) return;
        setRecords([...next].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
        setRecordsState("ready");
        setRecordsError(null);
      } catch (cause) {
        if (request !== recordsRequest.current) return;
        setRecordsError(toKalCodeError(cause).message);
        setRecordsState(quiet && records.length > 0 ? "ready" : "error");
      }
    },
    [client, records.length, source.id],
  );

  useEffect(() => {
    if (!open) {
      recordsRequest.current += 1;
      return;
    }
    void loadRecords();
    const timer = window.setInterval(() => void loadRecords(true), 2_500);
    return () => {
      window.clearInterval(timer);
      recordsRequest.current += 1;
    };
  }, [open, loadRecords]);

  const prepare = async (draft: PreviewDraft, editedText?: string, priorPreviewId?: string) => {
    setBusy("preview");
    setError(null);
    setNotice(null);
    try {
      const next = await client.handoffs.preview({ ...draft, editedText, priorPreviewId });
      setPreview(next);
      setPreviewDraft(draft);
      setPreviewText(next.text);
    } catch (cause) {
      setError(toKalCodeError(cause).message);
    } finally {
      setBusy(null);
    }
  };

  const prepareCurrent = () => {
    if (!featureAvailable) {
      setError("Agent handoff is included with Pro and above.");
      return;
    }
    if (!selectedTarget) {
      setError(staleTarget ? "That agent is no longer available. Choose another recipient." : "Choose a recipient.");
      return;
    }
    void prepare({
      sourceThreadId: source.id,
      targetThreadId: selectedTarget.id,
      task,
      instructions: instructions.trim(),
    });
  };

  const previewChanged = preview !== null && previewText !== preview.text;
  const send = async () => {
    if (!preview || previewChanged) return;
    setBusy("send");
    setError(null);
    setNotice(null);
    try {
      const record = await client.handoffs.send(preview.id, preview.previewHash);
      setPreview(null);
      setPreviewDraft(null);
      setPreviewText("");
      if (record.status === "queued") {
        setNotice(`Queued for ${record.targetName}. KalCode will deliver it when the agent is ready.`);
      } else if (record.status === "delivered" || record.status === "working" || record.status === "needs_you") {
        setNotice(`Delivered to ${record.targetName}.`);
      } else if (record.status === "failed" || record.status === "interrupted") {
        setError(record.blocker ?? `The handoff ${STATUS_LABEL[record.status].toLowerCase()} before delivery.`);
      } else {
        setNotice(`Handoff is ${STATUS_LABEL[record.status].toLowerCase()}.`);
      }
      await loadRecords(true);
    } catch (cause) {
      setError(toKalCodeError(cause).message);
    } finally {
      setBusy(null);
    }
  };

  const beginReturn = async (record: HandoffRecord) => {
    setBusy("return");
    setError(null);
    setNotice(null);
    try {
      const next = await client.handoffs.returnFindings(record.id);
      const draft = {
        sourceThreadId: next.sourceThreadId,
        targetThreadId: next.targetThreadId,
        task: next.task,
        instructions: "",
      };
      setTargetId(next.targetThreadId);
      setTask(next.task);
      setPreview(next);
      setPreviewDraft(draft);
      setPreviewText(next.text);
    } catch (cause) {
      setError(toKalCodeError(cause).message);
    } finally {
      setBusy(null);
    }
  };

  const openAgent = (threadId: string, workspaceId: string) => {
    if (!uiIntents) return;
    onClose();
    void uiIntents.focus({ kind: "agent", agentId: threadId, workspaceId });
  };

  const resetPreview = () => {
    setPreview(null);
    setPreviewDraft(null);
    setPreviewText("");
    setError(null);
  };

  return (
    <Dialog.Root open={open} onOpenChange={(next) => (next || busy ? undefined : onClose())}>
      <Dialog.Portal>
        <Dialog.Overlay className={styles.overlay} />
        <Dialog.Content className={styles.dialog} aria-describedby={`${id}-description`}>
          <div className={styles.head}>
            <span className={styles.headIcon} aria-hidden="true">
              <Handshake />
            </span>
            <div className={styles.headCopy}>
              <Dialog.Title className={styles.title}>Hand off</Dialog.Title>
              <Dialog.Description id={`${id}-description`} className={styles.description}>
                Pass focused work from <strong>{source.name}</strong> to another coding agent.
              </Dialog.Description>
            </div>
            <Dialog.Close asChild>
              <Button size="sm" variant="ghost" disabled={busy !== null}>
                Close
              </Button>
            </Dialog.Close>
          </div>

          {!featureAvailable ? (
            <div className={styles.planGate} role="note">
              <span>
                <Badge tone="accent">Pro</Badge>
                Agent handoff is included with Pro and above.
              </span>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  onClose();
                  navigate("settings");
                  requestAnimationFrame(() => requestAnimationFrame(() => focusSection(HUB_SECTIONS.account)));
                }}
              >
                View plans
              </Button>
            </div>
          ) : null}

          {preview ? (
            <section className={styles.preview} aria-labelledby={`${id}-preview-title`}>
              <div className={styles.sectionHead}>
                <div>
                  <h2 id={`${id}-preview-title`}>Review the handoff</h2>
                  <p>
                    {preview.task[0]?.toUpperCase() + preview.task.slice(1)} for{" "}
                    <strong>{selectedTarget?.name ?? "the receiving agent"}</strong>. Nothing is delivered until you
                    send it.
                  </p>
                </div>
                <Button size="sm" variant="ghost" icon={<ArrowLeft />} onClick={resetPreview} disabled={busy !== null}>
                  Back
                </Button>
              </div>

              <Field
                htmlFor={`${id}-preview-text`}
                label="Prepared context"
                hint="Review exactly what will be sent. Sensitive text is checked before delivery."
              >
                <TextArea
                  id={`${id}-preview-text`}
                  className={styles.contextText}
                  value={previewText}
                  disabled={busy !== null}
                  onChange={(event) => setPreviewText(event.target.value)}
                  aria-describedby={`${id}-preview-text-hint`}
                />
              </Field>

              <fieldset className={styles.gitFacts}>
                <legend className="visually-hidden">Source state</legend>
                <span>{preview.sourceBranch ? `Branch ${preview.sourceBranch}` : "Branch not reported"}</span>
                <span>{preview.sourceCommit ? preview.sourceCommit.slice(0, 12) : "Commit not reported"}</span>
                <Badge tone={preview.sourceDirty ? "waiting" : "outline"}>
                  {preview.sourceDirty
                    ? "Uncommitted changes"
                    : preview.sourceCommit
                      ? "Clean source"
                      : "Source state not reported"}
                </Badge>
              </fieldset>

              {preview.warnings.length > 0 ? (
                <div className={styles.warnings} role="status">
                  {preview.warnings.map((warning) => (
                    <p key={warning}>{warning}</p>
                  ))}
                </div>
              ) : null}

              <div className={styles.actions}>
                {previewChanged ? (
                  <Button
                    variant="primary"
                    icon={<RefreshCw />}
                    busy={busy === "preview"}
                    disabled={!previewDraft || previewText.trim().length === 0 || busy !== null}
                    onClick={() => previewDraft && void prepare(previewDraft, previewText, preview.id)}
                  >
                    Update preview
                  </Button>
                ) : (
                  <Button
                    variant="primary"
                    icon={<Send />}
                    busy={busy === "send"}
                    disabled={previewText.trim().length === 0 || busy !== null}
                    onClick={() => void send()}
                  >
                    Send handoff
                  </Button>
                )}
              </div>
            </section>
          ) : (
            <section className={styles.compose} aria-labelledby={`${id}-compose-title`}>
              <div className={styles.sectionHead}>
                <div>
                  <h2 id={`${id}-compose-title`}>Choose a recipient</h2>
                  <p>Only real coding-agent terminals are shown.</p>
                </div>
                <Button size="sm" variant="ghost" icon={<Plus />} onClick={onNewAgent} disabled={busy !== null}>
                  New agent…
                </Button>
              </div>

              {codingAgents.state.status === "loading" ? (
                <div className={styles.agentLoading} role="status" aria-label="Loading coding agents">
                  <span />
                  <span />
                </div>
              ) : codingAgents.state.status === "error" ? (
                <div className={styles.inlineError} role="alert">
                  <span>{codingAgents.state.error.message}</span>
                  <Button size="sm" variant="ghost" onClick={codingAgents.reload}>
                    Try again
                  </Button>
                </div>
              ) : recipients.length === 0 ? (
                <div className={styles.emptyRecipients}>
                  <Bot aria-hidden="true" />
                  <span>Launch another coding agent to receive this handoff.</span>
                </div>
              ) : (
                <fieldset className={styles.recipientList}>
                  <legend className="visually-hidden">Handoff recipient</legend>
                  {recipients.map((agent) => {
                    const selected = agent.id === targetId;
                    const status = STATUS_META[agent.status];
                    return (
                      <label key={agent.id} className={styles.recipient} data-selected={selected || undefined}>
                        <input
                          className="visually-hidden"
                          type="radio"
                          name={`${id}-recipient`}
                          value={agent.id}
                          checked={selected}
                          onChange={() => {
                            setTargetId(agent.id);
                            setError(null);
                          }}
                        />
                        <ProviderGlyph provider={agent.providerId} size="sm" />
                        <span className={styles.recipientCopy}>
                          <span className={styles.recipientName}>
                            {handles.get(agent.id) ?? agent.name}
                            {agent.name !== handles.get(agent.id) ? <span>{agent.name}</span> : null}
                          </span>
                          <span className={styles.recipientMeta}>
                            {agent.workspaceName} · {status.label}
                          </span>
                        </span>
                        <span className={styles.selectMark} aria-hidden="true">
                          {selected ? <Check /> : <ArrowRight />}
                        </span>
                      </label>
                    );
                  })}
                </fieldset>
              )}

              {staleTarget ? (
                <p className={styles.inlineError} role="alert">
                  That agent is no longer available. Choose another recipient.
                </p>
              ) : null}

              <div className={styles.taskSection}>
                <span className={styles.fieldLabel} id={`${id}-task-label`}>
                  Task
                </span>
                <SegmentedControl
                  value={task}
                  options={TASK_OPTIONS}
                  onValueChange={setTask}
                  aria-labelledby={`${id}-task-label`}
                  disabled={busy !== null}
                />
                <p className={styles.taskHelp}>{TASK_HELP[task]}</p>
              </div>

              <Field htmlFor={`${id}-instructions`} label="Instructions" optional>
                <TextArea
                  id={`${id}-instructions`}
                  className={styles.instructions}
                  value={instructions}
                  maxLength={2_000}
                  placeholder="What should the receiving agent focus on?"
                  disabled={busy !== null}
                  onChange={(event) => setInstructions(event.target.value)}
                />
              </Field>

              <div className={styles.actions}>
                <Button
                  variant="primary"
                  icon={<ArrowRight />}
                  busy={busy === "preview"}
                  disabled={!featureAvailable || !selectedTarget || busy !== null}
                  onClick={prepareCurrent}
                >
                  Prepare handoff
                </Button>
              </div>
            </section>
          )}

          {error ? (
            <p className={styles.error} role="alert">
              {error}
            </p>
          ) : null}
          {notice ? (
            <p className={styles.notice} role="status">
              {notice}
            </p>
          ) : null}

          <section className={styles.activity} aria-labelledby={`${id}-activity-title`}>
            <div className={styles.sectionHead}>
              <div>
                <h2 id={`${id}-activity-title`}>Handoff activity</h2>
                <p>Track delivery and record findings.</p>
              </div>
              <Button
                size="sm"
                variant="ghost"
                icon={<RefreshCw />}
                onClick={() => void loadRecords()}
                disabled={recordsState === "loading"}
              >
                Refresh
              </Button>
            </div>
            {recordsState === "loading" ? (
              <p className={styles.activityState} role="status">
                Loading handoffs…
              </p>
            ) : recordsState === "error" ? (
              <p className={styles.inlineError} role="alert">
                {recordsError ?? "Handoff activity is unavailable."}
              </p>
            ) : records.length === 0 ? (
              <p className={styles.activityState}>No handoffs for this agent yet.</p>
            ) : (
              <div className={styles.recordList}>
                {records.slice(0, 8).map((record) => (
                  <HandoffRecordRow
                    key={record.id}
                    record={record}
                    currentThreadId={source.id}
                    onRefresh={() => loadRecords(true)}
                    onOpenAgent={openAgent}
                    onReturn={beginReturn}
                    returning={busy === "return"}
                  />
                ))}
              </div>
            )}
          </section>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function HandoffRecordRow({
  record,
  currentThreadId,
  onRefresh,
  onOpenAgent,
  onReturn,
  returning,
}: {
  record: HandoffRecord;
  currentThreadId: string;
  onRefresh: () => Promise<void>;
  onOpenAgent: (threadId: string, workspaceId: string) => void;
  onReturn: (record: HandoffRecord) => void;
  returning: boolean;
}) {
  const { client } = useRuntime();
  const id = useId();
  const incoming = record.targetThreadId === currentThreadId;
  const activeIncoming = incoming && ["delivered", "working", "needs_you"].includes(record.status);
  const [reporting, setReporting] = useState(false);
  const [outcome, setOutcome] = useState<HandoffCompletion>("completed");
  const [result, setResult] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cancel = async () => {
    setBusy(true);
    setError(null);
    try {
      await client.handoffs.cancel(record.id);
      await onRefresh();
    } catch (cause) {
      setError(toKalCodeError(cause).message);
    } finally {
      setBusy(false);
    }
  };

  const complete = async (event: FormEvent) => {
    event.preventDefault();
    const text = result.trim();
    if (!text) {
      setError("Describe the result before completing the handoff.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await client.handoffs.complete(record.id, outcome, text);
      setReporting(false);
      setResult("");
      await onRefresh();
    } catch (cause) {
      setError(toKalCodeError(cause).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <article
      className={styles.record}
      data-handoff-status={record.status}
      data-handoff-return-of={record.returnOfId ?? undefined}
    >
      <div className={styles.recordTop}>
        <span className={styles.direction}>{incoming ? `From ${record.sourceName}` : `To ${record.targetName}`}</span>
        <Badge tone={STATUS_TONE[record.status]}>{STATUS_LABEL[record.status]}</Badge>
      </div>
      <p className={styles.recordTask}>
        {record.task[0]?.toUpperCase() + record.task.slice(1)}
        {record.sourceBranch ? ` · ${record.sourceBranch}` : ""}
      </p>
      {record.blocker ? <p className={styles.blocker}>{record.blocker}</p> : null}
      {record.result ? (
        <div className={styles.result}>
          <span>Recorded result</span>
          <p>{record.result}</p>
        </div>
      ) : null}

      {reporting ? (
        <form className={styles.report} onSubmit={complete}>
          <span className={styles.fieldLabel} id={`${id}-outcome`}>
            Outcome
          </span>
          <SegmentedControl
            value={outcome}
            options={[
              { value: "completed", label: "Completed" },
              { value: "failed", label: "Failed" },
            ]}
            onValueChange={setOutcome}
            aria-labelledby={`${id}-outcome`}
            disabled={busy}
          />
          <Field htmlFor={`${id}-result`} label="Result" hint="Recorded as the receiving agent's reported outcome.">
            <TextArea
              id={`${id}-result`}
              value={result}
              maxLength={8_000}
              placeholder="Findings, tests, commits, blockers, and remaining work"
              disabled={busy}
              onChange={(event) => setResult(event.target.value)}
            />
          </Field>
          <div className={styles.recordActions}>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => setReporting(false)}>
              Cancel
            </Button>
            <Button size="sm" variant="primary" icon={<Check />} busy={busy} type="submit">
              Record result
            </Button>
          </div>
        </form>
      ) : (
        <div className={styles.recordActions}>
          {!incoming ? (
            <Button
              size="sm"
              variant="ghost"
              icon={<ExternalLink />}
              onClick={() => onOpenAgent(record.targetThreadId, record.targetWorkspaceId)}
            >
              Open receiver
            </Button>
          ) : null}
          {!incoming && record.status === "queued" ? (
            <Button size="sm" variant="ghost" busy={busy} onClick={() => void cancel()}>
              Cancel queued
            </Button>
          ) : null}
          {activeIncoming ? (
            <Button size="sm" variant="primary" icon={<Check />} onClick={() => setReporting(true)}>
              Report result
            </Button>
          ) : null}
          {incoming && record.result && (record.status === "completed" || record.status === "failed") ? (
            <Button size="sm" variant="ghost" icon={<RotateCcw />} busy={returning} onClick={() => onReturn(record)}>
              Return findings
            </Button>
          ) : null}
        </div>
      )}
      {error ? (
        <p className={styles.inlineError} role="alert">
          {error}
        </p>
      ) : null}
    </article>
  );
}
