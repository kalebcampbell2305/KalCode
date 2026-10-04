import type { ThreadSummary } from "@kalcode/protocol";
import { Button, ProviderGlyph } from "@kalcode/ui/components";
import { ChevronDown } from "lucide-react";
import { Popover } from "radix-ui";
import { useId, useRef, useState } from "react";
import { toKalCodeError } from "../../../ipc/errors.ts";
import { accountProviderName } from "../../../shell/accountCommands.ts";
import { AccountUsageDetails, UsageMeter } from "../../providers/AccountUsageBadge.tsx";
import { accountName, accountSessionState, sortAccounts } from "../../providers/accountIdentity.ts";
import { limitingWindow, notChecked, resetsIn } from "../../providers/accountUsage.ts";
import { useOptionalProviderAccountSessions } from "../../providers/ProviderAccountSessions.tsx";
import styles from "./PaneAccountPicker.module.css";
import { type PaneAccountIdentity, paneAccountLabel } from "./PaneParts.tsx";

export interface PaneAccountPickerProps {
  thread: ThreadSummary;
  account: PaneAccountIdentity | null;
  onContinue: (threadId: string, accountId: string) => Promise<void>;
}

/** Selection is only a preview. A confirmed launch creates a new account-isolated runtime. */
export function PaneAccountPicker({ thread, account, onContinue }: PaneAccountPickerProps) {
  const sessions = useOptionalProviderAccountSessions();
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submitting = useRef(false);
  const heading = useId();
  const label = account ? paneAccountLabel(account) : "Unmanaged account";
  const accounts = sortAccounts(
    (sessions?.accounts ?? []).filter((item) => item.providerId === thread.providerId && item.archivedAt === null),
  );
  const target = accounts.find((item) => item.id === selected);
  const details = target ?? accounts.find((item) => item.id === thread.providerAccountId);
  const canContinue =
    target && target.id !== thread.providerAccountId && target.authenticationState !== "not_authenticated";
  const blocked = thread.archivedAt !== null || thread.permissionMode === "custom";

  const confirm = async () => {
    if (!canContinue || blocked || submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setError(null);
    try {
      await onContinue(thread.id, target.id);
      setOpen(false);
    } catch (cause) {
      setError(toKalCodeError(cause).message);
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  };

  return (
    <Popover.Root
      open={open}
      onOpenChange={(next) => {
        if (submitting.current) return;
        setOpen(next);
        if (next) {
          setSelected(null);
          setError(null);
          void sessions?.reload();
          sessions?.refreshUsage();
        }
      }}
    >
      <Popover.Trigger asChild>
        <button
          type="button"
          className={styles.trigger}
          data-pane-account
          aria-label={`${label}. Switch ${thread.providerName} account`}
          title="Switch account for a new session"
        >
          <span>{label}</span>
          <ChevronDown aria-hidden="true" />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          className={styles.popover}
          align="start"
          sideOffset={8}
          collisionPadding={10}
          aria-labelledby={heading}
          onEscapeKeyDown={(event) => {
            if (busy) event.preventDefault();
          }}
        >
          <h3 id={heading} className={styles.heading}>
            Account & usage
          </h3>
          <p className={styles.note}>Choose an account for your next coding session.</p>
          {sessions?.loadError ? (
            <p className={styles.note} role="status">
              Account refresh unavailable. Showing saved accounts.
            </p>
          ) : null}
          {!sessions?.accounts ? (
            <p className={styles.note} role="status">
              Restoring accounts…
            </p>
          ) : accounts.length === 0 ? (
            <p className={styles.note}>No compatible accounts connected.</p>
          ) : null}
          <fieldset className={styles.accounts} aria-label={`${thread.providerName} accounts`}>
            {accounts.map((item) => {
              const current = item.id === thread.providerAccountId;
              const health = accountSessionState(
                item,
                sessions?.checking.has(item.id),
                sessions?.validationErrors.get(item.id),
              );
              const usage = sessions?.usage.get(item.id) ?? notChecked(item.id);
              const window = usage.status === "fresh" || usage.status === "stale" ? limitingWindow(usage) : null;
              return (
                <button
                  key={item.id}
                  type="button"
                  className={styles.row}
                  data-current={current || undefined}
                  aria-pressed={(selected ?? thread.providerAccountId) === item.id}
                  disabled={busy || !health.usable}
                  onClick={() => {
                    setSelected(item.id);
                    setError(null);
                  }}
                >
                  <ProviderGlyph provider={item.providerId} size="sm" />
                  <span className={styles.identity}>
                    <span className={styles.name}>
                      {accountName(item)}
                      {current ? <span className={styles.current}>Current</span> : null}
                    </span>
                    <span className={styles.secondary}>
                      {accountProviderName(item.providerId)} · {health.label}
                    </span>
                  </span>
                  <span className={styles.quota}>
                    <UsageMeter usage={usage} />
                    <span className={styles.secondary}>
                      {[usage.status === "stale" ? "Stale" : null, window ? resetsIn(window.resetsAt) : null]
                        .filter(Boolean)
                        .join(" · ")}
                    </span>
                  </span>
                </button>
              );
            })}
          </fieldset>
          {details ? (
            <div className={styles.details}>
              <AccountUsageDetails
                account={details}
                usage={sessions?.usage.get(details.id) ?? notChecked(details.id)}
              />
            </div>
          ) : null}
          {canContinue ? (
            <div className={styles.confirm}>
              <p>
                Switching to <strong>{accountName(target)}</strong> starts a fresh coding session with the same
                workspace, working directory, model and permissions. The current session stays open. Conversation
                history and provider sign-in stay with their original account.
              </p>
              {blocked ? <p role="status">This session cannot be continued with its current settings.</p> : null}
              {error ? <p role="alert">{error}</p> : null}
              <div className={styles.actions}>
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => setSelected(null)}>
                  Cancel
                </Button>
                <Button size="sm" busy={busy} disabled={blocked} onClick={() => void confirm()}>
                  Start with {accountName(target)}
                </Button>
              </div>
            </div>
          ) : null}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
