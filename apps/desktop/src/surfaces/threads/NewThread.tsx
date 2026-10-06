import type {
  PermissionMode,
  ProviderAccount,
  ProviderAccountBinding,
  ProviderStatus,
  ThreadOptions,
  ThreadSummary,
} from "@kalcode/protocol";
import {
  Badge,
  Button,
  EmptyState,
  ErrorState,
  Field,
  ProviderGlyph,
  ProviderMark,
  SegmentedControl,
  Select,
  Skeleton,
  TextArea,
  TextInput,
  useToast,
} from "@kalcode/ui/components";
import { FolderGit2, PlugZap } from "lucide-react";
import { type FormEvent, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { useAccount } from "../../account/AccountProvider.tsx";
import { PromptWarningDialog } from "../../context/PromptWarningDialog.tsx";
import { usePromptConfirmation } from "../../context/usePromptConfirmation.ts";
import type { CreateThreadInput } from "../../ipc/client.ts";
import { type KalCodeError, toKalCodeError } from "../../ipc/errors.ts";
import { usePersistentDraft } from "../../runtime/drafts.ts";
import { useRuntime } from "../../runtime/RuntimeProvider.tsx";
import { useWorkspaces } from "../../runtime/WorkspaceProvider.tsx";
import { useNavigation } from "../../shell/navigation.tsx";
import { MOD_LABEL } from "../../shell/shortcuts.ts";
import { preselectLaunchAccount } from "../code/panes/agentLaunch.ts";
import { PANE_PROVIDERS } from "../code/panes/paneChannel.ts";
import { providerIdentity } from "../code/panes/paneLabels.ts";
import { DEFAULT_MODE_CHOICES, MODE_LABELS, startModeFor, usePermissions } from "../permissions/index.ts";
import { accountName, sortAccounts } from "../providers/accountIdentity.ts";
import { LaunchAccountPicker } from "../providers/LaunchAccountPicker.tsx";
import { useOptionalProviderAccountSessions } from "../providers/ProviderAccountSessions.tsx";
import type { NewThreadPrefill } from "./intent.tsx";
import { PERMISSION_MODES, providerModeNote, type UnavailableProvider, unavailableProviders } from "./model.ts";
import styles from "./NewThread.module.css";

interface NewThreadProps {
  onCreated: (thread: ThreadSummary) => void;
  onCancel: () => void;
  /** Choices to start from (KalVoice); the person still reviews them and presses Start thread. */
  prefill?: NewThreadPrefill;
}

/** New thread flow: provider, model, workspace, permission mode (the saved default, else Auto), task. */
export function NewThread({ onCreated, onCancel, prefill }: NewThreadProps) {
  const { client } = useRuntime();
  const { navigate } = useNavigation();
  const [options, setOptions] = useState<ThreadOptions | null>(null);
  const sessions = useOptionalProviderAccountSessions();
  const sharedSessions = sessions !== null;
  const [localAccounts, setAccounts] = useState<ProviderAccount[] | null>(null);
  const accounts = sessions ? sessions.accounts : localAccounts;
  const activeWorkspaceId = useWorkspaces().active?.id ?? "";
  const [earlyProvider, setEarlyProvider] = useState(prefill?.providerId ?? "claude-code");
  const [earlyAccount, setEarlyAccount] = useState(prefill?.providerAccountId ?? "");
  const [earlySigningIn, setEarlySigningIn] = useState(false);
  const [bindingsReady, setBindingsReady] = useState(false);
  const [bindings, setBindings] = useState<ProviderAccountBinding[]>([]);
  const [unavailable, setUnavailable] = useState<UnavailableProvider[]>([]);
  const [loadError, setLoadError] = useState<KalCodeError | null>(null);

  const load = useCallback(() => {
    setLoadError(null);
    if (!sharedSessions)
      client
        .listProviderAccounts()
        .then(setAccounts)
        .catch((error) => setLoadError(toKalCodeError(error)));
    // Local accounts are selectable while provider/model detection is still running.
    client
      .listProviderAccountBindings({ kind: "workspace" })
      .then((next) => {
        setBindings(next);
        setBindingsReady(true);
      })
      .catch((error) => setLoadError(toKalCodeError(error)));
    client
      .threadOptions()
      .then((next) => {
        const chatOptions = { ...next, providers: next.providers.filter((provider) => provider.id !== "cursor") };
        setOptions(chatOptions);
        void client
          .listProviders()
          .then((statuses: ProviderStatus[]) => {
            setUnavailable(unavailableProviders(statuses, new Set(chatOptions.providers.map((p) => p.id))));
          })
          .catch(() => undefined);
      })
      .catch((error) => setLoadError(toKalCodeError(error)));
  }, [client, sharedSessions]);
  useEffect(load, [load]);
  const reloadAccounts = async () => {
    if (sessions) await sessions.reload();
    else setAccounts(await client.listProviderAccounts());
    // A ready form keeps its draft and choices. Account recovery doesn't need another
    // provider/model probe; only an unavailable provider needs options rediscovery.
    if (!options || options.providers.length === 0) load();
  };
  const earlySelected = accounts?.some(
    (a) => a.id === earlyAccount && a.providerId === earlyProvider && a.archivedAt === null,
  )
    ? earlyAccount
    : preselectLaunchAccount(accounts ?? [], bindings, earlyProvider, prefill?.workspaceId ?? activeWorkspaceId);
  const earlyPicker = (
    <div className={styles.loading}>
      <Field htmlFor="new-thread-provider" label="Provider">
        <Select
          id="new-thread-provider"
          value={earlyProvider}
          disabled={earlySigningIn}
          onChange={(event) => {
            setEarlyProvider(event.target.value);
            setEarlyAccount("");
          }}
        >
          {PANE_PROVIDERS.filter((id) => id !== "cursor").map((providerId) => (
            <option key={providerId} value={providerId}>
              {providerIdentity(providerId).name}
            </option>
          ))}
        </Select>
      </Field>
      <LaunchAccountPicker
        providerId={earlyProvider}
        providerName={providerIdentity(earlyProvider).name}
        accounts={accounts}
        value={earlySelected}
        onChange={setEarlyAccount}
        onReload={reloadAccounts}
        error={sessions?.loadError}
        onBusyChange={setEarlySigningIn}
      />
    </div>
  );

  return (
    <div className={styles.pane}>
      <div className={styles.inner}>
        <header className={styles.header}>
          <p className={styles.eyebrow}>Launch</p>
          <h2 className={styles.title}>New thread</h2>
          <p className={styles.description}>Give a provider a task in one of your workspaces.</p>
        </header>
        {!options || !accounts || !bindingsReady || earlySigningIn || options.providers.length === 0
          ? earlyPicker
          : null}
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
        ) : !options || !accounts || !bindingsReady || earlySigningIn ? (
          <div className={styles.loading}>
            <span role="status">
              {earlySigningIn ? "Finish signing in to continue." : "Loading models and workspaces…"}
            </span>
            <Skeleton width="50%" />
            <Skeleton width="65%" />
            <Skeleton width="40%" />
          </div>
        ) : options.providers.length === 0 ? (
          <EmptyState
            art={<PlugZap />}
            title="No provider is ready for threads"
            actions={
              <>
                <Button onClick={load}>Check again</Button>
                <Button variant="ghost" onClick={() => navigate("providers")}>
                  Go to Providers
                </Button>
                <Button variant="ghost" onClick={onCancel}>
                  Back to threads
                </Button>
              </>
            }
          >
            <p>
              Threads run a provider's own CLI with your own sign-in.{" "}
              {unavailable.length > 0
                ? "Install one of the providers below or sign in to it"
                : "Install one or sign in"}
              , then check again here.
            </p>
            <ProviderAvailability providers={unavailable} />
          </EmptyState>
        ) : options.workspaces.length === 0 ? (
          <EmptyState
            art={<FolderGit2 />}
            title="No workspaces yet"
            actions={
              <>
                <Button onClick={() => navigate("code")}>Open Code</Button>
                <Button variant="ghost" onClick={onCancel}>
                  Back to threads
                </Button>
              </>
            }
          >
            <p>A thread works inside a project folder. Open one in Code first; it appears here as a workspace.</p>
          </EmptyState>
        ) : (
          <NewThreadForm
            options={options}
            accounts={accounts}
            bindings={bindings}
            unavailable={unavailable}
            onCreated={onCreated}
            onCancel={onCancel}
            onReloadAccounts={reloadAccounts}
            prefill={{
              ...prefill,
              providerId: earlyProvider,
              providerAccountId: earlyAccount || null,
              workspaceId: prefill?.workspaceId ?? null,
            }}
          />
        )}
      </div>
    </div>
  );
}

