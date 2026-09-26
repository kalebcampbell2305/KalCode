import type { ProviderAccount, ProviderStatus } from "@kalcode/protocol";
import {
  Badge,
  Button,
  ErrorState,
  Field,
  Panel,
  ProviderMark,
  Select,
  Skeleton,
  TextInput,
} from "@kalcode/ui/components";
import { LogIn, Plus, RefreshCw, ShieldCheck } from "lucide-react";
import { type FormEvent, useId, useMemo, useState } from "react";
import styles from "./ProviderAccountsView.module.css";
import { useProviderAccounts } from "./useProviderAccounts.ts";

const PROVIDERS = [
  { id: "claude-code", name: "Claude Code" },
  { id: "codex", name: "Codex" },
  { id: "gemini-cli", name: "Gemini CLI" },
] as const;

export function ProviderAccountsView({ enabled, statuses }: { enabled: boolean; statuses: ProviderStatus[] | null }) {
  const state = useProviderAccounts(enabled);
  const names = useMemo(
    () =>
      new Map(
        PROVIDERS.map((provider) => [
          provider.id,
          statuses?.find((s) => s.id === provider.id)?.displayName ?? provider.name,
        ]),
      ),
    [statuses],
  );

  if (state.loadError && !state.accounts) {
    return (
      <ErrorState
        title="Provider accounts couldn't load"
        actions={<Button onClick={() => void state.load()}>Try again</Button>}
      >
        <p>{state.loadError}</p>
      </ErrorState>
    );
  }
  if (!state.accounts) {
    return (
      <Panel as="div" className={styles.loading} role="status" aria-busy="true">
        <span className="visually-hidden">Loading provider accounts</span>
        <Skeleton width="28%" />
        <Skeleton width="64%" />
        <Skeleton width="52%" />
      </Panel>
    );
  }

  return (
    <div className={styles.root}>
      <Panel
        id="provider-account-safety"
        title="Accounts stay isolated"
        icon={<ShieldCheck />}
        description="Each account uses a managed provider profile. KalCode stores only display metadata here; credentials and provider profile paths stay outside the app interface."
        className={styles.safety}
      >
        <p className={styles.note}>
          Claude Code and Codex use their official browser sign-in flows. Gemini CLI authentication stays in a managed
          provider pane through <code>/auth</code>; its status remains Not checked until Gemini reports it natively.
        </p>
      </Panel>

      <AddAccount busy={state.busyKey === "create"} create={state.create} />

      {PROVIDERS.map((provider) => {
        const accounts = state.accounts?.filter((account) => account.providerId === provider.id) ?? [];
        const name = names.get(provider.id) ?? provider.name;
        return (
          <Panel
            key={provider.id}
            id={`provider-accounts-${provider.id}`}
            title={<ProviderMark provider={provider.id} name={name} tile size="md" />}
            count={accounts.length}
            description={
              accounts.length === 0
                ? "No managed accounts yet."
                : "Choose the exact account for each new thread or pane."
            }
            className={styles.provider}
          >
            {accounts.length === 0 ? (
              <p className={styles.empty}>Add an account above to use an isolated profile for this provider.</p>
            ) : (
              <div className={styles.accounts}>
                {accounts.map((account) => (
                  <AccountCard
                    key={account.id}
                    account={account}
                    providerName={name}
                    busyKey={state.busyKey}
                    activeLogin={state.activeLogin?.accountId === account.id}
                    loginInProgress={state.activeLogin !== null}
                    rename={state.rename}
                    setDefault={state.setDefault}
                    archive={state.archive}
                    refreshAuth={state.refreshAuth}
                    signInAuth={state.signInAuth}
                    cancelLogin={state.cancelLogin}
                    logoutAuth={state.logoutAuth}
                    openGeminiAuth={state.openGeminiAuth}
                  />
                ))}
              </div>
            )}
          </Panel>
        );
      })}
    </div>
  );
}

