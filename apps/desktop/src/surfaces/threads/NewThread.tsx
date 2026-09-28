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
import { type FormEvent, useCallback, useEffect, useId, useRef, useState } from "react";
import { useAccount } from "../../account/AccountProvider.tsx";
import { PromptWarningDialog } from "../../context/PromptWarningDialog.tsx";
import { usePromptConfirmation } from "../../context/usePromptConfirmation.ts";
import type { CreateThreadInput } from "../../ipc/client.ts";
import { type KalCodeError, toKalCodeError } from "../../ipc/errors.ts";
import { useRuntime } from "../../runtime/RuntimeProvider.tsx";
import { useWorkspaces } from "../../runtime/WorkspaceProvider.tsx";
import { useNavigation } from "../../shell/navigation.tsx";
import { MOD_LABEL } from "../../shell/shortcuts.ts";
import { openProviderAccounts } from "../providers/providersTab.ts";
import { PERMISSION_MODES, providerModeNote, type UnavailableProvider, unavailableProviders } from "./model.ts";
import styles from "./NewThread.module.css";

interface NewThreadProps {
  onCreated: (thread: ThreadSummary) => void;
  onCancel: () => void;
}

/** New thread flow: provider, model, workspace, permission mode (Approve by default), task. */
export function NewThread({ onCreated, onCancel }: NewThreadProps) {
  const { client } = useRuntime();
  const { navigate } = useNavigation();
  const [options, setOptions] = useState<ThreadOptions | null>(null);
  const [accounts, setAccounts] = useState<ProviderAccount[] | null>(null);
  const [bindings, setBindings] = useState<ProviderAccountBinding[]>([]);
  const [unavailable, setUnavailable] = useState<UnavailableProvider[]>([]);
  const [loadError, setLoadError] = useState<KalCodeError | null>(null);

  const load = useCallback(() => {
    setLoadError(null);
    // Workspace defaults are read with the accounts: if they can't load, the form doesn't guess a
    // different account; it shows the error instead.
    Promise.all([
      client.threadOptions(),
      client.listProviderAccounts(),
      client.listProviderAccountBindings({ kind: "workspace" }),
    ])
      .then(async ([next, providerAccounts, workspaceBindings]) => {
        // `thread_options` runs provider detection first when it hasn't run yet, so the cached
        // statuses explain every provider that isn't offered.
        const statuses: ProviderStatus[] = await client.listProviders().catch(() => []);
        setUnavailable(unavailableProviders(statuses, new Set(next.providers.map((p) => p.id))));
        setAccounts(providerAccounts);
        setBindings(workspaceBindings);
        setOptions(next);
      })
      .catch((error) => setLoadError(toKalCodeError(error)));
  }, [client]);
  useEffect(load, [load]);

  return (
    <div className={styles.pane}>
      <div className={styles.inner}>
        <header className={styles.header}>
          <p className={styles.eyebrow}>Launch</p>
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
        ) : !options || !accounts ? (
          <div className={styles.loading} role="status" aria-busy="true">
            <span className="visually-hidden">Loading providers and workspaces</span>
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
                <Button onClick={() => navigate("providers")}>Go to Providers</Button>
                <Button variant="ghost" onClick={onCancel}>
                  Back to threads
                </Button>
              </>
            }
          >
            <p>
              Threads run Claude Code with your own sign-in. Install it or sign in with its CLI, then check again on the
              Providers page.
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
}: {
  options: ThreadOptions;
  accounts: readonly ProviderAccount[];
  bindings: readonly ProviderAccountBinding[];
  unavailable: readonly UnavailableProvider[];
} & NewThreadProps) {
  const { client } = useRuntime();
  const account = useAccount();
  const { navigate } = useNavigation();
  const toast = useToast();
  const id = useId();
  // New threads start in the active workspace (the one the rail and Code show), when it can run one.
  const activeWorkspaceId = useWorkspaces().active?.id ?? null;
  const offered = (workspace: string | null): workspace is string =>
    workspace !== null && options.workspaces.some((w) => w.id === workspace);
  const initialProvider = options.providers[0]?.id ?? "";
  const initialWorkspace = offered(activeWorkspaceId) ? activeWorkspaceId : (options.workspaces[0]?.id ?? "");
  const [providerId, setProviderId] = useState(initialProvider);
  const [providerAccountId, setProviderAccountId] = useState(() =>
    preselectAccount(accounts, bindings, initialProvider, initialWorkspace),
  );
  const [model, setModel] = useState("");
  const [workspaceId, setWorkspaceId] = useState(initialWorkspace);
  const [remember, setRemember] = useState(false);
  const [mode, setMode] = useState<PermissionMode>(options.defaultPermissionMode);
  const [task, setTask] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<KalCodeError | null>(null);
  const taskRef = useRef<HTMLTextAreaElement>(null);

  const provider = options.providers.find((p) => p.id === providerId);
  const providerAccounts = accounts.filter((account) => account.providerId === providerId);
  const providerAccount = providerAccounts.find((account) => account.id === providerAccountId);
  const workspaceBinding = bindingFor(bindings, providerId, workspaceId);
  const accountReady = providerAccount != null && providerAccount.authenticationState !== "not_authenticated";
  const modes = options.permissionModes;
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
  const launchDetail = providerAccount ? `${modelName} · ${providerAccount.displayName}` : modelName;

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
    const input: CreateThreadInput = {
      providerId,
      providerAccountId,
      workspaceId,
      model: model || null,
      permissionMode: mode,
      prompt: task,
      name: name.trim() || null,
      confirmBypass: false,
      profileId: null,
    };
    // Captured now: the choice the person confirmed, not whatever the form shows later.
    const rememberFor =
      remember && workspaceBinding?.accountId !== providerAccountId && providerAccount && workspace && provider
        ? { account: providerAccount, workspace, providerName: provider.displayName }
        : null;
    const finish = async (thread: ThreadSummary) => {
      if (rememberFor) {
        try {
          await client.bindProviderAccount(providerId, "workspace", rememberFor.workspace.id, rememberFor.account.id);
          toast.show({
            tone: "success",
            title: `New ${rememberFor.providerName} threads in ${rememberFor.workspace.name} use ${rememberFor.account.displayName}`,
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
            <Field
              htmlFor={`${id}-account`}
              label="Account"
              hint={
                providerAccounts.length === 0 ? (
                  "Add a managed account before starting this provider."
                ) : (
                  <>
                    {providerAccount ? (
                      <span className={styles.accountSource}>
                        {sourceText(providerAccount, workspaceBinding, workspace?.name)}
                      </span>
                    ) : null}{" "}
                    {providerAccount?.authenticationState === "not_authenticated"
                      ? "Sign in to this account under Providers before starting."
                      : "This exact isolated provider profile will run the thread."}
                  </>
                )
              }
            >
              <Select
                id={`${id}-account`}
                value={providerAccountId}
                onChange={(event) => {
                  confirmation.cancel();
                  setProviderAccountId(event.target.value);
                }}
                aria-describedby={`${id}-account-hint`}
                disabled={providerAccounts.length === 0}
                required
              >
                {providerAccounts.length === 0 ? <option value="">No account added</option> : null}
                {providerAccounts.map((account) => (
                  <option key={account.id} value={account.id}>
                    {accountOption(account)}
                  </option>
                ))}
              </Select>
            </Field>
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
          {!accountReady ? (
            <div className={styles.accountNotice} role="status">
              <span>
                {providerAccounts.length === 0
                  ? `Add a ${provider?.displayName ?? "provider"} account before starting this thread.`
                  : `${providerAccount?.displayName ?? "This account"} is signed out.`}
              </span>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  // Opens this provider's section; with no account yet, its connect form too.
                  openProviderAccounts({ providerId, connect: providerAccounts.length === 0 });
                  navigate("providers");
                }}
              >
                Manage accounts
              </Button>
            </div>
          ) : null}
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
              {providerAccount.displayName}.
            </p>
          ) : null}
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
            aria-describedby={`${id}-task-hint`}
            required
          />
        </Field>

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
  const candidates = accounts.filter((account) => account.providerId === providerId);
  const bound = bindingFor(bindings, providerId, workspaceId);
  if (bound && candidates.some((account) => account.id === bound.accountId)) return bound.accountId;
  return candidates.find((account) => account.isDefault)?.id ?? candidates[0]?.id ?? "";
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

function accountOption(account: ProviderAccount): string {
  const qualifiers: string[] = [];
  if (account.isDefault) qualifiers.push("default");
  if (account.authenticationState === "not_authenticated") qualifiers.push("signed out");
  return qualifiers.length > 0 ? `${account.displayName} (${qualifiers.join(", ")})` : account.displayName;
}
