import type { ProviderAccount, ProviderAccountBinding } from "@kalcode/protocol";
import { ProviderGlyph } from "@kalcode/ui/components";
import { Check, ChevronDown, Link2, LogIn, Plus, RefreshCw, Users, X } from "lucide-react";
import { Popover } from "radix-ui";
import { type CSSProperties, useCallback, useEffect, useId, useRef, useState } from "react";
import { toKalCodeError } from "../../ipc/errors.ts";
import { formatRelative } from "../../runtime/describeEvent.ts";
import { useRuntime } from "../../runtime/RuntimeProvider.tsx";
import { useWorkspaces } from "../../runtime/WorkspaceProvider.tsx";
import { useThreadSummaries } from "../../surfaces/dashboard/data/DashboardData.tsx";
import { accountFullLabel, accountName, sortAccounts } from "../../surfaces/providers/accountIdentity.ts";
import {
  type AccountUsageState,
  LOW_USAGE_PERCENT,
  primaryUsageLabel,
  resetsIn,
  type UsageWindow,
  usageSummary,
  useAccountUsage,
} from "../../surfaces/providers/accountUsage.ts";
import { rateLimitText } from "../../surfaces/providers/healthLabels.ts";
import { useOptionalProviderAccountSessions } from "../../surfaces/providers/ProviderAccountSessions.tsx";
import { sameSignInLabel } from "../../surfaces/providers/providerLabels.ts";
import {
  canRefreshProviderAuth,
  isBrowserAuthProvider,
  useProviderAccounts,
} from "../../surfaces/providers/useProviderAccounts.ts";
import { useSelectedCodeContext, useSelectedThread } from "../../surfaces/threads/accountIntent.ts";
import { ACCOUNT_PROVIDER_NAMES, accountProviderName } from "../accountCommands.ts";
import { useNavigation } from "../navigation.tsx";
import styles from "./AccountUsageCenter.module.css";
import {
  accountCenterHealthStatus,
  accountCenterStatus,
  focusedAccountSession,
  selectedLaunchAccount,
} from "./accountCenterModel.ts";
import { useDeckData } from "./DeckData.tsx";

