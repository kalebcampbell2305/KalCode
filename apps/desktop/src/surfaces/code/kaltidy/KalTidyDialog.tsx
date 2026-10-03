import type { ThreadSummary } from "@kalcode/protocol";
import { Button, cx, ProviderGlyph, Skeleton } from "@kalcode/ui/components";
import { BroomSparkles, CircleAlert, Lock, Power, RefreshCw } from "lucide-react";
import { Dialog } from "radix-ui";
import { useEffect, useId, useMemo, useState } from "react";
import { formatRelative } from "../../../runtime/describeEvent.ts";
import { STATUS_META } from "../../dashboard/data/status.ts";
import { type AgentCleanup, agentCleanup } from "./agents.ts";
import type { TidyEntry, TidyScan } from "./classify.ts";
import styles from "./KalTidy.module.css";
import type { KalTidyClass } from "./kalTidyContext.ts";

/** The review's coding agents (every workspace), or why they couldn't be read. */
export interface ReviewAgents {
  list: ThreadSummary[];
  error: string | null;
}

const AGENT_GROUPS: { which: AgentCleanup; title: string; hint: string; action: string }[] = [
  { which: "failed", title: "Failed agents", hint: "Their sessions are over.", action: "Clear failed" },
  {
    which: "finished",
    title: "Finished agents",
    hint: "Finished, stopped or offline.",
    action: "Clear finished",
  },
];

const GROUPS: { cls: KalTidyClass; title: string; hint: string }[] = [
  { cls: "idle", title: "Idle", hint: "At the prompt and quiet, or already ended. Safe to stop." },
  { cls: "waiting", title: "Waiting for you", hint: "Something is typed or a program waits for input." },
  { cls: "background", title: "Background", hint: "Servers and services. Stop only if you're done with them." },
  { cls: "active", title: "Active", hint: "Working or used moments ago." },
  { cls: "protected", title: "Protected", hint: "KalTidy never stops these." },
];

/** Whether the person may choose to stop a terminal of this class. */
export function selectable(cls: KalTidyClass): boolean {
  return cls !== "protected";
}

export interface KalTidyDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The latest scan; null while the first one runs. */
  scan: TidyScan | null;
  scanning: boolean;
  stopping: boolean;
  onRescan: () => void;
  /** The chosen terminals' ids. */
  onConfirm: (terminalIds: string[]) => void;
  /** Coding agents; null while the first read runs. */
  agents?: ReviewAgents | null;
  /** The clear in progress, if any. */
  clearing?: AgentCleanup | null;
  /** The current workspace, which "Close all" covers. */
  activeWorkspaceId?: string | null;
  onClear?: (which: AgentCleanup) => void;
  /** Opens the "Close all" confirmation. */
  onCloseAll?: () => void;
}

/**
 * KalTidy's review-before-stop dialog: every terminal grouped by class with its reason. Idle ones
 * start checked; waiting, background and active ones can be opted in; protected ones can't.
 */
