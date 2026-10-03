import { Button } from "@kalcode/ui/components";
import { CircleAlert } from "lucide-react";
import { AlertDialog } from "radix-ui";
import styles from "./RebindThreadDialog.module.css";

export interface RebindThreadDialogProps {
  objectKind?: "thread" | "agent";
  open: boolean;
  /** The thread's current account label. */
  from: string;
  /** The account the person chose. */
  to: string;
  /** The rebind request is in flight: confirm shows busy and can't be pressed again. */
  busy: boolean;
  /** Why the thread can't switch right now (a running turn, a pending approval); disables confirm. */
  blocker: string | null;
  /** The target account needs signing in: confirm becomes "Sign in to {to}". */
  signInRequired: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  onSignIn: () => void;
  /** Where focus goes when the dialog closes (it has no trigger of its own). */
  returnFocus?: () => void;
}

/**
 * Confirms an explicit thread rebind. Nothing switches silently: every account change (menu,
 * command palette, KalVoice) goes through this dialog, and only its confirm button rebinds.
 * Radix AlertDialog puts focus on Cancel when it opens.
 */
export function RebindThreadDialog({
  objectKind = "thread",
  open,
  from,
  to,
  busy,
  blocker,
  signInRequired,
  onConfirm,
  onCancel,
  onSignIn,
  returnFocus,
}: RebindThreadDialogProps) {
  return (
    <AlertDialog.Root open={open} onOpenChange={(next) => !next && !busy && onCancel()}>
      <AlertDialog.Portal>
        <AlertDialog.Overlay className={styles.overlay} />
        <AlertDialog.Content
          className={styles.dialog}
          onCloseAutoFocus={(event) => {
            if (!returnFocus) return;
            event.preventDefault();
            returnFocus();
          }}
        >
          <AlertDialog.Title className={styles.title}>
            {objectKind === "agent" ? "Change agent account?" : "Rebind thread?"}
          </AlertDialog.Title>
          <AlertDialog.Description asChild>
            <div className={styles.body}>
              <p>
                This {objectKind} currently belongs to {from}.
              </p>
              <p>
                {objectKind === "agent"
                  ? `Use ${to} the next time this coding agent starts?`
                  : `Switch future messages to ${to}?`}
              </p>
              <p className={styles.note}>
                {objectKind === "agent"
                  ? "The agent stays stopped until you resume it. Existing provider sign-in and approval rules still apply."
                  : `Past conversation history remains unchanged. Only future provider requests use ${to}.`}
              </p>
            </div>
          </AlertDialog.Description>
          {signInRequired ? (
            <p className={styles.alert} role="alert">
              <CircleAlert aria-hidden="true" />
              <span>
                {to} isn't signed in. Sign in to {to} in Providers → Accounts, then switch.
              </span>
            </p>
          ) : blocker ? (
            <p className={styles.alert} role="status">
              <CircleAlert aria-hidden="true" />
              <span>{blocker}</span>
            </p>
          ) : null}
          <div className={styles.actions}>
            <AlertDialog.Cancel asChild>
              <Button variant="ghost" disabled={busy}>
                Cancel
              </Button>
            </AlertDialog.Cancel>
            {signInRequired ? (
              <Button variant="primary" onClick={onSignIn}>
                Sign in to {to}
              </Button>
            ) : (
              <Button
                variant="primary"
                busy={busy}
                disabled={busy || blocker !== null}
                onClick={() => {
                  if (!busy && blocker === null) onConfirm();
                }}
              >
                Switch to {to}
              </Button>
            )}
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
