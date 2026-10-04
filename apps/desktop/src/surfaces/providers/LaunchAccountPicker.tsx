import type { ProviderAccount } from "@kalcode/protocol";
import { Button, Field, ProviderGlyph, Select, TextInput } from "@kalcode/ui/components";
import { LogIn } from "lucide-react";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { toKalCodeError } from "../../ipc/errors.ts";
import { accountName, accountSignIn, sortAccounts } from "./accountIdentity.ts";
import styles from "./LaunchAccountPicker.module.css";
import { useOptionalProviderAccountSessions } from "./ProviderAccountSessions.tsx";
import { isBrowserAuthProvider, useProviderAccounts } from "./useProviderAccounts.ts";

interface Props {
  providerId: string;
  providerName: string;
  accounts: readonly ProviderAccount[] | null;
  value: string;
  onChange: (accountId: string) => void;
  onReload: () => Promise<unknown>;
  disabled?: boolean;
  error?: string | null;
  hint?: ReactNode;
  onBusyChange?: (busy: boolean) => void;
}

/** Shared + rule: one account is implicit; several are selectable in the launch itself. */
export function LaunchAccountPicker({
  providerId,
  providerName,
  accounts,
  value,
  onChange,
  onReload,
  disabled = false,
  error,
  hint,
  onBusyChange,
}: Props) {
  const id = useId();
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);
  const [signingIn, setSigningIn] = useState(false);
  useEffect(() => {
    onBusyChange?.(signingIn);
  }, [onBusyChange, signingIn]);
  const retry = async () => {
    if (retrying || disabled) return;
    setRetrying(true);
    setRetryError(null);
    try {
      await onReload();
    } catch (failure) {
      setRetryError(toKalCodeError(failure).message);
    } finally {
      setRetrying(false);
    }
  };
  const sessions = useOptionalProviderAccountSessions();
  const candidates = sortAccounts((accounts ?? []).filter((a) => a.providerId === providerId && a.archivedAt === null));
  const selected = candidates.find((a) => a.id === value);
  const option = (account: ProviderAccount) =>
    [
      accountName(account),
      ...(account.isDefault ? ["Default"] : []),
      ...(account.authenticationState !== "authenticated" ? [accountSignIn(account).label] : []),
      ...(sessions?.checking.has(account.id) ? ["Checking…"] : []),
      ...(sessions?.validationErrors.has(account.id) ? ["Check unavailable"] : []),
    ].join(" · ");
  return (
    <div className={styles.root}>
      <Field htmlFor={id} label="Account" hint={hint}>
        {candidates.length > 1 ? (
          <Select
            id={id}
            value={value}
            disabled={disabled || signingIn}
            onChange={(event) => onChange(event.target.value)}
          >
            {!selected ? <option value="">Choose an account</option> : null}
            {candidates.map((account) => (
              <option key={account.id} value={account.id}>
                {option(account)}
              </option>
            ))}
          </Select>
        ) : (
          <output id={id} className={styles.identity}>
            <ProviderGlyph provider={providerId} size="xs" />
            <span className={styles.name} role={error ? "alert" : undefined}>
              {error
                ? "Accounts unavailable"
                : accounts === null
                  ? "Restoring accounts…"
                  : selected
                    ? option(selected)
                    : `No ${providerName} account added yet`}
            </span>
          </output>
        )}
      </Field>
      {error && candidates.length > 1 ? (
        <p className={styles.hint} role="alert">
          Accounts unavailable
        </p>
      ) : null}
      {retryError ? (
        <p className={styles.hint} role="alert">
          {retryError}
        </p>
      ) : null}
      {error || retryError ? (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          busy={retrying}
          disabled={disabled}
          onClick={() => void retry()}
        >
          Try again
        </Button>
      ) : null}
      {accounts !== null && !error && isBrowserAuthProvider(providerId) ? (
        <LaunchSignIn
          key={providerId}
          providerId={providerId}
          providerName={providerName}
          account={selected}
          needed={candidates.length === 0 || selected?.authenticationState === "not_authenticated"}
          disabled={disabled}
          onReload={onReload}
          onBusyChange={setSigningIn}
        />
      ) : null}
    </div>
  );
}

/** Uses the existing provider-owned authentication flow without leaving the launch form. */
export function LaunchSignIn({
  providerId,
  providerName,
  account,
  needed,
  disabled,
  onReload,
  onBusyChange,
  onConnected,
  reconnect = false,
}: {
  providerId: string;
  providerName: string;
  account: ProviderAccount | undefined;
  needed: boolean;
  disabled: boolean;
  onReload: () => Promise<unknown>;
  onBusyChange: (busy: boolean) => void;
  onConnected?: (account: ProviderAccount) => Promise<void>;
  reconnect?: boolean;
}) {
  const auth = useProviderAccounts(false);
  const [name, setName] = useState("");
  const [starting, setStarting] = useState(false);
  const [reloadError, setReloadError] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const reload = useRef(onReload);
  reload.current = onReload;
  const id = useId();
  const busy = starting || auth.busyKey !== null || auth.activeLogin !== null;
  useEffect(() => {
    onBusyChange(busy);
    return () => onBusyChange(false);
  }, [busy, onBusyChange]);
  const signIn = async () => {
    if (busy || disabled) return;
    setStarting(true);
    setReloadError(null);
    try {
      const target = account ?? (await auth.create(providerId, name.trim() || "Personal"));
      if (!mounted.current) return;
      const connected = target ? await auth.signInAuth(target) : null;
      if (!mounted.current) return;
      await reload.current();
      if (!mounted.current) return;
      if (connected?.authenticationState === "authenticated") {
        if (connected.id !== target?.id || connected.providerId !== providerId) {
          setReloadError("The connected account did not match this launch. Choose the account again.");
          return;
        }
        await onConnected?.(connected);
      }
    } catch (error) {
      setReloadError(toKalCodeError(error).message);
    } finally {
      setStarting(false);
    }
  };
  if (!needed && !busy && !reloadError) return null;
  return (
    <div className={styles.signIn}>
      {!account ? (
        <Field htmlFor={id} label="Account name" optional>
          <TextInput
            id={id}
            value={name}
            placeholder="Personal"
            maxLength={80}
            disabled={busy || disabled}
            onChange={(event) => setName(event.target.value)}
          />
        </Field>
      ) : null}
      <div className={styles.actions}>
        <Button type="button" size="sm" icon={<LogIn />} busy={busy} disabled={disabled} onClick={() => void signIn()}>
          {account ? (reconnect ? "Reconnect" : `Sign in to ${accountName(account)}`) : `Add ${providerName} account`}
        </Button>
        {auth.activeLogin ? (
          <Button type="button" size="sm" variant="ghost" onClick={() => void auth.cancelLogin()}>
            Cancel sign-in
          </Button>
        ) : null}
      </div>
      {auth.activeLogin ? (
        <p className={styles.hint} role="status">
          Finish signing in in your browser. Your launch stays here.
        </p>
      ) : null}
      {reloadError ? (
        <p className={styles.hint} role="alert">
          {reloadError}
        </p>
      ) : null}
    </div>
  );
}