/** Why each provider KalCode knows isn't offered for threads. */
function ProviderAvailability({ providers }: { providers: readonly UnavailableProvider[] }) {
  if (providers.length === 0) return null;
  return (
    <ul className={styles.unavailable} aria-label="Not available for threads">
      {providers.map((p) => (
        <li key={p.id}>
          <ProviderGlyph provider={p.id} size="xs" tone="neutral" />
          <span className={styles.unavailableName}>{p.name}</span>
          <span className={styles.unavailableReason}>{p.reason}</span>
        </li>
      ))}
    </ul>
  );
}

function NewThreadForm({
  options,
  accounts,
  bindings,
  unavailable,
  onCreated,
  onCancel,
  prefill,
  onReloadAccounts,
}: {
  onReloadAccounts: () => Promise<unknown>;
  options: ThreadOptions;
  accounts: readonly ProviderAccount[];
  bindings: readonly ProviderAccountBinding[];
  unavailable: readonly UnavailableProvider[];
} & NewThreadProps) {
  const { client } = useRuntime();
  const account = useAccount();
  const toast = useToast();
  const id = useId();
  // New threads start in the active workspace (the one the rail and Code show), when it can run one.
  const activeWorkspaceId = useWorkspaces().active?.id ?? null;
  const offered = (workspace: string | null): workspace is string =>
    workspace !== null && options.workspaces.some((w) => w.id === workspace);
  // A prefill (KalVoice) wins where it names something this form offers; nothing starts until
  // the person presses Start thread.
  const initialProvider =
    prefill && options.providers.some((p) => p.id === prefill.providerId)
      ? prefill.providerId
      : (options.providers[0]?.id ?? "");
  const prefillWorkspace = prefill?.workspaceId ?? null;
  const initialWorkspace = offered(prefillWorkspace)
    ? prefillWorkspace
    : offered(activeWorkspaceId)
      ? activeWorkspaceId
      : (options.workspaces[0]?.id ?? "");
  const [providerId, setProviderId] = useState(initialProvider);
  const [chosenAccountId, setProviderAccountId] = useState(() => {
    const asked = prefill?.providerAccountId;
    if (asked && accounts.some((a) => a.id === asked && a.providerId === initialProvider)) return asked;
    return preselectAccount(accounts, bindings, initialProvider, initialWorkspace);
  });
  const [model, setModel] = useState("");
  const [workspaceId, setWorkspaceId] = useState(initialWorkspace);
  const [remember, setRemember] = useState(false);
  // Each thread gets its own worktree and branch unless the person opts out.
  const [isolate, setIsolate] = useState(true);
  const repository = useIsRepository(workspaceId);
  // The saved default when a thread can start in it, otherwise a safe startable fallback. Until
  // settings load, the runtime's answer applies the same rule natively.
  const { settings: permissionSettings } = usePermissions();
  const savedDefault = permissionSettings?.defaultMode ?? null;
  // KalCode runs without approvals: offer Bypass and read-only Plan only.
  const offeredModes = options.permissionModes.filter((m) => DEFAULT_MODE_CHOICES.includes(m));
  const modes = offeredModes.length > 0 ? offeredModes : options.permissionModes;
  const defaultMode = savedDefault
    ? startModeFor(savedDefault, modes)
    : startModeFor(options.defaultPermissionMode, modes);
  const [chosenMode, setMode] = useState<PermissionMode | null>(null);
  const mode = chosenMode ?? defaultMode;
  // A saved default that is no longer offered (Approve, Auto, Custom): the form says why.
  const unstartableDefault = savedDefault !== null && chosenMode === null && !modes.includes(savedDefault);
  const viewerId = account.snapshot.account?.id ?? null;
  const taskDraftScope = useMemo(
    () => (viewerId ? ({ kind: "new-thread", viewerId, workspaceId } as const) : null),
    [viewerId, workspaceId],
  );
  const persistedTask = usePersistentDraft(taskDraftScope);
  const task = persistedTask.text;
  const setTask = persistedTask.setText;
  const [name, setName] = useState("");
  const [error, setError] = useState<KalCodeError | null>(null);
  const taskRef = useRef<HTMLTextAreaElement>(null);

  const provider = options.providers.find((p) => p.id === providerId);
  const providerAccounts = sortAccounts(
    accounts.filter((account) => account.providerId === providerId && account.archivedAt === null),
  );
  const providerAccountId = providerAccounts.some((account) => account.id === chosenAccountId)
    ? chosenAccountId
    : preselectLaunchAccount(accounts, bindings, providerId, workspaceId);
  const providerAccount = providerAccounts.find((account) => account.id === providerAccountId);
  const workspaceBinding = bindingFor(bindings, providerId, workspaceId);
  const accountReady = providerAccount != null && providerAccount.authenticationState !== "not_authenticated";
  const workspace = options.workspaces.find((w) => w.id === workspaceId);
  const modelName = provider?.models.find((m) => m.id === model)?.displayName ?? "Provider default";
  const promptScope = [
    account.generation,
    account.snapshot.account?.id ?? "signed-out",
    account.runtime.phase,
    providerId,
    providerAccountId,
    workspaceId,
  ].join(":");
  const confirmation = usePromptConfirmation(promptScope, client);
  const cancelConfirmation = confirmation.cancel;
  const launchDetail = providerAccount ? `${modelName} · ${accountName(providerAccount)}` : modelName;

  useEffect(() => {
    taskRef.current?.focus();
  }, []);

  // A different workspace (or provider) re-resolves the account: that workspace's remembered
  // account first, then the provider default. The source line under the picker says which.
  const chooseWorkspace = useCallback(
    (next: string) => {
      setWorkspaceId(next);
      setProviderAccountId(preselectAccount(accounts, bindings, providerId, next));
    },
    [accounts, bindings, providerId],
  );

  // Switching workspace elsewhere (rail, palette, KalVoice) while this form is open moves the form
  // with it, so A → B → A restores A's account. Existing threads keep their own account.
  const followedWorkspace = useRef(activeWorkspaceId);
  useEffect(() => {
    if (activeWorkspaceId === followedWorkspace.current) return;
    followedWorkspace.current = activeWorkspaceId;
    if (activeWorkspaceId === null || !options.workspaces.some((w) => w.id === activeWorkspaceId)) return;
    cancelConfirmation();
    chooseWorkspace(activeWorkspaceId);
  }, [activeWorkspaceId, options.workspaces, chooseWorkspace, cancelConfirmation]);

  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    if (confirmation.busy) return;
    if (!task.trim()) {
      setError(null);
      taskRef.current?.focus();
      return;
    }
    if (!providerAccountId || !accountReady) return;
    setError(null);
    const submittedTask = task;
    const input: CreateThreadInput = {
      providerId,
      providerAccountId,
      workspaceId,
      model: model || null,
      permissionMode: mode,
      prompt: task,
      name: name.trim() || null,
      confirmBypass: mode === "bypass",
      profileId: null,
      isolate: isolate && repository === true,
    };
    // Captured now: the choice the person confirmed, not whatever the form shows later.
    const rememberFor =
      remember && workspaceBinding?.accountId !== providerAccountId && providerAccount && workspace && provider
        ? { account: providerAccount, workspace, providerName: provider.displayName }
        : null;
    const finish = async (thread: ThreadSummary) => {
      // Creation succeeded independently of saving an optional account preference. Clear now
      // so closing or reloading during that write cannot recover an already submitted task.
      if (thread.status !== "failed") {
        const result = persistedTask.clearSubmitted(submittedTask);
        if (result.problem) {
          toast.show({
            tone: "danger",
            title: "Thread started, but its saved task wasn't cleared",
            description: "It may reappear after restart. Delete it before starting another thread.",
          });
        }
      }
      // Remembered only once the thread was created and its provider started: a refused create
      // (onError) or a failed start writes no workspace default.
      if (rememberFor && thread.status !== "failed") {
        try {
          await client.bindProviderAccount(providerId, "workspace", rememberFor.workspace.id, rememberFor.account.id);
          toast.show({
            tone: "success",
            title: `New ${rememberFor.providerName} threads in ${rememberFor.workspace.name} use ${accountName(rememberFor.account)}`,
          });
        } catch (err) {
          toast.show({
            tone: "danger",
            title: "Workspace default wasn't saved",
            description: toKalCodeError(err).message,
          });
        }
      }
      onCreated(thread);
    };
    await confirmation.request({
      review: () => client.reviewCreateThreadPrompt(input),
      effect: (promptReviewId) => client.createThread(input, promptReviewId),
      onComplete: (thread) => {
        if (thread.status === "failed") {
          toast.show({
            tone: "danger",
            title: "The provider couldn't start",
            description: thread.error?.message ?? "Open the thread for details.",
          });
        }
        void finish(thread);
      },
      onError: (err) => setError(toKalCodeError(err)),
    });
  };

  const cancelAndExit = () => {
    confirmation.cancel();
    onCancel();
  };

  return (
    <>
      <form
        className={styles.form}
        onSubmit={submit}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
            event.preventDefault();
            void submit();
          } else if (event.key === "Escape" && !(event.target instanceof HTMLSelectElement)) {
            event.preventDefault();
            cancelAndExit();
          }
        }}
        aria-describedby={error ? `${id}-error` : undefined}
      >
        {provider ? (
          // A visual summary of the choices below; the controls themselves carry the state.
          <div className={styles.launch} aria-hidden="true">
            <ProviderMark provider={provider.id} name={provider.displayName} tile size="md" detail={launchDetail} />
            {workspace ? (
              <span className={styles.launchWhere}>
                in <strong>{workspace.name}</strong>
              </span>
            ) : null}
            <Badge tone={mode === "bypass" ? "danger" : "accent"} className={styles.launchMode}>
              {PERMISSION_MODES[mode].label} mode
            </Badge>
          </div>
        ) : null}
        <div className={styles.providerGroup}>
          <div className={styles.choices}>
            <Field htmlFor={`${id}-provider`} label="Provider">
              <Select
                id={`${id}-provider`}
                value={providerId}
                onChange={(event) => {
                  confirmation.cancel();
                  const nextProvider = event.target.value;
                  setProviderId(nextProvider);
                  setProviderAccountId(preselectAccount(accounts, bindings, nextProvider, workspaceId));
                  setModel("");
                }}
              >
                {options.providers.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.displayName}
                  </option>
                ))}
              </Select>
            </Field>
            <LaunchAccountPicker
              providerId={providerId}
              providerName={provider?.displayName ?? providerId}
              accounts={accounts}
              value={providerAccountId}
              onChange={(next) => {
                confirmation.cancel();
                setProviderAccountId(next);
              }}
              onReload={onReloadAccounts}
              disabled={confirmation.busy}
              hint={providerAccount ? sourceText(providerAccount, workspaceBinding, workspace?.name) : undefined}
            />
            <Field htmlFor={`${id}-model`} label="Model">
              <Select
                id={`${id}-model`}
                value={model}
                onChange={(event) => {
                  confirmation.cancel();
                  setModel(event.target.value);
                }}
              >
                <option value="">Provider default</option>
                {provider?.models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.displayName}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <ProviderAvailability providers={unavailable} />
        </div>

        <Field htmlFor={`${id}-workspace`} label="Workspace">
          <Select
            id={`${id}-workspace`}
            value={workspaceId}
            onChange={(event) => {
              confirmation.cancel();
              chooseWorkspace(event.target.value);
            }}
          >
            {options.workspaces.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </Select>
        </Field>

        <div className={styles.remember}>
          <label className={styles.rememberToggle}>
            <input
              type="checkbox"
              checked={remember}
              disabled={!providerAccount}
              aria-describedby={remember ? `${id}-remember-hint` : undefined}
              onChange={(event) => {
                confirmation.cancel();
                setRemember(event.target.checked);
              }}
            />
            Remember these accounts for this workspace
          </label>
          {remember && providerAccount && workspace ? (
            <p id={`${id}-remember-hint`} className={styles.hint}>
              New {provider?.displayName ?? "provider"} threads in {workspace.name} will start with{" "}
              {accountName(providerAccount)}.
            </p>
          ) : null}
        </div>

        <div className={styles.remember}>
          <label className={styles.rememberToggle}>
            <input
              type="checkbox"
              checked={isolate && repository === true}
              disabled={repository !== true}
              aria-describedby={`${id}-isolate-hint`}
              onChange={(event) => {
                confirmation.cancel();
                setIsolate(event.target.checked);
              }}
            />
            Run in its own worktree
          </label>
          <p id={`${id}-isolate-hint`} className={styles.hint}>
            {repository === false
              ? `${workspace?.name ?? "This workspace"} isn't a Git repository, so the thread works in the folder itself.`
              : repository === null
                ? "Checking the workspace's Git repository…"
                : isolate
                  ? "The thread works on its own branch in a separate folder, so parallel threads never collide."
                  : "The thread works directly in the workspace folder."}
          </p>
        </div>

        <div className={styles.field}>
          <p id={`${id}-mode-label`} className={styles.label}>
            Permissions
          </p>
          <SegmentedControl<PermissionMode>
            aria-labelledby={`${id}-mode-label`}
            value={mode}
            onValueChange={(next) => {
              confirmation.cancel();
              setMode(next);
            }}
            options={modes.map((m) => ({ value: m, label: PERMISSION_MODES[m].label }))}
          />
          {unstartableDefault && savedDefault ? (
            <p className={styles.hint} role="note">
              KalCode runs without approval prompts, so this thread starts in {MODE_LABELS[defaultMode]}.
            </p>
          ) : null}
          <p className={styles.hint} aria-live="polite">
            {PERMISSION_MODES[mode].description}
            {provider ? providerModeNote(provider, mode) : ""}
          </p>
        </div>

        <Field htmlFor={`${id}-task`} label="Task" hint="The first message the provider receives.">
          <TextArea
            ref={taskRef}
            id={`${id}-task`}
            rows={6}
            value={task}
            onChange={(event) => {
              confirmation.cancel();
              setTask(event.target.value);
            }}
            placeholder="Describe what you want done"
            aria-describedby={persistedTask.problem ? `${id}-task-hint ${id}-task-draft-error` : `${id}-task-hint`}
            required
          />
        </Field>
        {persistedTask.problem ? (
          <p id={`${id}-task-draft-error`} className={styles.error} role="alert">
            {persistedTask.problem.message}
          </p>
        ) : null}

        <Field htmlFor={`${id}-name`} label="Name" optional hint="Leave empty to name the thread from its task.">
          <TextInput
            id={`${id}-name`}
            value={name}
            maxLength={80}
            onChange={(event) => {
              confirmation.cancel();
              setName(event.target.value);
            }}
            aria-describedby={`${id}-name-hint`}
          />
        </Field>

        {error ? (
          <p id={`${id}-error`} className={styles.error} role="alert">
            {error.message}
          </p>
        ) : null}

        <div className={styles.footer}>
          <Button type="submit" variant="primary" busy={confirmation.busy} disabled={!task.trim() || !accountReady}>
            Start thread
          </Button>
          <Button variant="ghost" onClick={cancelAndExit} disabled={confirmation.busy}>
            Cancel
          </Button>
          <p className={styles.shortcut}>{MOD_LABEL} Enter to start</p>
        </div>
      </form>
      <PromptWarningDialog
        warning={confirmation.warning}
        busy={confirmation.busy}
        confirmLabel="Start thread anyway"
        onConfirm={() => void confirmation.confirm()}
        onCancel={confirmation.cancel}
      />
    </>
  );
}

