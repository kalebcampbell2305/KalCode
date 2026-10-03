import { Button, Field, TextInput } from "@kalcode/ui/components";
import { Dialog } from "radix-ui";
import { useId, useRef, useState } from "react";
import { toKalCodeError } from "../../ipc/errors.ts";
import styles from "./RenamePaneDialog.module.css";

export function RenamePaneDialog({
  name,
  kind,
  onSave,
  onClose,
  returnFocus,
}: {
  name: string;
  kind: "agent" | "terminal";
  onSave: (name: string) => Promise<void>;
  onClose: () => void;
  returnFocus?: () => void;
}) {
  const [draft, setDraft] = useState(name);
  const inputId = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submitting = useRef(false);
  const save = async () => {
    if (!draft.trim() || submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setError(null);
    try {
      await onSave(draft.trim());
      onClose();
    } catch (cause) {
      setError(toKalCodeError(cause).message);
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  };
  return (
    <Dialog.Root open onOpenChange={(open) => !open && !busy && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className={styles.overlay} />
        <Dialog.Content
          className={styles.dialog}
          onCloseAutoFocus={(event) => {
            if (returnFocus) {
              event.preventDefault();
              returnFocus();
            }
          }}
        >
          <Dialog.Title className={styles.title}>Rename {kind}</Dialog.Title>
          <Dialog.Description className={styles.description}>
            Give this {kind} a name you can recognize at a glance.
          </Dialog.Description>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <Field htmlFor={inputId} label={kind === "agent" ? "Agent name" : "Terminal name"}>
              <TextInput
                id={inputId}
                aria-invalid={error ? true : undefined}
                aria-describedby={error ? `${inputId}-error` : undefined}
                value={draft}
                maxLength={80}
                onChange={(event) => setDraft(event.target.value)}
                onFocus={(event) => event.target.select()}
              />
            </Field>
            {error ? (
              <p id={`${inputId}-error`} role="alert">
                {error}
              </p>
            ) : null}
            <div className={styles.actions}>
              <Button variant="ghost" disabled={busy} onClick={onClose}>
                Cancel
              </Button>
              <Button type="submit" variant="primary" busy={busy} disabled={!draft.trim()}>
                Save name
              </Button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
