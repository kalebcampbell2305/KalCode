import type { PermissionMode, ThreadOptions, ThreadSummary } from "@kalcode/protocol";
import {
  Button,
  EmptyState,
  ErrorState,
  Field,
  SegmentedControl,
  Select,
  Skeleton,
  TextArea,
  TextInput,
  useToast,
} from "@kalcode/ui/components";
import { type FormEvent, useCallback, useEffect, useId, useRef, useState } from "react";
import { type KalCodeError, toKalCodeError } from "../../ipc/errors.ts";
import { useRuntime } from "../../runtime/RuntimeProvider.tsx";
import { MOD_LABEL } from "../../shell/shortcuts.ts";
import { PERMISSION_MODES } from "./model.ts";
import styles from "./NewThread.module.css";

interface NewThreadProps {
  onCreated: (thread: ThreadSummary) => void;
  onCancel: () => void;
}

/** New thread flow: provider, model, workspace, permission mode (Approve by default), task. */
export function NewThread({ onCreated, onCancel }: NewThreadProps) {
  const { client } = useRuntime();
  const [options, setOptions] = useState<ThreadOptions | null>(null);
  const [loadError, setLoadError] = useState<KalCodeError | null>(null);

  const load = useCallback(() => {
    setLoadError(null);
    client
      .threadOptions()
      .then(setOptions)
      .catch((error) => setLoadError(toKalCodeError(error)));
  }, [client]);
  useEffect(load, [load]);

  return (
    <div className={styles.pane}>
      <div className={styles.inner}>
        <header className={styles.header}>
          <h2 className={styles.title}>New thread</h2>
          <p className={styles.description}>Give a provider a task in one of your workspaces.</p>
        </header>
        {loadError ? (
          <ErrorState
            title="Thread options couldn't load"
            code={`${loadError.category}/${loadError.code}`}
            actions={
              <>
                <Button onClick={load}>Try again</Button>
                <Button variant="ghost" onClick={onCancel}>
                  Cancel
                </Button>
              </>
            }
          >
            <p>{loadError.message}</p>
          </ErrorState>
        ) : !options ? (
          <div className={styles.loading} role="status" aria-busy="true">
            <span className="visually-hidden">Loading providers and workspaces</span>
            <Skeleton width="50%" />
            <Skeleton width="65%" />
            <Skeleton width="40%" />
          </div>
        ) : options.providers.length === 0 ? (
          <EmptyState title="No providers connected" actions={<Button onClick={onCancel}>Back to threads</Button>}>
            <p>
              A thread runs a provider you've connected, such as Claude Code, Codex or Gemini CLI. Connecting providers
              arrives with the Providers surface.
            </p>
          </EmptyState>
        ) : options.workspaces.length === 0 ? (
          <EmptyState title="No workspaces yet" actions={<Button onClick={onCancel}>Back to threads</Button>}>
            <p>
              A thread works inside a project folder you've added to KalCode. Adding workspaces arrives with the Code
              surface.
            </p>
          </EmptyState>
        ) : (
          <NewThreadForm options={options} onCreated={onCreated} onCancel={onCancel} />
        )}
      </div>
    </div>
  );
}

