import type { ProviderAccount, ProviderHealth, ProviderStatus } from "@kalcode/protocol";
import {
  Button,
  ErrorState,
  Field,
  Panel,
  ProviderMark,
  Select,
  Skeleton,
  StatusIndicator,
  TextInput,
} from "@kalcode/ui/components";
import { LogIn, Plus, Search, ShieldCheck } from "lucide-react";
import { type FormEvent, useEffect, useId, useMemo, useRef, useState } from "react";
import { accountProviderName } from "../../shell/accountCommands.ts";
import { AccountRow } from "./AccountRow.tsx";
import { accountName, sortAccounts } from "./accountIdentity.ts";
import { rateLimitText } from "./healthLabels.ts";
import styles from "./ProviderAccountsView.module.css";
import { sameSignInLabel } from "./providerLabels.ts";
import { consumeProviderAccountsRequest, useProviderAccountsRequest } from "./providersTab.ts";
import { isBrowserAuthProvider, NO_USAGE, useProviderAccounts } from "./useProviderAccounts.ts";

const PROVIDERS = [
  { id: "claude-code", name: "Claude Code" },
  { id: "codex", name: "Codex" },
  { id: "cursor", name: "Cursor" },
  { id: "gemini-cli", name: "Gemini CLI" },
] as const;

/** Above this many accounts the toolbar offers a filter. */
const FILTER_THRESHOLD = 6;
/** The toolbar's add form, which lets the person choose the provider. */
const ANY_PROVIDER = "*";

/** Setup's "Sign in": sign in this provider's default account (or add one when it has none). */
export interface ProviderSignInRequest {
  providerId: string;
  nonce: number;
}

interface ProviderEntry {
  id: string;
  name: string;
  /** KalCode can add accounts for it (one of the known providers). */
  addable: boolean;
}

