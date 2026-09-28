import type { ProviderAccount, ThreadSummary } from "@kalcode/protocol";
import {
  Badge,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  useToast,
} from "@kalcode/ui/components";
import { ChevronDown, Plus, Settings2 } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { useRuntime } from "../../runtime/RuntimeProvider.tsx";
import { useOpenProviderAccounts } from "../providers/providersTab.ts";
import styles from "./AccountSwitcher.module.css";
import { consumeRebindRequest, useRebindRequest } from "./accountIntent.ts";
import { RebindThreadDialog } from "./RebindThreadDialog.tsx";
import {
  accountStatus,
  describeRebindError,
  rebindBlocker,
  threadAccountLabel,
  useProviderAccountList,
} from "./useThreadAccount.ts";

interface AccountSwitcherProps {
  thread: ThreadSummary;
  archived: boolean;
  /** The confirmed rebind returned the thread's new summary. */
  onRebound: (thread: ThreadSummary) => void;
}

/** One line under an account's name: identity when the provider reported one, then status. */
function describeAccount(account: ProviderAccount): string {
  const status = accountStatus(account.authenticationState);
  const parts = [account.providerReportedIdentity?.trim() || null, status.label];
  if (!status.usable) parts.push("sign in from Providers to use it");
  return parts.filter(Boolean).join(" · ");
}

/**
 * The thread header's account control: "Gemini A ▾" opens SWITCH ACCOUNT, listing the provider's
 * accounts with the thread's current one marked Active. Choosing another account never switches
 * by itself: it opens the Rebind dialog, and only its confirmation calls `thread_rebind_account`.
 * Rebind requests from the command palette or KalVoice (`accountIntent.requestRebind`) open the
 * same dialog. Not gated on any feature flag: Threads is a Stable surface.
 */