function NewThreadForm({ options, onCreated, onCancel }: { options: ThreadOptions } & NewThreadProps) {
  const { client } = useRuntime();
  const toast = useToast();
  const id = useId();
  const [providerId, setProviderId] = useState(options.providers[0]?.id ?? "");
  const [model, setModel] = useState("");
  const [workspaceId, setWorkspaceId] = useState(options.workspaces[0]?.id ?? "");
  const [mode, setMode] = useState<PermissionMode>(options.defaultPermissionMode);
  const [task, setTask] = useState("");
  const [name, setName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<KalCodeError | null>(null);
  const taskRef = useRef<HTMLTextAreaElement>(null);

  const provider = options.providers.find((p) => p.id === providerId);
  const modes = options.permissionModes;

  useEffect(() => {
    taskRef.current?.focus();
  }, []);

  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    if (submitting) return;
    if (!task.trim()) {
      setError(null);
      taskRef.current?.focus();
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const thread = await client.createThread({
        providerId,
        workspaceId,
        model: model || null,
        permissionMode: mode,
        prompt: task,
        name: name.trim() || null,
      });
      if (thread.status === "failed") {
        toast.show({
          tone: "danger",
          title: "The provider couldn't start",
          description: thread.error?.message ?? "Open the thread for details.",
        });
      }
      onCreated(thread);
    } catch (err) {
      setError(toKalCodeError(err));
      setSubmitting(false);
    }
  };

  return (
    <form
      className={styles.form}
      onSubmit={submit}
      onKeyDown={(event) => {
        if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
          event.preventDefault();
          void submit();
        } else if (event.key === "Escape" && !(event.target instanceof HTMLSelectElement)) {
          event.preventDefault();
          onCancel();
        }
      }}
      aria-describedby={error ? `${id}-error` : undefined}
    >
      <div className={styles.pair}>
        <Field htmlFor={`${id}-provider`} label="Provider">
          <Select
            id={`${id}-provider`}
            value={providerId}
            onChange={(event) => {
              setProviderId(event.target.value);
              setModel("");
            }}
          >
            {options.providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.accountLabel ? `${p.displayName} (${p.accountLabel})` : p.displayName}
              </option>
            ))}
          </Select>
        </Field>
        <Field htmlFor={`${id}-model`} label="Model">
          <Select id={`${id}-model`} value={model} onChange={(event) => setModel(event.target.value)}>
            <option value="">Provider default</option>
            {provider?.models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.displayName}
              </option>
            ))}
          </Select>
        </Field>
      </div>

      <Field htmlFor={`${id}-workspace`} label="Workspace">
        <Select id={`${id}-workspace`} value={workspaceId} onChange={(event) => setWorkspaceId(event.target.value)}>
          {options.workspaces.map((w) => (
            <option key={w.id} value={w.id}>
              {w.name}
            </option>
          ))}
        </Select>
      </Field>

      <div className={styles.field}>
        <p id={`${id}-mode-label`} className={styles.label}>
          Permissions
        </p>
        <SegmentedControl<PermissionMode>
          aria-labelledby={`${id}-mode-label`}
          value={mode}
          onValueChange={setMode}
          options={modes.map((m) => ({ value: m, label: PERMISSION_MODES[m].label }))}
        />
        <p className={styles.hint} aria-live="polite">
          {PERMISSION_MODES[mode].description}
          {provider && !provider.hostApprovals && mode !== "plan"
            ? ` ${provider.displayName} can't hand approvals to KalCode, so it runs in its own most restrictive mode.`
            : ""}
        </p>
      </div>

      <Field htmlFor={`${id}-task`} label="Task" hint="The first message the provider receives.">
        <TextArea
          ref={taskRef}
          id={`${id}-task`}
          rows={6}
          value={task}
          onChange={(event) => setTask(event.target.value)}
          placeholder="Describe what you want done"
          aria-describedby={`${id}-task-hint`}
          required
        />
      </Field>

      <Field htmlFor={`${id}-name`} label="Name" optional hint="Leave empty to name the thread from its task.">
        <TextInput
          id={`${id}-name`}
          value={name}
          maxLength={80}
          onChange={(event) => setName(event.target.value)}
          aria-describedby={`${id}-name-hint`}
        />
      </Field>

      {error ? (
        <p id={`${id}-error`} className={styles.error} role="alert">
          {error.message}
        </p>
      ) : null}

      <div className={styles.footer}>
        <Button type="submit" variant="primary" busy={submitting} disabled={!task.trim()}>
          Start thread
        </Button>
        <Button variant="ghost" onClick={onCancel} disabled={submitting}>
          Cancel
        </Button>
        <p className={styles.shortcut}>{MOD_LABEL} Enter to start</p>
      </div>
    </form>
  );
}