function bindingFor(
  bindings: readonly ProviderAccountBinding[],
  providerId: string,
  workspaceId: string,
): ProviderAccountBinding | undefined {
  return bindings.find(
    (binding) => binding.kind === "workspace" && binding.providerId === providerId && binding.scopeId === workspaceId,
  );
}

/**
 * The account a new thread starts with, in the same order the runtime resolves one: the
 * workspace's remembered account, then the provider default, then the provider's first account.
 */
function preselectAccount(
  accounts: readonly ProviderAccount[],
  bindings: readonly ProviderAccountBinding[],
  providerId: string,
  workspaceId: string,
): string {
  return preselectLaunchAccount(accounts, bindings, providerId, workspaceId);
}

/** Why this account is selected, in words: the workspace's default, the provider default, or a pick. */
function sourceText(
  account: ProviderAccount,
  binding: ProviderAccountBinding | undefined,
  workspaceName: string | undefined,
): string {
  if (binding?.accountId === account.id) return `Workspace default for ${workspaceName ?? "this workspace"}.`;
  if (account.isDefault) return "Default account.";
  return "Chosen for this thread.";
}

/** Whether a workspace folder is in a Git repository (null while checking or when unknown). */
function useIsRepository(workspaceId: string): boolean | null {
  const { client } = useRuntime();
  const [state, setState] = useState<{ id: string; repository: boolean | null }>({ id: "", repository: null });
  useEffect(() => {
    if (!workspaceId) return;
    let cancelled = false;
    client.gitStatus(workspaceId, 1).then(
      (r) => {
        if (!cancelled) setState({ id: workspaceId, repository: r.repository });
      },
      () => {
        if (!cancelled) setState({ id: workspaceId, repository: null });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [client, workspaceId]);
  return state.id === workspaceId ? state.repository : null;
}
