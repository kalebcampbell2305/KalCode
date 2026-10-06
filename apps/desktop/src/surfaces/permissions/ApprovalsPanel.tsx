import { Button, EmptyState, ErrorState, IconButton, Skeleton } from "@kalcode/ui/components";
import { ShieldCheck, X } from "lucide-react";
import { Dialog } from "radix-ui";
import { ApprovalPrompt } from "./ApprovalPrompt.tsx";
import styles from "./ApprovalsPanel.module.css";
import { usePermissions } from "./PermissionsProvider.tsx";

/** Side sheet listing every pending approval. Opened from the sidebar indicator. */
export function ApprovalsPanel() {
  const { pending, pendingState, pendingError, refreshPending, decide, panelOpen, setPanelOpen, panelReturnFocus } =
    usePermissions();
  const count = pending.length;

  return (
    <Dialog.Root open={panelOpen} onOpenChange={setPanelOpen}>
      <Dialog.Portal>
        <Dialog.Overlay className={styles.overlay} />
        <Dialog.Content
          className={styles.sheet}
          aria-describedby="approvals-panel-description"
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            panelReturnFocus();
          }}
        >
          {/* The lit edge on an inert element, not ::before (see ApprovalsPanel.module.css). */}
          <span className={styles.edge} aria-hidden="true" />
          <header className={styles.header}>
            <div>
              <Dialog.Title className={styles.title}>Approvals</Dialog.Title>
              <Dialog.Description id="approvals-panel-description" className={styles.description}>
                {count === 0
                  ? "Nothing is waiting for you."
                  : `${count} ${count === 1 ? "request is" : "requests are"} waiting. Agents pause until you answer.`}
              </Dialog.Description>
            </div>
            <Dialog.Close asChild>
              <IconButton label="Close approvals" icon={<X />} />
            </Dialog.Close>
          </header>
          <div className={styles.body}>
            {pendingState === "loading" && count === 0 ? (
              <div role="status" aria-busy="true" className={styles.loading}>
                <span className="visually-hidden">Loading approvals</span>
                <Skeleton width="70%" />
                <Skeleton width="50%" />
              </div>
            ) : pendingState === "error" && count === 0 ? (
              <ErrorState
                title="Approvals unavailable"
                actions={<Button onClick={() => void refreshPending()}>Try again</Button>}
              >
                <p>{pendingError?.message}</p>
              </ErrorState>
            ) : count === 0 ? (
              <EmptyState art={<ShieldCheck />} title="You're all caught up">
                <p>When an agent needs permission to change files, run commands or reach the internet, it asks here.</p>
              </EmptyState>
            ) : (
              <ol className={styles.list} aria-label="Pending approvals">
                {pending.map((request) => (
                  <li key={request.id}>
                    <ApprovalPrompt request={request} onDecide={decide} />
                  </li>
                ))}
              </ol>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
