/**
 * "Commit changes" on a fleet card: KalCode commits everything an isolated agent changed in its
 * own worktree, on its own branch, when the person asks. Agents can't always commit from their
 * sandbox (the worktree's Git data lives outside it), and this keeps the person in control of what
 * is committed. The main checkout and other branches are never touched.
 */
import type { ThreadSummary, ThreadWorktreeState } from "@kalcode/protocol";
import { Button, useToast } from "@kalcode/ui/components";
import { GitCommitHorizontal } from "lucide-react";
import { useId, useRef, useState } from "react";
import { toKalCodeError } from "../../../ipc/errors.ts";
import { useRuntime } from "../../../runtime/RuntimeProvider.tsx";
import styles from "./CommitChanges.module.css";

const MAX_MESSAGE = 2_000;

export function CommitChanges({
  thread,
  worktree,
  onCommitted,
}: {
  thread: ThreadSummary;
  worktree: ThreadWorktreeState;
  onCommitted?: (state: ThreadWorktreeState) => void;
}) {
  const { client } = useRuntime();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState(thread.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fieldId = useId();
  const errorId = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const changes = worktree.changed + worktree.untracked;

  const close = () => {
    setOpen(false);
    setError(null);
    requestAnimationFrame(() => trigger.current?.focus());
  };

  const commit = async () => {
    const text = message.trim();
    if (!text || busy) return;
    setBusy(true);
    setError(null);
    try {
      const next = await client.commitThreadWorktree(thread.id, text);
      onCommitted?.(next);
      toast.show({ tone: "success", title: `Committed to ${worktree.branch}` });
      setOpen(false);
    } catch (cause) {
      setError(toKalCodeError(cause).message);
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <Button
        ref={trigger}
        size="sm"
        variant="secondary"
        icon={<GitCommitHorizontal />}
        onClick={() => {
          setMessage(thread.name);
          setOpen(true);
        }}
        aria-label={`Commit ${changes} ${changes === 1 ? "change" : "changes"} from ${thread.name}`}
      >
        Commit changes
      </Button>
    );
  }

  return (
    <form
      className={styles.form}
      onSubmit={(event) => {
        event.preventDefault();
        void commit();
      }}
      aria-label={`Commit ${thread.name}'s changes`}
    >
      <label className={styles.label} htmlFor={fieldId}>
        Commit message
        <span className={styles.where}>
          {changes} {changes === 1 ? "change" : "changes"} → {worktree.branch}
        </span>
      </label>
      <textarea
        id={fieldId}
        className={styles.message}
        rows={2}
        value={message}
        maxLength={MAX_MESSAGE}
        // biome-ignore lint/a11y/noAutofocus: the person just asked to write this message.
        autoFocus
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
        onChange={(event) => setMessage(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            close();
          } else if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
            event.preventDefault();
            void commit();
          }
        }}
      />
      {error ? (
        <p id={errorId} className={styles.error} role="alert">
          {error}
        </p>
      ) : null}
      <div className={styles.actions}>
        <Button size="sm" variant="ghost" type="button" onClick={close} disabled={busy}>
          Cancel
        </Button>
        <Button size="sm" variant="primary" type="submit" busy={busy} disabled={!message.trim()}>
          Commit
        </Button>
      </div>
    </form>
  );
}