/** A projection of the shared registry. Closing the popover must not cancel native browser login. */
export function AccountUsageCenter() {
  const { client } = useRuntime();
  const { active } = useWorkspaces();
  const { current } = useNavigation();
  const { health } = useDeckData();
  const sessions = useOptionalProviderAccountSessions();
  const [open, setOpen] = useState(false);
  const model = useProviderAccounts(open);
  const code = useSelectedCodeContext();
  const selectedThread = useSelectedThread();
  const threads = useThreadSummaries();
  const [bindings, setBindings] = useState<ProviderAccountBinding[] | null>(null);
  const [bindingError, setBindingError] = useState<string | null>(null);
  const [chosenProvider, setChosenProvider] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState("");
  const busy = useRef(false);
  const bindingGeneration = useRef(0);
  const titleId = useId();
  const accounts = model.accounts ?? [];
  const focused = focusedAccountSession(
    threads.state.status === "ready" ? threads.state.data : [],
    current,
    active?.id ?? null,
    code,
    selectedThread,
  );
  const focusedAccount = accounts.find((a) => a.id === focused?.providerAccountId) ?? null;
  const providerId = focused?.providerId ?? chosenProvider;
  const launchAccount =
    bindings && providerId ? selectedLaunchAccount(accounts, bindings, providerId, active?.id ?? null) : null;
  const chipAccount = focused ? focusedAccount : launchAccount;
  const canonicalChip = chipAccount ? sessions?.states.get(chipAccount.id) : undefined;
  const signInStatus = canonicalChip
    ? accountCenterHealthStatus(canonicalChip.health)
    : chipAccount
      ? accountCenterStatus(chipAccount, model.checking.has(chipAccount.id), model.validationErrors.get(chipAccount.id))
      : null;
  // A ready account shows its canonical WEEKLY usage on the chip ("64% left"); anything else, its state.
  const fallbackChipUsage = useAccountUsage(chipAccount?.id);
  const chipUsage = canonicalChip?.usage ?? fallbackChipUsage;
  const chipSummary = usageSummary(chipUsage);
  const chipStatus =
    signInStatus?.tone === "healthy" && (chipUsage.status === "fresh" || chipUsage.status === "stale")
      ? { label: chipSummary.short, tone: chipSummary.low ? "attention" : "healthy" }
      : signInStatus;
  const ready = accounts.filter((a) => a.authenticationState === "authenticated").length;

  const readBindings = useCallback(async () => {
    const generation = ++bindingGeneration.current;
    try {
      const next = await client.listProviderAccountBindings({ kind: "workspace" });
      if (generation === bindingGeneration.current) {
        setBindings(next);
        setBindingError(null);
      }
    } catch (error) {
      if (generation === bindingGeneration.current) {
        setBindings(null);
        setBindingError(toKalCodeError(error).message);
      }
    }
  }, [client]);
  useEffect(() => {
    window.addEventListener("focus", readBindings);
    return () => {
      ++bindingGeneration.current;
      window.removeEventListener("focus", readBindings);
    };
  }, [readBindings]);
  // Launchers and Threads can remember a different account while this popover is closed.
  // Re-read the native binding on navigation/focus changes; never keep a second selection authority.
  const workspaceId = active?.id;
  const focusedId = focused?.id;
  // biome-ignore lint/correctness/useExhaustiveDependencies: these identities invalidate the native binding snapshot.
  useEffect(() => {
    void readBindings();
  }, [open, current, workspaceId, focusedId, readBindings]);

  const run = async (operation: () => Promise<void>) => {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    setNotice("");
    try {
      await operation();
    } catch (error) {
      setNotice(toKalCodeError(error).message);
    } finally {
      busy.current = false;
      setPending(false);
    }
  };
  const switchAccount = (account: ProviderAccount) =>
    run(async () => {
      // A live PTY retains its provider credentials. Only the canonical next-launch binding changes.
      if (!active) {
        setNotice("Open a workspace to choose its active account.");
        return;
      }
      ++bindingGeneration.current;
      await client.bindProviderAccount(account.providerId, "workspace", active.id, account.id);
      setChosenProvider(account.providerId);
      await readBindings();
      setNotice(
        `${accountName(account)} selected for new ${accountProviderName(account.providerId)} agents in ${active.name}. Existing sessions keep their account.`,
      );
    });
  const refresh = () =>
    run(async () => {
      if (!sessions) await model.load();
      const restored = sessions ? await sessions.reload() : model.accounts;
      await readBindings();
      setNotice(restored ? "Account information refreshed." : "Account information could not be refreshed.");
    });
  const disabled = pending || model.busyKey !== null || model.activeLogin !== null;
  const providers = [...new Set(accounts.map((a) => a.providerId))];

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          className={styles.chip}
          aria-label="Account and usage center"
          title={
            chipAccount
              ? [
                  accountFullLabel(chipAccount),
                  focusedAccount ? "Current session" : "New agents",
                  chipStatus?.label === chipSummary.short ? primaryUsageLabel(chipUsage) : null,
                ]
                  .filter(Boolean)
                  .join(" · ")
              : "Accounts & usage"
          }
          data-tone={chipStatus?.tone ?? (model.loadError || focused ? "danger" : undefined)}
        >
          {chipAccount ? (
            <ProviderGlyph provider={chipAccount.providerId} size="xs" />
          ) : (
            <Users size={15} aria-hidden="true" />
          )}
          <span className={styles.chipName}>
            {chipAccount ? accountName(chipAccount) : focused ? "Account unavailable" : "Accounts"}
          </span>
          <span className={styles.chipStatus}>
            {chipStatus?.label ??
              (model.loadError
                ? "Unavailable"
                : !model.accounts
                  ? "Loading"
                  : focused
                    ? "Not linked"
                    : `${ready} ready`)}
          </span>
          <ChevronDown size={12} aria-hidden="true" />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="end"
          sideOffset={9}
          collisionPadding={12}
          className={styles.popover}
          aria-labelledby={titleId}
          data-account-center=""
        >
          <div className={styles.header}>
            <div>
              <h2 id={titleId}>Accounts &amp; usage</h2>
              <p>Your providers, at a glance</p>
            </div>
            <button
              type="button"
              className={styles.iconButton}
              aria-label="Refresh usage"
              title="Refresh available account information"
              disabled={disabled}
              onClick={() => void refresh()}
            >
              <RefreshCw size={15} className={pending ? styles.spinning : undefined} />
            </button>
            <Popover.Close className={styles.iconButton} aria-label="Close account center">
              <X size={16} />
            </Popover.Close>
          </div>
          <div className={styles.context}>
            {focused ? (
              <p>
                {focused.runtimeKind === "interactive_pty" ? "This terminal" : "This thread"} is using:{" "}
                <strong>
                  {focusedAccount
                    ? accountFullLabel(focusedAccount)
                    : focused.providerAccountId
                      ? "Account unavailable"
                      : "No linked account"}
                </strong>
              </p>
            ) : current === "code" && code?.content?.kind === "terminal" ? (
              <p>Shell terminal · no linked provider account</p>
            ) : (
              <p>
                <strong>{active?.name ?? "No active workspace"}</strong>
                <span> · Account selection for new agents</span>
              </p>
            )}
            {focused && (
              <p className={styles.secondary}>
                New agents: {launchAccount ? accountFullLabel(launchAccount) : "Choose an account below"}
              </p>
            )}
          </div>
          <div className={styles.body}>
            {model.loadError && (
              <p role="alert" className={styles.error}>
                {model.loadError}
              </p>
            )}
            {bindingError && (
              <p role="alert" className={styles.error}>
                Workspace selection unavailable. {bindingError}
              </p>
            )}
            {model.accounts === null && !model.loadError && <p className={styles.empty}>Loading accounts…</p>}
            {model.accounts?.length === 0 && (
              <div className={styles.empty}>
                <Users size={24} />
                <h3>Bring your accounts</h3>
                <p>Connect a provider to keep sign-in and account selection close at hand.</p>
              </div>
            )}
            {providers.map((provider) => {
              const selected = bindings
                ? selectedLaunchAccount(accounts, bindings, provider, active?.id ?? null)
                : null;
              const backoff = health.data?.find((h) => h.providerId === provider && h.capacity === "backing_off");
              const limit = backoff ? rateLimitText(backoff) : null;
              return (
                <div className={styles.group} key={provider}>
                  <div className={styles.groupHeader}>
                    <ProviderGlyph provider={provider} size="xs" />
                    <h3>{accountProviderName(provider)}</h3>
                    <span>{accounts.filter((a) => a.providerId === provider).length}</span>
                  </div>
                  {limit && (
                    <p className={styles.attention}>
                      Provider-wide: {limit.label}. {limit.detail}
                    </p>
                  )}
                  {sortAccounts(accounts.filter((a) => a.providerId === provider)).map((account) => (
                    <AccountEntry
                      key={account.id}
                      account={account}
                      model={model}
                      selected={selected?.id === account.id}
                      active={focusedAccount?.id === account.id}
                      disabled={disabled}
                      canSwitch={active !== null && bindings !== null}
                      onSwitch={switchAccount}
                      run={run}
                      sameSignIn={sameSignInLabel(account, accounts)}
                    />
                  ))}
                </div>
              );
            })}
          </div>
          <div className={styles.footer}>
            {notice && (
              <p role="status" className={styles.notice}>
                {notice}
              </p>
            )}
            {model.activeLogin && (
              <div className={styles.login}>
                <span role="status">Complete sign-in in your browser</span>
                <button type="button" disabled={model.busyKey !== null} onClick={() => void model.cancelLogin()}>
                  Cancel sign-in
                </button>
              </div>
            )}
            {adding ? (
              <AddAccount
                cursorConnected={accounts.some((account) => account.providerId === "cursor")}
                disabled={disabled}
                onCancel={() => setAdding(false)}
                onAdd={(provider, name) =>
                  void run(async () => {
                    const account = await model.create(provider, name);
                    if (account) {
                      setAdding(false);
                      await model.signInAuth(account);
                    }
                  })
                }
              />
            ) : (
              <button type="button" className={styles.add} disabled={disabled} onClick={() => setAdding(true)}>
                <Plus size={15} />
                Add account
              </button>
            )}
            <p className={styles.disclosure}>Usage appears only when reported by your provider.</p>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

type AccountModel = ReturnType<typeof useProviderAccounts>;

/** Ticks while the center is open so "Resets in…" and "Updated…" stay honest. */
function useClock(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

function percentLeft(window: UsageWindow): number {
  return Math.max(0, Math.min(100, Math.round(window.remainingPercent)));
}

/** Why there is no number: never a guess, always the canonical state's own words. */
function usageAbsence(usage: AccountUsageState): string {
  if (usage.status === "checking") return "Checking usage…";
  if (usage.status === "unavailable") return "Usage unavailable";
  return "Usage not checked";
}

function AccountEntry({
  account,
  model,
  selected,
  active,
  disabled,
  canSwitch,
  onSwitch,
  run,
  sameSignIn,
}: {
  account: ProviderAccount;
  model: AccountModel;
  selected: boolean;
  active: boolean;
  disabled: boolean;
  canSwitch: boolean;
  onSwitch: (account: ProviderAccount) => Promise<void>;
  run: (operation: () => Promise<void>) => Promise<void>;
  sameSignIn: string | null;
}) {
  const [expanded, setExpanded] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(account.displayName);
  const detailsId = useId();
  const nameId = useId();
  const now = useClock();
  const canonical = useOptionalProviderAccountSessions()?.states.get(account.id);
  const fallbackUsage = useAccountUsage(account.id);
  const usage = canonical?.usage ?? fallbackUsage;
  const status = canonical
    ? accountCenterHealthStatus(canonical.health)
    : accountCenterStatus(account, model.checking.has(account.id), model.validationErrors.get(account.id));
  const label = accountName(account);
  const known = (usage.status === "fresh" || usage.status === "stale") && usage.windows.length > 0;
  const low = known && usageSummary(usage).low;
  const signedIn = account.authenticationState === "authenticated";
  // Sign-in is the one next step for a signed-out browser-auth account: right in the row.
  const canSignIn = !signedIn && isBrowserAuthProvider(account.providerId);
  const signingIn = model.activeLogin?.accountId === account.id;
  // "Usage not checked" beside Sign in would only repeat the status; say what the action doesn't.
  const showAbsence = !known && !(canSignIn && usage.status === "not_checked");
  return (
    <section
      className={styles.account}
      aria-label={accountFullLabel(account)}
      data-selected={active || selected || undefined}
      data-low={low || undefined}
    >
      <div className={styles.accountTop}>
        <strong className={styles.name}>{label}</strong>
        {usage.plan ? <span className={styles.plan}>{usage.plan}</span> : null}
        <span className={styles.spacer} />
        {active && (
          <span className={styles.selected}>
            <Check size={11} />
            Active
          </span>
        )}
        {!active && selected && <span className={styles.selected}>New agents</span>}
        {account.isDefault && <span className={styles.tag}>Default</span>}
        <button
          type="button"
          className={styles.iconButton}
          aria-label="Account details"
          aria-expanded={expanded}
          aria-controls={detailsId}
          onClick={() => setExpanded(!expanded)}
        >
          <ChevronDown size={14} className={expanded ? styles.rotated : undefined} />
        </button>
      </div>
      <div className={styles.accountMeta}>
        <span className={styles.status} data-tone={status.tone}>
          <i />
          {status.label}
        </span>
        {account.providerReportedIdentity && (
          <span className={styles.identity} title={account.providerReportedIdentity}>
            {account.providerReportedIdentity}
          </span>
        )}
        <span className={styles.metaEnd}>
          {known && usage.status === "fresh" && usage.checkedAt && (
            <span className={styles.updated}>Updated {formatRelative(usage.checkedAt, now)}</span>
          )}
          {showAbsence && (
            <span
              className={styles.usage}
              data-checking={usage.status === "checking" || undefined}
              title={usage.reason ?? undefined}
            >
              {usageAbsence(usage)}
            </span>
          )}
          {canSignIn &&
            (signingIn ? (
              <span className={styles.waiting} role="status">
                Waiting for browser…
              </span>
            ) : (
              <button
                type="button"
                className={styles.signIn}
                disabled={disabled}
                aria-label={`Sign in ${label}`}
                onClick={() =>
                  void run(async () => {
                    await model.signInAuth(account);
                  })
                }
              >
                <LogIn size={12} aria-hidden="true" />
                Sign in
              </button>
            ))}
        </span>
      </div>
      {sameSignIn && (
        <p className={styles.shared} title="Both accounts use one provider sign-in, so they share its usage">
          <Link2 size={11} aria-hidden="true" />
          {sameSignIn}
        </p>
      )}
      {known && (
        <ul className={styles.windows} aria-label={`${label} usage`}>
          {usage.windows.map((window) => {
            const left = percentLeft(window);
            const reset = resetsIn(window.resetsAt, now);
            return (
              <li key={window.id} className={styles.window} data-tone={left < LOW_USAGE_PERCENT ? "low" : undefined}>
                <span className={styles.windowLabel}>{window.label}</span>
                <span className={styles.windowValue}>
                  <strong>{left}%</strong> left
                </span>
                <span className={styles.windowTrack} aria-hidden="true">
                  <span className={styles.windowFill} style={{ "--fill": `${left}%` } as CSSProperties} />
                </span>
                <span className={styles.windowReset}>{reset ?? "Reset time not reported"}</span>
              </li>
            );
          })}
        </ul>
      )}
      {known && usage.status === "stale" && usage.checkedAt && (
        <p className={styles.stale}>Last read {formatRelative(usage.checkedAt, now)} · may be out of date</p>
      )}
      {expanded && (
        <div className={styles.details} id={detailsId}>
          <dl>
            <div>
              <dt>Plan</dt>
              <dd>{usage.plan ?? "Plan not reported"}</dd>
            </div>
            <div>
              <dt>Usage</dt>
              <dd>
                {known && usage.checkedAt
                  ? `Updated ${formatRelative(usage.checkedAt, now)}`
                  : [usageAbsence(usage), usage.reason].filter(Boolean).join(" · ")}
              </dd>
            </div>
            <div>
              <dt>Sign-in checked</dt>
              <dd>{account.lastCheckedAt ? new Date(account.lastCheckedAt).toLocaleString() : "Not checked"}</dd>
            </div>
          </dl>
          {(model.validationErrors.get(account.id) || account.lastErrorCode) && (
            <p className={styles.attention}>{model.validationErrors.get(account.id) ?? account.lastErrorCode}</p>
          )}
          {renaming ? (
            <form
              className={styles.rename}
              onSubmit={(event) => {
                event.preventDefault();
                if (name.trim())
                  void run(async () => {
                    if (await model.rename(account.id, name.trim())) setRenaming(false);
                  });
              }}
            >
              <label htmlFor={nameId}>Account nickname</label>
              <input id={nameId} value={name} onChange={(e) => setName(e.target.value)} maxLength={80} required />
              <div className={styles.actions}>
                <button type="submit" disabled={disabled || !name.trim()}>
                  Save name
                </button>
                <button type="button" disabled={disabled} onClick={() => setRenaming(false)}>
                  Cancel
                </button>
              </div>
            </form>
          ) : (
            <div className={styles.actions}>
              <button
                type="button"
                disabled={disabled || !canSwitch || selected || account.authenticationState === "not_authenticated"}
                onClick={() => void onSwitch(account)}
              >
                Switch active account
              </button>
              <button
                type="button"
                disabled={disabled}
                onClick={() => {
                  setName(account.displayName);
                  setRenaming(true);
                }}
              >
                Rename account
              </button>
              {!account.isDefault && (
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() =>
                    void run(async () => {
                      await model.setDefault(account.id);
                    })
                  }
                >
                  Set default
                </button>
              )}
              {canRefreshProviderAuth(account.providerId) && (
                <button
                  type="button"
                  disabled={disabled || model.checking.has(account.id)}
                  onClick={() =>
                    void run(async () => {
                      await model.refreshAuth(account);
                    })
                  }
                >
                  Check sign-in
                </button>
              )}
              {isBrowserAuthProvider(account.providerId) && account.providerId !== "cursor" && signedIn && (
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() =>
                    void run(async () => {
                      await model.logoutAuth(account);
                    })
                  }
                >
                  Sign out
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function AddAccount({
  cursorConnected,
  disabled,
  onAdd,
  onCancel,
}: {
  disabled: boolean;
  cursorConnected: boolean;
  onAdd: (provider: string, name: string) => void;
  onCancel: () => void;
}) {
  const [provider, setProvider] = useState("claude-code");
  const [name, setName] = useState("");
  const id = useId();
  return (
    <form
      className={styles.addForm}
      onSubmit={(event) => {
        event.preventDefault();
        if (name.trim()) onAdd(provider, name.trim());
      }}
    >
      <label htmlFor={`${id}-provider`}>Provider</label>
      <select id={`${id}-provider`} value={provider} onChange={(e) => setProvider(e.target.value)} disabled={disabled}>
        {Object.entries(ACCOUNT_PROVIDER_NAMES)
          .filter(([value]) => value !== "cursor" || !cursorConnected)
          .map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
      </select>
      <label htmlFor={`${id}-name`}>Account nickname</label>
      <input
        id={`${id}-name`}
        placeholder="e.g. Work"
        value={name}
        onChange={(e) => setName(e.target.value)}
        maxLength={80}
        required
        disabled={disabled}
      />
      <div className={styles.actions}>
        <button type="submit" disabled={disabled || !name.trim()}>
          Add and sign in
        </button>
        <button type="button" disabled={disabled} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
