import { Button } from "@kalcode/ui/components";
import { AlertDialog } from "radix-ui";
import styles from "./PromptWarningDialog.module.css";
import type { PromptWarningView } from "./usePromptConfirmation.ts";

export function PromptWarningDialog({
  warning,
  busy,
  confirmLabel,
  onConfirm,
  onCancel,
}: {
  warning: PromptWarningView | null;
  busy: boolean;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const detectors = Object.entries(warning?.detectors ?? {}).sort(([left], [right]) => left.localeCompare(right));
  return (
    <AlertDialog.Root open={warning !== null} onOpenChange={(open) => !open && onCancel()}>
      <AlertDialog.Portal>
        <AlertDialog.Overlay className={styles.overlay} />
        <AlertDialog.Content className={styles.dialog}>
          <AlertDialog.Title className={styles.title}>This message may contain a secret</AlertDialog.Title>
          <AlertDialog.Description className={styles.description}>
            KalCode found credential-shaped text. Check the message before sending it to the selected provider account.
          </AlertDialog.Description>
          <ul className={styles.detectors} aria-label="Potential secret patterns">
            {detectors.map(([detector, count]) => (
              <li key={detector}>
                <span>{detector.replaceAll("_", " ")}</span>
                <strong>
                  {count}
                  <span className="visually-hidden"> matches</span>
                </strong>
              </li>
            ))}
          </ul>
          <p className={styles.note}>
            The warning contains pattern names and counts only. KalCode will send only after you confirm.
          </p>
          <div className={styles.actions}>
            <AlertDialog.Cancel asChild>
              <Button variant="ghost" disabled={busy}>
                Go back
              </Button>
            </AlertDialog.Cancel>
            <Button variant="primary" busy={busy} onClick={onConfirm}>
              {confirmLabel}
            </Button>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
