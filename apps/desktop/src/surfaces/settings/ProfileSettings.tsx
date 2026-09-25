import { Button, Panel, TextInput } from "@kalcode/ui/components";
import { Check, UserRound } from "lucide-react";
import { type FormEvent, useEffect, useId, useState } from "react";
import { useRuntime } from "../../runtime/RuntimeProvider.tsx";
import styles from "./SettingsPage.module.css";

/** Mirrors native `normalize_display_name`: the message for an invalid name, or null. */
export function displayNameProblem(raw: string): string | null {
  const trimmed = raw.trim();
  if ([...trimmed].length > 60) return "Use at most 60 characters.";
  const invisible = (c: number) =>
    c <= 0x1f ||
    (c >= 0x7f && c <= 0x9f) ||
    (c >= 0x200b && c <= 0x200f) ||
    (c >= 0x202a && c <= 0x202e) ||
    (c >= 0x2066 && c <= 0x2069) ||
    c === 0xfeff;
  if ([...trimmed].some((ch) => invisible(ch.codePointAt(0) ?? 0))) {
    return "Remove control or invisible formatting characters.";
  }
  return null;
}

/**
 * Settings → Profile (Z7-W2): the display name Home greets you by (`profile.displayName`).
 * Set only here; KalCode never reads the operating system's account name. Empty = no name
 * ("Welcome back.").
 */
export function ProfileSettings() {
  const { settings, updateSettings } = useRuntime();
  const id = useId();
  const saved = settings.displayName ?? "";
  const [value, setValue] = useState(saved);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  useEffect(() => setValue(saved), [saved]);
  const problem = displayNameProblem(value);
  const changed = value.trim() !== saved;
  const save = async (next: string) => {
    setBusy(true);
    await updateSettings({ displayName: next });
    setBusy(false);
    setDone(true);
    setTimeout(() => setDone(false), 2000);
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (problem || !changed || busy) return;
    await save(value);
  };
  return (
    <Panel id="profile" title="Profile" icon={<UserRound />} padding="none">
      <form className={styles.rows} onSubmit={submit}>
        <div className={styles.row}>
          <div className={styles.rowText}>
            <label htmlFor={id} className={styles.rowLabel}>
              Display name
            </label>
            <p id={`${id}-help`} className={styles.rowHelp}>
              Home greets you by this name. It stays on this computer; KalCode never reads your computer's account name.
              Leave it empty to be greeted without a name.
            </p>
            {problem ? (
              <p id={`${id}-error`} className={styles.fieldError} role="alert">
                {problem}
              </p>
            ) : null}
          </div>
          <div className={styles.profileControl}>
            <TextInput
              id={id}
              value={value}
              placeholder="Your name"
              maxLength={80}
              autoComplete="off"
              aria-invalid={problem ? true : undefined}
              aria-describedby={`${id}-help${problem ? ` ${id}-error` : ""}`}
              onChange={(e) => {
                setValue(e.target.value);
                setDone(false);
              }}
            />
            <div className={styles.profileButtons}>
              <Button type="submit" size="sm" variant="primary" busy={busy} disabled={!changed || problem !== null}>
                Save
              </Button>
              {saved ? (
                <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => void save("")}>
                  Clear
                </Button>
              ) : null}
              {done ? (
                <span className={styles.saved} role="status">
                  <Check aria-hidden="true" />
                  Saved
                </span>
              ) : null}
            </div>
          </div>
        </div>
      </form>
    </Panel>
  );
}
