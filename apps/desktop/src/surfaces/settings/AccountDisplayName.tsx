import { Button, TextInput } from "@kalcode/ui/components";
import { Check } from "lucide-react";
import { type FormEvent, type KeyboardEvent, useEffect, useId, useRef, useState } from "react";
import type { AccountUiError } from "../../account/accountState.ts";
import { accountDisplayNameProblem, emailName, kalcodeIdentity } from "../../account/displayName.ts";
import type { PublicAccount } from "../../ipc/account.ts";
import styles from "./AccountDisplayName.module.css";

/** What happened, and the most useful next step. */
export function displayNameErrorMessage(error: AccountUiError): string {
  switch (error.code) {
    case "invalid_display_name":
      return "That name can't be used. Use 1–64 characters, without control or invisible characters.";
    case "rate_limited":
      return "Your name wasn't changed: too many changes in a row. Wait a moment, then select Save again.";
    case "authentication_required":
      return "Your name wasn't changed because your session ended. Sign in again, then change it.";
    case "account_request_cancelled":
      return "Your name wasn't changed because your account changed while saving. Select Save to try again.";
    default:
      return error.retryable
        ? "Your name wasn't changed: KalCode couldn't reach your account. Check your connection, then select Save again."
        : "Your name wasn't changed: KalCode couldn't confirm the update. Select Save to try again.";
  }
}

const SAVED_FOR_MS = 2_000;

export interface AccountDisplayNameProps {
  account: PublicAccount;
  /** Saves the name (blank clears it); resolves to the failure, or null once saved. */
  onSave(displayName: string): Promise<AccountUiError | null>;
}

/**
 * Settings → KalCode account: the account's display name, edited in place. Saving shows the new
 * name everywhere at once (Account Hub, this panel); a failed save puts the saved name back and
 * says why. The email, sign-in and plan never change here.
 */
export function AccountDisplayName({ account, onSave }: AccountDisplayNameProps) {
  const id = useId();
  const saved = account.displayName ?? "";
  const [draft, setDraft] = useState(saved);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  // A name saved elsewhere (another device, a refresh) replaces an untouched field, never an edit.
  const shown = useRef(saved);
  useEffect(() => {
    if (shown.current === saved) return;
    shown.current = saved;
    if (!dirty && !saving) setDraft(saved);
  }, [saved, dirty, saving]);

  const problem = accountDisplayNameProblem(draft);
  const changed = draft.trim() !== saved;
  const { initials } = kalcodeIdentity(account.displayName, account.email);
  const fallback = emailName(account.email);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (problem || !changed || saving) return;
    const next = draft.trim();
    if (timer.current) clearTimeout(timer.current);
    setSaving(true);
    setDone(false);
    setError(null);
    const failure = await onSave(next);
    if (!mounted.current) return;
    setSaving(false);
    if (failure) {
      // Keep the typed name so Save can simply be tried again.
      setError(displayNameErrorMessage(failure));
      return;
    }
    setDraft(next);
    setDirty(false);
    setDone(true);
    timer.current = setTimeout(() => {
      timer.current = null;
      if (mounted.current) setDone(false);
    }, SAVED_FOR_MS);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Escape" || !dirty || saving) return;
    event.preventDefault();
    setDraft(saved);
    setDirty(false);
    setError(null);
  };

  const describedBy = [`${id}-hint`, problem ? `${id}-problem` : null, error ? `${id}-error` : null]
    .filter(Boolean)
    .join(" ");

  return (
    <form className={styles.identity} onSubmit={submit} aria-label="Display name" data-testid="account-display-name">
      <span className={styles.avatar} data-saving={saving || undefined} aria-hidden="true">
        {initials}
      </span>
      <div className={styles.body}>
        <label htmlFor={id} className={styles.label}>
          Display name
        </label>
        <div className={styles.controls}>
          <TextInput
            id={id}
            className={styles.input}
            value={draft}
            placeholder={fallback}
            maxLength={80}
            autoComplete="nickname"
            spellCheck={false}
            aria-invalid={problem ? true : undefined}
            aria-describedby={describedBy}
            onKeyDown={onKeyDown}
            onChange={(event) => {
              setDraft(event.target.value);
              setDirty(true);
              setDone(false);
              setError(null);
            }}
          />
          <Button type="submit" size="sm" variant="primary" busy={saving} disabled={!changed || problem !== null}>
            Save
          </Button>
          <span className={styles.saved} data-shown={done || undefined} role="status">
            {done ? (
              <>
                <Check aria-hidden="true" />
                Saved
              </>
            ) : null}
          </span>
        </div>
        {problem ? (
          <p id={`${id}-problem`} className={styles.problem}>
            {problem}
          </p>
        ) : null}
        {error ? (
          <p id={`${id}-error`} className={styles.error} role="alert">
            {error}
          </p>
        ) : null}
        <p id={`${id}-hint`} className={styles.hint}>
          {saved
            ? "Shown across KalCode on every device you sign in to. Your email and sign-in don't change."
            : `Shown across KalCode on every device you sign in to. Until you set one, KalCode uses “${fallback}”.`}
        </p>
      </div>
    </form>
  );
}
