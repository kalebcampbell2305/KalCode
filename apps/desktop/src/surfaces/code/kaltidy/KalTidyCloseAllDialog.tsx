import { Button } from "@kalcode/ui/components";
import { Bot, Folder, Power, SquareTerminal } from "lucide-react";
import { AlertDialog } from "radix-ui";
import styles from "./KalTidy.module.css";

/** What "Close all" will end: the current workspace's terminals and coding agents. */
export interface CloseAllScope {
  workspaceName: string;
  terminals: number;
  /** How many coding agents, while their list is read, or unknown when it couldn't be. */
  agents: number | "loading" | "unknown";
}

export interface KalTidyCloseAllDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  scope: CloseAllScope | null;
  onConfirm: () => void;
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? `1 ${one}` : `${n} ${many}`;
}

/**
 * KalTidy's one confirmation before "Close all": a deliberate force-close of every terminal and
 * coding agent in the current workspace. Cancel has focus first; there is no second step.
 */
export function KalTidyCloseAllDialog({ open, onOpenChange, scope, onConfirm }: KalTidyCloseAllDialogProps) {
  return (
    <AlertDialog.Root open={open} onOpenChange={onOpenChange}>
      <AlertDialog.Portal>
        <AlertDialog.Overlay className={styles.overlay} />
        <AlertDialog.Content className={styles.confirm}>
          <div className={styles.head}>
            <span className={styles.mark} data-tone="danger" aria-hidden="true">
              <Power />
            </span>
            <div className={styles.headText}>
              <AlertDialog.Title className={styles.title}>Close all terminals and agents?</AlertDialog.Title>
              <AlertDialog.Description className={styles.description}>
                Active agents, builds, tests, and running processes will be stopped.
              </AlertDialog.Description>
            </div>
          </div>

          {scope ? (
            <ul className={styles.scope} aria-label="What closes">
              <li className={styles.scopeItem}>
                <Folder aria-hidden="true" />
                <span className={styles.scopeName}>{scope.workspaceName}</span>
              </li>
              <li className={styles.scopeItem}>
                <SquareTerminal aria-hidden="true" />
                <span>{plural(scope.terminals, "terminal", "terminals")}</span>
              </li>
              {scope.agents === "unknown" ? null : (
                <li className={styles.scopeItem} aria-busy={scope.agents === "loading" || undefined}>
                  <Bot aria-hidden="true" />
                  <span>{scope.agents === "loading" ? "Agents…" : plural(scope.agents, "agent", "agents")}</span>
                </li>
              )}
            </ul>
          ) : null}

          <div className={styles.confirmActions}>
            <AlertDialog.Cancel asChild>
              <Button variant="ghost">Cancel</Button>
            </AlertDialog.Cancel>
            <AlertDialog.Action asChild>
              <Button variant="danger" onClick={onConfirm}>
                Close all
              </Button>
            </AlertDialog.Action>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