export function ProviderAccountsView({
  enabled,
  statuses,
  health = null,
  signInRequest = null,
}: {
  enabled: boolean;
  statuses: ProviderStatus[] | null;
  /** Provider Health snapshots; only provider-wide limits are read from them. */
  health?: readonly ProviderHealth[] | null;
  signInRequest?: ProviderSignInRequest | null;
}) {
  const state = useProviderAccounts(enabled);
  const request = useProviderAccountsRequest();
  /** The provider whose add form is open, {@link ANY_PROVIDER} for the toolbar's, or null. */
  const [connecting, setConnecting] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const accounts = state.accounts;
  const loaded = accounts !== null;

  // Every known provider gets a section, plus any provider the backend returns accounts for, so
  // nothing is hidden.
  const providers = useMemo<ProviderEntry[]>(() => {
    const ids: string[] = PROVIDERS.map((provider) => provider.id);
    for (const account of accounts ?? []) if (!ids.includes(account.providerId)) ids.push(account.providerId);
    return ids.map((id) => ({
      id,
      name:
        statuses?.find((s) => s.id === id)?.displayName ??
        PROVIDERS.find((provider) => provider.id === id)?.name ??
        accountProviderName(id),
      addable:
        PROVIDERS.some((provider) => provider.id === id) &&
        (id !== "cursor" || !accounts?.some((account) => account.providerId === id)),
    }));
  }, [accounts, statuses]);

  // A request from elsewhere (the thread header's account menu): show that provider and, with
  // `connect`, open its add form. Handled once the accounts (and so the sections) are on screen.
  useEffect(() => {
    if (!request || !loaded) return;
    consumeProviderAccountsRequest(request.nonce);
    setFilter("");
    if (
      request.connect &&
      !(request.providerId === "cursor" && accounts?.some((account) => account.providerId === "cursor"))
    )
      setConnecting(request.providerId);
    document.getElementById(sectionId(request.providerId))?.scrollIntoView?.({ block: "start" });
  }, [request, loaded, accounts]);

  // Setup's Sign in: this view owns the browser sign-in (its row shows progress and Cancel), so it
  // starts it here. One request starts at most one sign-in, even if the effect re-runs.
  const handledSignIn = useRef(0);
  const { activeLogin, signInAuth } = state;
  useEffect(() => {
    if (!signInRequest || !accounts || handledSignIn.current === signInRequest.nonce) return;
    handledSignIn.current = signInRequest.nonce;
    const { providerId } = signInRequest;
    setFilter("");
    document.getElementById(sectionId(providerId))?.scrollIntoView?.({ block: "start" });
    const signedOut = sortAccounts(accounts.filter((account) => account.providerId === providerId)).filter(
      (account) => account.authenticationState !== "authenticated",
    );
    const target = signedOut[0];
    if (!target) {
      if (!accounts.some((account) => account.providerId === providerId)) setConnecting(providerId);
      return;
    }
    if (activeLogin === null && isBrowserAuthProvider(target.providerId)) void signInAuth(target);
  }, [signInRequest, accounts, activeLogin, signInAuth]);

  if (state.loadError && !accounts) {
    return (
      <ErrorState
        title="Provider accounts couldn't load"
        actions={<Button onClick={() => void state.load()}>Try again</Button>}
      >
        <p>{state.loadError}</p>
      </ErrorState>
    );
  }
  if (!accounts) {
    return (
      <Panel as="div" className={styles.loading} role="status" aria-busy="true">
        <span className="visually-hidden">Loading provider accounts</span>
        <Skeleton width="28%" />
        <Skeleton width="64%" />
        <Skeleton width="52%" />
      </Panel>
    );
  }

  const signedIn = accounts.filter((account) => account.authenticationState === "authenticated").length;
  const query = accounts.length > FILTER_THRESHOLD ? filter.trim().toLowerCase() : "";
  const matches = (account: ProviderAccount, providerName: string) =>
    !query ||
    [accountName(account), account.providerReportedIdentity ?? "", providerName].some((text) =>
      text.toLowerCase().includes(query),
    );
  const sections = providers.map((provider) => {
    const all = accounts.filter((account) => account.providerId === provider.id);
    return { provider, all, shown: sortAccounts(all.filter((account) => matches(account, provider.name))) };
  });
  const visible = query ? sections.filter((section) => section.shown.length > 0) : sections;
  const addable = providers.filter((provider) => provider.addable);

  return (
    <div className={styles.root}>
      <div className={styles.toolbar}>
        <div className={styles.toolbarText}>
          <p className={styles.summary}>
            {count(accounts.length, "account")} · {signedIn} signed in
          </p>
          <p className={styles.note}>
            <ShieldCheck aria-hidden="true" />
            <span>
              <strong>Provider-owned sign-in.</strong> Claude Code, Codex and Gemini use managed account profiles.
              Cursor uses its persistent native sign-in and settings; one Cursor account is supported. Credentials stay
              with the provider.
            </span>
          </p>
        </div>
        <div className={styles.toolbarActions}>
          {accounts.length > FILTER_THRESHOLD ? (
            <span className={styles.filter}>
              <Search aria-hidden="true" />
              <TextInput
                type="search"
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
                placeholder="Filter by name or email"
                aria-label="Filter accounts"
              />
            </span>
          ) : null}
          <Button
            size="sm"
            variant="primary"
            icon={<Plus />}
            onClick={() => setConnecting(ANY_PROVIDER)}
            disabled={state.activeLogin !== null || connecting === ANY_PROVIDER}
          >
            Add account
          </Button>
        </div>
      </div>

      {connecting === ANY_PROVIDER ? (
        <ConnectAccount
          providers={addable}
          busy={state.busyKey === "create"}
          create={state.create}
          signIn={state.signInAuth}
          onDone={() => setConnecting(null)}
        />
      ) : null}

      {visible.length === 0 ? (
        <p className={styles.empty} role="status">
          No accounts match “{filter.trim()}”.
        </p>
      ) : null}

      {visible.map(({ provider, all, shown }) => {
        const titleId = `${sectionId(provider.id)}-title`;
        const limit = providerLimit(health?.find((h) => h.providerId === provider.id));
        const providerSignedIn = all.filter((account) => account.authenticationState === "authenticated").length;
        const canAdd = provider.addable && connecting !== provider.id;
        const addButton = (
          <Button
            size="sm"
            variant="ghost"
            icon={<Plus />}
            onClick={() => setConnecting(provider.id)}
            disabled={state.activeLogin !== null}
          >
            Add {provider.name} account
          </Button>
        );
        return (
          <section key={provider.id} id={sectionId(provider.id)} className={styles.section} aria-labelledby={titleId}>
            <header className={styles.sectionHeader}>
              <div className={styles.sectionHeading}>
                <h2 id={titleId} className={styles.sectionTitle}>
                  <ProviderMark provider={provider.id} name={provider.name} tile size="sm" />
                </h2>
                <p className={styles.sectionMeta}>
                  {count(all.length, "account")} · {providerSignedIn} signed in
                </p>
                {limit ? (
                  <p className={styles.limit} title={limit.detail}>
                    <StatusIndicator tone="waiting">{limit.text}</StatusIndicator>
                    <span className={styles.limitScope}>Provider-wide</span>
                  </p>
                ) : null}
              </div>
              {canAdd && all.length > 0 ? addButton : null}
            </header>

            {connecting === provider.id ? (
              <ConnectAccount
                providers={[provider]}
                busy={state.busyKey === "create"}
                create={state.create}
                signIn={state.signInAuth}
                onDone={() => setConnecting(null)}
              />
            ) : null}

            {all.length === 0 ? (
              <div className={styles.emptyRow}>
                <p className={styles.empty}>No {provider.name} accounts yet.</p>
                {canAdd ? addButton : null}
              </div>
            ) : (
              <div className={styles.rows}>
                <div className={styles.columns} aria-hidden="true">
                  <span>Account</span>
                  <span>Health</span>
                  <span>Usage</span>
                  <span>Activity</span>
                  <span />
                </div>
                {shown.map((account) => (
                  <AccountRow
                    key={account.id}
                    account={account}
                    providerName={provider.name}
                    usage={state.usage ? (state.usage.get(account.id) ?? NO_USAGE) : null}
                    busyKey={state.busyKey}
                    activeLogin={state.activeLogin?.accountId === account.id}
                    loginInProgress={state.activeLogin !== null}
                    checking={state.checking.has(account.id)}
                    validationError={state.validationErrors.get(account.id) ?? null}
                    usageStale={state.usageStale}
                    usageRefreshing={state.usageRefreshing}
                    sameSignIn={sameSignInLabel(account, accounts)}
                    actions={state}
                  />
                ))}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}

function sectionId(providerId: string): string {
  return `provider-accounts-${providerId}`;
}

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

/**
 * A rate limit or used-up quota the provider reported. It applies to the whole provider, so it
 * is shown on the provider's section, never on one account.
 */
function providerLimit(health: ProviderHealth | undefined): { text: string; detail: string } | null {
  if (health?.capacity !== "backing_off") return null;
  const what = health.reasonCode === "quota_exhausted" ? "Quota used up" : "Rate limited";
  const reported = rateLimitText(health);
  return {
    text: health.backoffUntil ? `${what} · retry ${retryTime(health.backoffUntil)}` : what,
    detail: [reported.label, reported.detail].filter(Boolean).join(". "),
  };
}

/** "14:05" today, "Oct 2, 14:05" on another day. */
function retryTime(iso: string): string {
  const at = new Date(iso);
  const sameDay = at.toDateString() === new Date().toDateString();
  return sameDay
    ? at.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
    : at.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

/**
 * Add an account: KalCode adds a managed account (its own isolated provider profile), then runs
 * that provider's official browser sign-in for it. With one provider the form is that provider's;
 * from the toolbar the person chooses it. Nothing is inferred and no other account is touched.
 */
function ConnectAccount({
  providers,
  busy,
  create,
  signIn,
  onDone,
}: {
  providers: readonly ProviderEntry[];
  busy: boolean;
  create: (providerId: string, displayName: string) => Promise<ProviderAccount | null>;
  signIn: (account: ProviderAccount) => Promise<void>;
  onDone: () => void;
}) {
  const id = useId();
  const [providerId, setProviderId] = useState(providers[0]?.id ?? "claude-code");
  const [displayName, setDisplayName] = useState("");
  const providerName = providers.find((provider) => provider.id === providerId)?.name ?? providerId;
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const created = await create(providerId, displayName);
    if (!created) return;
    onDone();
    if (isBrowserAuthProvider(created.providerId)) await signIn(created);
  };
  return (
    <form className={styles.connectForm} onSubmit={(event) => void submit(event)}>
      {providers.length > 1 ? (
        <Field htmlFor={`${id}-provider`} label="Provider">
          <Select id={`${id}-provider`} value={providerId} onChange={(event) => setProviderId(event.target.value)}>
            {providers.map((provider) => (
              <option key={provider.id} value={provider.id}>
                {provider.name}
              </option>
            ))}
          </Select>
        </Field>
      ) : null}
      <Field
        htmlFor={`${id}-name`}
        label={`Name for the new ${providerName} account`}
        hint={
          providerId === "cursor"
            ? "A local name for your native Cursor sign-in. Cursor opens its official browser flow."
            : `Stored locally. ${providerName} then opens its own sign-in in your browser for this account only.`
        }
      >
        <TextInput
          id={`${id}-name`}
          value={displayName}
          maxLength={80}
          onChange={(event) => setDisplayName(event.target.value)}
          aria-describedby={`${id}-name-hint`}
          placeholder="Work"
          required
          autoFocus
        />
      </Field>
      <div className={styles.actions}>
        <Button type="submit" size="sm" variant="primary" icon={<LogIn />} busy={busy} disabled={!displayName.trim()}>
          Add and sign in
        </Button>
        <Button size="sm" variant="ghost" onClick={onDone} disabled={busy}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