export function AccountSwitcher({ thread, archived, onRebound }: AccountSwitcherProps) {
  const { client } = useRuntime();
  const openProviderAccounts = useOpenProviderAccounts();
  const toast = useToast();
  const list = useProviderAccountList(thread.providerId);
  const [target, setTarget] = useState<ProviderAccount | null>(null);
  const [busy, setBusy] = useState(false);
  const [signInRequired, setSignInRequired] = useState(false);
  const submitting = useRef(false);
  const dialogOpen = useRef(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuLabelId = useId();
  const label = threadAccountLabel(thread);
  const current = thread.providerAccountId;

  const openDialog = (account: ProviderAccount) => {
    dialogOpen.current = true;
    setSignInRequired(account.authenticationState === "not_authenticated");
    setTarget(account);
  };

  const closeDialog = () => {
    if (submitting.current) return;
    dialogOpen.current = false;
    setTarget(null);
    setSignInRequired(false);
  };

  // Providers → Accounts, scrolled to this thread's provider; "Connect another" also opens its
  // connect form.
  const openAccounts = () => openProviderAccounts({ providerId: thread.providerId });
  const connectAnother = () => openProviderAccounts({ providerId: thread.providerId, connect: true });

  const confirm = async () => {
    if (!target || submitting.current) return;
    submitting.current = true;
    setBusy(true);
    try {
      const next = await client.rebindThreadAccount(thread.id, target.id);
      submitting.current = false;
      dialogOpen.current = false;
      setTarget(null);
      onRebound(next);
      toast.show({
        tone: "success",
        title: `Switched to ${target.displayName}`,
        description: `Future messages use ${target.displayName}. Past history is unchanged.`,
      });
    } catch (error) {
      submitting.current = false;
      const failure = describeRebindError(error, {
        target: target.displayName,
        providerName: thread.providerName,
        thread,
      });
      toast.show({ tone: "danger", title: failure.title, description: failure.description });
      // Signing in is the way forward: keep the dialog open and offer it.
      if (failure.signIn) setSignInRequired(true);
      else {
        dialogOpen.current = false;
        setTarget(null);
      }
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  };

  // The command palette and KalVoice ask through the account-intent store; answer once per request.
  const request = useRebindRequest();
  const handled = useRef(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs per request; the rest is read fresh.
  useEffect(() => {
    if (!request || request.threadId !== thread.id || handled.current === request.nonce) return;
    handled.current = request.nonce;
    consumeRebindRequest(request.nonce);
    void (async () => {
      const accounts = await list.reload();
      if (accounts === null) {
        toast.show({
          tone: "danger",
          title: "Couldn't switch accounts",
          description: `KalCode couldn't read your ${thread.providerName} accounts. Nothing was changed.`,
        });
        return;
      }
      const account = accounts.find((candidate) => candidate.id === request.accountId);
      if (!account) {
        toast.show({
          tone: "danger",
          title: "Couldn't switch accounts",
          description: `That account isn't a connected ${thread.providerName} account. Choose one from the thread's account menu.`,
        });
        return;
      }
      if (account.id === current) {
        toast.show({ tone: "info", title: `This thread already uses ${account.displayName}` });
        return;
      }
      openDialog(account);
    })();
  }, [request, thread.id]);

  const trigger = archived ? (
    <span className={styles.static}>{label}</span>
  ) : (
    <DropdownMenu onOpenChange={(open) => open && void list.reload()}>
      <DropdownMenuTrigger asChild>
        <button
          ref={triggerRef}
          type="button"
          className={styles.trigger}
          aria-label={`${label}, ${thread.providerName} account. Switch account`}
        >
          <span className={styles.label}>{label}</span>
          <ChevronDown className={styles.chevron} aria-hidden="true" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        aria-labelledby={menuLabelId}
        minWidth={17}
        onCloseAutoFocus={(event) => {
          // The Rebind dialog takes focus (its Cancel button) when a choice opened it.
          if (dialogOpen.current) event.preventDefault();
        }}
      >
        <DropdownMenuLabel id={menuLabelId}>Switch account</DropdownMenuLabel>
        {list.state === "error" && list.accounts.length === 0 ? (
          <p className={styles.menuNote} role="status">
            Accounts couldn't load. Try again from Providers.
          </p>
        ) : list.state === "ready" && list.accounts.length === 0 ? (
          <p className={styles.menuNote}>No {thread.providerName} accounts yet.</p>
        ) : null}
        {list.accounts.length > 0 ? (
          <DropdownMenuRadioGroup
            value={current ?? ""}
            onValueChange={(id) => {
              if (id === current) return;
              const account = list.accounts.find((candidate) => candidate.id === id);
              if (account && accountStatus(account.authenticationState).usable) openDialog(account);
            }}
          >
            {list.accounts.map((account) => {
              const active = account.id === current;
              return (
                <DropdownMenuRadioItem
                  key={account.id}
                  value={account.id}
                  disabled={!accountStatus(account.authenticationState).usable}
                  description={describeAccount(account)}
                  textValue={account.displayName}
                >
                  <span className={styles.itemName}>
                    <span className={styles.itemLabel}>{account.displayName}</span>
                    {active ? (
                      <Badge tone="accent" className={styles.active}>
                        Active
                      </Badge>
                    ) : null}
                  </span>
                </DropdownMenuRadioItem>
              );
            })}
          </DropdownMenuRadioGroup>
        ) : null}
        <DropdownMenuSeparator />
        <DropdownMenuItem icon={<Plus />} onSelect={connectAnother}>
          Connect another {thread.providerName} account
        </DropdownMenuItem>
        <DropdownMenuItem icon={<Settings2 />} onSelect={openAccounts}>
          Manage provider accounts
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );

  return (
    <>
      {trigger}
      <RebindThreadDialog
        open={target !== null}
        from={label}
        to={target?.displayName ?? ""}
        busy={busy}
        blocker={rebindBlocker(thread, archived)}
        signInRequired={signInRequired}
        onConfirm={() => void confirm()}
        onCancel={closeDialog}
        onSignIn={() => {
          closeDialog();
          openAccounts();
        }}
        returnFocus={() => triggerRef.current?.focus()}
      />
    </>
  );
}