function AddAccount({
  busy,
  create,
}: {
  busy: boolean;
  create: (providerId: string, displayName: string) => Promise<ProviderAccount | null>;
}) {
  const id = useId();
  const [providerId, setProviderId] = useState("claude-code");
  const [displayName, setDisplayName] = useState("");
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const created = await create(providerId, displayName);
    if (created) setDisplayName("");
  };
  return (
    <Panel
      id="add-provider-account"
      title="Add provider account"
      description="Use a local name such as Personal or Work."
    >
      <form className={styles.addForm} onSubmit={(event) => void submit(event)}>
        <Field htmlFor={`${id}-provider`} label="Provider">
          <Select id={`${id}-provider`} value={providerId} onChange={(event) => setProviderId(event.target.value)}>
            {PROVIDERS.map((provider) => (
              <option key={provider.id} value={provider.id}>
                {provider.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field
          htmlFor={`${id}-name`}
          label="Account name"
          hint="Stored locally; this is never inferred from provider output."
        >
          <TextInput
            id={`${id}-name`}
            value={displayName}
            maxLength={80}
            onChange={(event) => setDisplayName(event.target.value)}
            aria-describedby={`${id}-name-hint`}
            placeholder="Personal"
            required
          />
        </Field>
        <Button type="submit" variant="primary" icon={<Plus />} busy={busy} disabled={!displayName.trim()}>
          Add account
        </Button>
      </form>
    </Panel>
  );
}

function AccountCard({
  account,
  providerName,
  busyKey,
  activeLogin,
  loginInProgress,
  rename,
  setDefault,
  archive,
  refreshAuth,
  signInAuth,
  cancelLogin,
  logoutAuth,
  openGeminiAuth,
}: {
  account: ProviderAccount;
  providerName: string;
  busyKey: string | null;
  activeLogin: boolean;
  loginInProgress: boolean;
  rename: (accountId: string, displayName: string) => Promise<ProviderAccount | null>;
  setDefault: (accountId: string) => Promise<ProviderAccount | null>;
  archive: (accountId: string) => Promise<ProviderAccount | null>;
  refreshAuth: (account: ProviderAccount) => Promise<ProviderAccount | null>;
  signInAuth: (account: ProviderAccount) => Promise<void>;
  cancelLogin: () => Promise<void>;
  logoutAuth: (account: ProviderAccount) => Promise<ProviderAccount | null>;
  openGeminiAuth: (account: ProviderAccount) => Promise<void>;
}) {
  const id = useId();
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(account.displayName);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const busy = busyKey?.endsWith(account.id) ?? false;
  const status = authPresentation(account.authenticationState);

  const saveName = async (event: FormEvent) => {
    event.preventDefault();
    const updated = await rename(account.id, name);
    if (updated) setRenaming(false);
  };

  return (
    <section className={styles.account} aria-label={`${providerName} account ${account.displayName}`}>
      <div className={styles.accountTop}>
        <div className={styles.accountIdentity}>
          <h3>{account.displayName}</h3>
          {account.providerReportedIdentity ? <p>{account.providerReportedIdentity}</p> : null}
        </div>
        <div className={styles.badges}>
          {account.isDefault ? <Badge tone="accent">Default</Badge> : null}
          <Badge tone={status.tone}>{status.label}</Badge>
        </div>
      </div>

      {activeLogin ? (
        <div className={styles.loginState} role="status">
          <span>Waiting for browser sign-in to finish…</span>
          <Button
            size="sm"
            variant="ghost"
            busy={busyKey === `cancel:${account.id}`}
            onClick={() => void cancelLogin()}
          >
            Cancel sign-in
          </Button>
        </div>
      ) : null}

      {renaming ? (
        <form className={styles.renameForm} onSubmit={(event) => void saveName(event)}>
          <Field htmlFor={`${id}-rename`} label={`Account name for ${account.displayName}`}>
            <TextInput
              id={`${id}-rename`}
              value={name}
              maxLength={80}
              onChange={(event) => setName(event.target.value)}
              required
              autoFocus
            />
          </Field>
          <div className={styles.actions}>
            <Button type="submit" size="sm" busy={busyKey === `rename:${account.id}`} disabled={!name.trim()}>
              Save account name
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setName(account.displayName);
                setRenaming(false);
              }}
            >
              Cancel rename
            </Button>
          </div>
        </form>
      ) : (
        <div className={styles.actions}>
          {!account.isDefault ? (
            <Button
              size="sm"
              onClick={() => void setDefault(account.id)}
              busy={busyKey === `default:${account.id}`}
              disabled={busy}
              aria-label={`Make ${account.displayName} default`}
            >
              Make default
            </Button>
          ) : null}
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setRenaming(true)}
            disabled={busy}
            aria-label={`Rename ${account.displayName}`}
          >
            Rename
          </Button>
          {account.providerId === "codex" || account.providerId === "claude-code" ? (
            <>
              {account.authenticationState === "authenticated" ? (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => void logoutAuth(account)}
                  busy={busyKey === `logout:${account.id}`}
                  disabled={busy}
                  aria-label={`Sign out ${account.displayName}`}
                >
                  Sign out
                </Button>
              ) : (
                <Button
                  size="sm"
                  icon={<LogIn />}
                  onClick={() => void signInAuth(account)}
                  busy={busyKey === `login:${account.id}`}
                  disabled={busy || loginInProgress}
                  aria-label={`Sign in ${account.displayName}`}
                >
                  Sign in
                </Button>
              )}
              <Button
                size="sm"
                variant="ghost"
                icon={<RefreshCw />}
                onClick={() => void refreshAuth(account)}
                busy={busyKey === `refresh:${account.id}`}
                disabled={busy || activeLogin}
                aria-label={`Refresh ${account.displayName} sign-in status`}
              >
                Refresh
              </Button>
            </>
          ) : null}
          {account.providerId === "gemini-cli" ? (
            <Button
              size="sm"
              icon={<LogIn />}
              onClick={() => void openGeminiAuth(account)}
              busy={busyKey === `gemini-auth:${account.id}`}
              disabled={busy}
              aria-label={`Open ${account.displayName} Gemini sign-in pane`}
            >
              Open /auth pane
            </Button>
          ) : null}
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setConfirmRemove(true)}
            disabled={busy || activeLogin}
            aria-label={`Remove ${account.displayName} from KalCode`}
          >
            Remove
          </Button>
        </div>
      )}

      {confirmRemove ? (
        <fieldset className={styles.confirm}>
          <legend className="visually-hidden">Remove {account.displayName} from KalCode</legend>
          <p>Removing this entry doesn't sign out of {providerName} or delete provider credentials.</p>
          <div className={styles.actions}>
            <Button
              size="sm"
              variant="danger"
              busy={busyKey === `archive:${account.id}`}
              onClick={async () => {
                if (await archive(account.id)) setConfirmRemove(false);
              }}
              aria-label={`Confirm remove ${account.displayName}`}
            >
              Remove from KalCode
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirmRemove(false)} disabled={busy}>
              Keep account
            </Button>
          </div>
        </fieldset>
      ) : null}
    </section>
  );
}

function authPresentation(state: ProviderAccount["authenticationState"]): {
  label: string;
  tone: "success" | "danger" | "outline";
} {
  if (state === "authenticated") return { label: "Signed in", tone: "success" };
  if (state === "not_authenticated") return { label: "Signed out", tone: "danger" };
  return { label: "Not checked", tone: "outline" };
}