export function KalTidyDialog({
  open,
  onOpenChange,
  scan,
  scanning,
  stopping,
  onRescan,
  onConfirm,
  agents = null,
  clearing = null,
  activeWorkspaceId = null,
  onClear,
  onCloseAll,
}: KalTidyDialogProps) {
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  // Each new scan starts from its idle terminals.
  useEffect(() => {
    setChosen(new Set(scan?.entries.filter((e) => e.cls === "idle").map((e) => e.terminal.id) ?? []));
  }, [scan]);

  const groups = useMemo(
    () =>
      GROUPS.map((group) => ({ ...group, entries: scan?.entries.filter((e) => e.cls === group.cls) ?? [] })).filter(
        (group) => group.entries.length > 0,
      ),
    [scan],
  );
  const selected = scan?.entries.filter((e) => chosen.has(e.terminal.id) && selectable(e.cls)) ?? [];
  const idleCount = scan?.entries.filter((e) => e.cls === "idle").length ?? 0;
  const agentGroups = useMemo(
    () =>
      AGENT_GROUPS.map((group) => ({
        ...group,
        agents: agents?.list.filter((a) => agentCleanup(a) === group.which) ?? [],
      })),
    [agents],
  );
  // What "Close all" would end: the current workspace's terminals and agents, whatever they do.
  const closeAllCount =
    scan && agents && activeWorkspaceId
      ? scan.entries.filter((e) => e.terminal.workspaceId === activeWorkspaceId).length +
        agents.list.filter((a) => a.workspaceId === activeWorkspaceId).length
      : null;
  const toggle = (id: string, on: boolean) =>
    setChosen((current) => {
      const next = new Set(current);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className={styles.overlay} />
        <Dialog.Content className={styles.dialog} aria-busy={scanning || stopping || undefined}>
          <div className={styles.head}>
            <span className={styles.mark} aria-hidden="true">
              <BroomSparkles />
            </span>
            <div className={styles.headText}>
              <Dialog.Title className={styles.title}>KalTidy — Review terminals and agents</Dialog.Title>
              <Dialog.Description className={styles.description}>
                Idle terminals are selected. Anything doing work keeps running unless you choose it.
              </Dialog.Description>
            </div>
          </div>

          {/* What each action would clean, before anything runs. */}
          <ul className={styles.plan} aria-label="What each action would clean">
            <PlanTile tone="idle" label="Stop idle" value={scan ? idleCount : null} unit="terminals" />
            <PlanTile
              tone="failed"
              label="Clear failed"
              value={agents ? (agentGroups[0]?.agents.length ?? 0) : null}
              unit="agents"
            />
            <PlanTile
              tone="finished"
              label="Clear finished"
              value={agents ? (agentGroups[1]?.agents.length ?? 0) : null}
              unit="agents"
            />
            <PlanTile
              tone="danger"
              label="Close all"
              value={activeWorkspaceId ? closeAllCount : 0}
              unit={activeWorkspaceId ? "in workspace" : "no workspace open"}
            />
          </ul>

          {scan?.blocked ? (
            <p className={styles.alert} role="alert">
              <CircleAlert aria-hidden="true" />
              <span>{scan.blocked} Every terminal stays until KalTidy can check again.</span>
            </p>
          ) : null}

          <div className={styles.body}>
            {!scan ? (
              <div className={styles.loading} role="status">
                <span className="visually-hidden">Checking your terminals</span>
                <Skeleton width="100%" height="2.75rem" />
                <Skeleton width="100%" height="2.75rem" />
                <Skeleton width="70%" height="2.75rem" />
              </div>
            ) : scan.entries.length === 0 ? (
              <div className={styles.empty}>
                <p className={styles.emptyTitle}>No terminals open</p>
                <p className={styles.emptyText}>There's nothing to tidy.</p>
              </div>
            ) : (
              <>
                {idleCount === 0 && !scan.blocked ? (
                  <div className={styles.empty} role="status">
                    <p className={styles.emptyTitle}>Nothing is idle right now</p>
                    <p className={styles.emptyText}>
                      Every terminal below is in use. You can still choose one to stop.
                    </p>
                  </div>
                ) : null}
                {groups.map((group) => (
                  <Group key={group.cls} {...group} chosen={chosen} disabled={stopping} onToggle={toggle} />
                ))}
              </>
            )}
            {agents?.error ? (
              <p className={styles.alert} role="alert">
                <CircleAlert aria-hidden="true" />
                <span>{agents.error}</span>
              </p>
            ) : null}
            {agentGroups.map((group) =>
              group.agents.length > 0 ? (
                <AgentGroup
                  key={group.which}
                  {...group}
                  busy={clearing === group.which}
                  disabled={clearing !== null || stopping}
                  onClear={() => onClear?.(group.which)}
                />
              ) : null,
            )}
          </div>

          <div className={styles.footer}>
            <div className={styles.footerStart}>
              <Button
                size="sm"
                variant="ghost"
                icon={<RefreshCw />}
                busy={scanning && scan !== null}
                disabled={stopping}
                onClick={onRescan}
              >
                Rescan
              </Button>
              {onCloseAll ? (
                <Button
                  size="sm"
                  variant="ghost"
                  icon={<Power />}
                  className={styles.closeAllButton}
                  disabled={stopping || !activeWorkspaceId}
                  onClick={onCloseAll}
                >
                  Close all…
                </Button>
              ) : null}
              {scan && scan.entries.length > 0 ? (
                <span className={styles.count} aria-live="polite">
                  {selected.length} of {scan.entries.length} selected
                </span>
              ) : null}
            </div>
            <div className={styles.actions}>
              <Dialog.Close asChild>
                <Button variant="ghost" disabled={stopping}>
                  Cancel
                </Button>
              </Dialog.Close>
              <Button
                variant="primary"
                busy={stopping}
                disabled={selected.length === 0 || scanning || stopping}
                onClick={() => onConfirm(selected.map((e) => e.terminal.id))}
              >
                {selected.length === 1 ? "Stop 1 terminal" : `Stop ${selected.length} terminals`}
              </Button>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function Group({
  cls,
  title,
  hint,
  entries,
  chosen,
  disabled,
  onToggle,
}: {
  cls: KalTidyClass;
  title: string;
  hint: string;
  entries: TidyEntry[];
  chosen: Set<string>;
  disabled: boolean;
  onToggle: (id: string, on: boolean) => void;
}) {
  const headingId = useId();
  return (
    <section className={styles.group} data-class={cls} aria-labelledby={headingId}>
      <div className={styles.groupHead}>
        <span className={styles.dot} aria-hidden="true" />
        <h3 id={headingId} className={styles.groupTitle}>
          {title}
          <span className={styles.groupCount}>{entries.length}</span>
        </h3>
        <span className={styles.groupHint}>{hint}</span>
      </div>
      <ul className={styles.rows}>
        {entries.map((entry) => (
          <Row
            key={entry.terminal.id}
            entry={entry}
            checked={chosen.has(entry.terminal.id) && selectable(entry.cls)}
            disabled={disabled}
            onToggle={onToggle}
          />
        ))}
      </ul>
    </section>
  );
}

function Row({
  entry,
  checked,
  disabled,
  onToggle,
}: {
  entry: TidyEntry;
  checked: boolean;
  disabled: boolean;
  onToggle: (id: string, on: boolean) => void;
}) {
  const reasonId = useId();
  const locked = !selectable(entry.cls);
  const { terminal } = entry;
  return (
    <li className={cx(styles.row, checked && styles.rowChecked, locked && styles.rowLocked)}>
      <label className={styles.rowLabel}>
        {locked ? (
          <span className={styles.lock} aria-hidden="true">
            <Lock />
          </span>
        ) : null}
        <input
          type="checkbox"
          className={cx(styles.check, locked && "visually-hidden")}
          checked={checked}
          disabled={locked || disabled}
          aria-describedby={reasonId}
          onChange={(event) => onToggle(terminal.id, event.target.checked)}
        />
        <span className={styles.name}>
          <span className={styles.terminal}>{terminal.label}</span>
          <span className={styles.workspace}>{terminal.workspaceName}</span>
        </span>
        <span id={reasonId} className={styles.reason}>
          {entry.reason}
        </span>
      </label>
    </li>
  );
}

function PlanTile({
  tone,
  label,
  value,
  unit,
}: {
  tone: "idle" | "failed" | "finished" | "danger";
  label: string;
  value: number | null;
  unit: string;
}) {
  return (
    <li className={styles.planTile} data-tone={tone} data-empty={value === 0 || undefined}>
      <span className={styles.planLabel}>
        <span className={styles.planDot} aria-hidden="true" />
        {label}
      </span>
      <span className={styles.planValue}>
        {value === null ? <Skeleton width="1.5rem" height="1.25rem" /> : value}
        <span className={styles.planUnit}>{unit}</span>
      </span>
    </li>
  );
}

function agentReason(agent: ThreadSummary, now: number): string {
  if (agent.status === "failed" && agent.error?.message) return agent.error.message;
  return `${STATUS_META[agent.status].label} ${formatRelative(agent.lastActivityAt, now)}`;
}

function AgentGroup({
  which,
  title,
  hint,
  action,
  agents,
  busy,
  disabled,
  onClear,
}: {
  which: AgentCleanup;
  title: string;
  hint: string;
  action: string;
  agents: ThreadSummary[];
  busy: boolean;
  disabled: boolean;
  onClear: () => void;
}) {
  const headingId = useId();
  const now = Date.now();
  return (
    <section className={styles.group} data-class={which} aria-labelledby={headingId}>
      <div className={styles.groupHead}>
        <span className={styles.dot} aria-hidden="true" />
        <h3 id={headingId} className={styles.groupTitle}>
          {title}
          <span className={styles.groupCount}>{agents.length}</span>
        </h3>
        <span className={styles.groupHint}>{hint}</span>
        <Button
          size="sm"
          variant="secondary"
          busy={busy}
          disabled={disabled}
          className={styles.groupAction}
          onClick={onClear}
        >
          {action}
        </Button>
      </div>
      <ul className={styles.rows}>
        {agents.map((agent) => (
          <li key={agent.id} className={styles.row}>
            <div className={cx(styles.rowLabel, styles.agentRow)}>
              <span className={styles.agentGlyph} aria-hidden="true">
                <ProviderGlyph provider={agent.providerId} size="xs" />
              </span>
              <span className={styles.name}>
                <span className={styles.terminal}>{agent.name}</span>
                <span className={styles.workspace}>
                  {agent.providerName} · {agent.workspaceName}
                </span>
              </span>
              <span className={styles.reason} title={agentReason(agent, now)}>
                {agentReason(agent, now)}
              </span>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
