import { Button, Panel, TextInput } from "@kalcode/ui/components";
import { Check, UserRound } from "lucide-react";
import { type FormEvent, useEffect, useId, useMemo, useRef, useState } from "react";
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
  const { client, settings, updateSettings } = useRuntime();
  const id = useId();
  const saved = settings.displayName ?? "";
  const lifetime = useMemo(
    () => ({
      client,
      active: false,
      epoch: 0,
      revision: 0,
      pending: null as symbol | null,
      timer: null as ReturnType<typeof setTimeout> | null,
    }),
    [client],
  );
  const live = useRef(lifetime);
  live.current = lifetime;
  const [form, setForm] = useState({ owner: lifetime, value: saved, saved, dirty: false, done: false });
  const value = form.owner === lifetime ? form.value : saved;
  const busy = lifetime.pending !== null;
  const done = form.owner === lifetime && form.done;
  useEffect(() => {
    lifetime.active = true;
    lifetime.epoch += 1;
    return () => {
      lifetime.active = false;
      lifetime.pending = null;
      if (lifetime.timer) clearTimeout(lifetime.timer);
    };
  }, [lifetime]);
  useEffect(() => {
    setForm((current) => {
      if (current.owner !== lifetime) return { owner: lifetime, value: saved, saved, dirty: false, done: false };
      if (current.saved === saved) return current;
      return {
        ...current,
        saved,
        // External updates may replace a clean field, never an edit or a pending draft.
        value: lifetime.pending === null && !current.dirty ? saved : current.value,
        done: current.done && current.value.trim() === saved,
      };
    });
  }, [saved, lifetime]);
  const problem = displayNameProblem(value);
  const changed = value.trim() !== saved;
  const save = async (next: string) => {
    if (live.current !== lifetime || !lifetime.active || lifetime.pending !== null) return;
    const request = Symbol();
    const epoch = lifetime.epoch;
    const revision = lifetime.revision;
    const isCurrent = () =>
      live.current === lifetime && lifetime.active && lifetime.epoch === epoch && lifetime.pending === request;
    lifetime.pending = request;
    if (lifetime.timer) clearTimeout(lifetime.timer);
    setForm((current) => ({ ...current, done: false }));
    let succeeded = false;
    try {
      succeeded = await updateSettings({ displayName: next });
    } finally {
      if (isCurrent()) {
        lifetime.pending = null;
        const unchanged = revision === lifetime.revision;
        setForm((current) =>
          current.owner === lifetime
            ? {
                ...current,
                value: succeeded && unchanged ? next.trim() : current.value,
                dirty: succeeded && unchanged ? false : current.dirty,
                done: succeeded && unchanged,
              }
            : current,
        );
        if (succeeded && unchanged) {
          lifetime.timer = setTimeout(() => {
            lifetime.timer = null;
            if (live.current === lifetime && lifetime.active && lifetime.epoch === epoch)
              setForm((current) => (current.owner === lifetime ? { ...current, done: false } : current));
          }, 2000);
        }
      }
    }
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
                lifetime.revision += 1;
                if (lifetime.timer) clearTimeout(lifetime.timer);
                setForm({ owner: lifetime, value: e.target.value, saved, dirty: true, done: false });
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
