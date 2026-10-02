import { Button, cx, Skeleton } from "@kalcode/ui/components";
import { BroomSparkles, CircleAlert, Lock, RefreshCw } from "lucide-react";
import { Dialog } from "radix-ui";
import { useEffect, useId, useMemo, useState } from "react";
import type { TidyEntry, TidyScan } from "./classify.ts";
import styles from "./KalTidy.module.css";
import type { KalTidyClass } from "./kalTidyContext.ts";

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
              <Dialog.Title className={styles.title}>KalTidy — Stop idle terminals</Dialog.Title>
              <Dialog.Description className={styles.description}>
                Idle terminals are selected. Anything doing work keeps running unless you choose it.
              </Dialog.Description>
            </div>
          </div>

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
