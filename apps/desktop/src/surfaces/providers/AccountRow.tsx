import type { ProviderAccount } from "@kalcode/protocol";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Field,
  IconButton,
  StatusIndicator,
  TextInput,
} from "@kalcode/ui/components";
import { ChevronDown, Info, LogIn, LogOut, MoreHorizontal, PenLine, RefreshCw, Star, Trash2 } from "lucide-react";
import { type FormEvent, useId, useRef, useState } from "react";
import { formatAbsolute, formatRelative } from "../../runtime/describeEvent.ts";
import { FavoriteButton, useFavoriteMenuItems } from "../../shell/favorites/FavoriteActions.tsx";
import { agentsAndThreadsLabel } from "../dashboard/data/agents.ts";
import { UsageMeter } from "./AccountUsageBadge.tsx";
import { accountFullLabel, accountName, accountSessionState, accountSignIn } from "./accountIdentity.ts";
import {
  type AccountUsageState,
  isReportedPercent,
  LOW_USAGE_PERCENT,
  resetsIn,
  useAccountUsage,
  weeklyWindow,
} from "./accountUsage.ts";
import { useOptionalProviderAccountSessions } from "./ProviderAccountSessions.tsx";
import styles from "./ProviderAccountsView.module.css";
import { type AccountUsage, canRefreshProviderAuth, isBrowserAuthProvider } from "./useProviderAccounts.ts";

export interface AccountRowActions {
  rename: (accountId: string, displayName: string) => Promise<ProviderAccount | null>;
  setDefault: (accountId: string) => Promise<ProviderAccount | null>;
  archive: (accountId: string) => Promise<ProviderAccount | null>;
  refreshAuth: (account: ProviderAccount) => Promise<ProviderAccount | null>;
  signInAuth: (account: ProviderAccount) => Promise<ProviderAccount | null>;
  cancelLogin: () => Promise<void>;
  logoutAuth: (account: ProviderAccount) => Promise<ProviderAccount | null>;
}

/**
 * One account as a dense row: name (with a quiet Default marker) and identity, health and
 * sign-in, provider usage, KalCode activity, then one contextual action and an overflow menu.
 * Usage and plan are the canonical per-account state (accountUsage.ts), the same numbers every
 * other surface shows; when the provider doesn't report them the row says so, never a guess.
 */
export function AccountRow({
  account,
  providerName,
  usage,
  busyKey,
  activeLogin,
  loginInProgress,
  checking = false,
  validationError = null,
  usageStale = false,
  usageRefreshing = false,
  sameSignIn = null,
  actions,
}: {
  account: ProviderAccount;
  providerName: string;
  /** `null` while thread use and workspace defaults are unavailable. */
  usage: AccountUsage | null;
  busyKey: string | null;
  /** This account's browser sign-in is in progress. */
  activeLogin: boolean;
  /** Any account's browser sign-in is in progress (one at a time). */
  loginInProgress: boolean;
  /** Provider-native validation is running; the last-known session stays usable meanwhile. */
  checking?: boolean;
  /** A transient validation failure; last-known authentication remains visible below it. */
  validationError?: string | null;
  /** The last derived local activity snapshot is still shown after a refresh failure. */
  usageStale?: boolean;
  usageRefreshing?: boolean;
  /** "Same sign-in as Work" when another account shares this provider identity. */
  sameSignIn?: string | null;
  actions: AccountRowActions;
}) {
  const id = useId();
  const [expanded, setExpanded] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(account.displayName);
  const [confirmRemove, setConfirmRemove] = useState(false);
  // Rename and Remove move focus into the details; the menu must not pull it back to its trigger.
  const keepMenuFocus = useRef(false);

  const label = accountName(account);
  const favoriteTarget = { kind: "account" as const, id: account.id, workspaceId: null };
  const favoriteItems = useFavoriteMenuItems(favoriteTarget, label);
  const busy = busyKey?.endsWith(account.id) ?? false;
  const browserAuth = isBrowserAuthProvider(account.providerId);
  const canRefreshAuth = canRefreshProviderAuth(account.providerId);
  const signedIn = account.authenticationState === "authenticated";
  const canonical = useOptionalProviderAccountSessions()?.states.get(account.id);
  const session = canonical?.health ?? accountSessionState(account, checking, validationError);
  const signIn = accountSignIn(account);
  const fallbackQuota = useAccountUsage(account.id);
  const quota = canonical?.usage ?? fallbackQuota;
  const detailsId = `${id}-details`;

  const startRename = () => {
    keepMenuFocus.current = true;
    setName(account.displayName);
    setConfirmRemove(false);
    setRenaming(true);
    setExpanded(true);
  };
  const startRemove = () => {
    keepMenuFocus.current = true;
    setRenaming(false);
    setConfirmRemove(true);
    setExpanded(true);
  };
  const saveName = async (event: FormEvent) => {
    event.preventDefault();
    if (await actions.rename(account.id, name)) setRenaming(false);
  };

  return (
    <section
      id={`provider-account-${account.id}`}
      tabIndex={-1}
      className={styles.row}
      aria-label={accountFullLabel(account)}
      data-expanded={expanded || undefined}
    >
      <div className={styles.rowMain}>
        <div className={styles.cellName}>
          <span className={styles.nameLine}>
            <span className={styles.name} title={label}>
              {label}
            </span>
            {account.isDefault ? <span className={styles.defaultTag}>Default</span> : null}
          </span>
          {account.providerReportedIdentity ? (
            <span className={styles.identity} data-selectable title={account.providerReportedIdentity}>
              {account.providerReportedIdentity}
            </span>
          ) : (
            <span className={styles.muted}>Identity not reported</span>
          )}
          {sameSignIn ? (
            <span className={styles.shared} title="Both accounts use one provider sign-in, so they share its usage">
              {sameSignIn}
            </span>
          ) : null}
        </div>

        <div className={styles.cellStatus}>
          <StatusIndicator tone={session.tone} pulse={activeLogin || checking}>
            {session.label}
          </StatusIndicator>
          {activeLogin ? (
            <span className={styles.sub} role="status">
              Waiting for browser sign-in…
            </span>
          ) : checking && signedIn ? (
            <span className={styles.sub}>Connected while checking</span>
          ) : validationError && signedIn ? (
            <span className={styles.sub}>Connected · check failed</span>
          ) : signIn.label !== session.label ? (
            <span className={styles.sub}>{signIn.label}</span>
          ) : null}
        </div>

        <div className={styles.cellUsage}>
          {!signedIn && quota.status === "not_checked" ? (
            // Nothing to read until the account signs in; the Sign in action is beside it.
            <span className={styles.muted}>Sign in to read usage</span>
          ) : (
            <>
              <span className={styles.usageLine}>
                <UsageMeter usage={quota} />
                {quota.plan ? <span className={styles.plan}>{quota.plan}</span> : null}
              </span>
              <span
                className={styles.sub}
                data-tone={quota.status === "stale" ? "stale" : undefined}
                title={usageDetail(quota)}
              >
                {usageDetail(quota)}
              </span>
            </>
          )}
        </div>

        <div className={styles.cellActivity}>
          <span className={styles.sub}>
            {usage
              ? `${activity(usage)}${usageStale ? " · stale" : usageRefreshing ? " · refreshing" : ""}`
              : usageRefreshing
                ? "Restoring activity…"
                : "Activity unavailable"}
          </span>
        </div>

        <div className={styles.cellActions}>
          <FavoriteButton target={favoriteTarget} title={label} />
          {activeLogin ? (
            <Button
              size="sm"
              variant="ghost"
              busy={busyKey === `cancel:${account.id}`}
              onClick={() => void actions.cancelLogin()}
              aria-label={`Cancel sign-in for ${label}`}
            >
              Cancel sign-in
            </Button>
          ) : browserAuth && (session.state === "expired" || session.state === "not_checked") ? (
            <Button
              size="sm"
              icon={<LogIn />}
              onClick={() => void actions.signInAuth(account)}
              busy={busyKey === `login:${account.id}`}
              disabled={busy || loginInProgress}
              aria-label={`Sign in ${label}`}
            >
              Sign in
            </Button>
          ) : null}
          {/* Hidden while signing in: the wider Cancel sign-in takes its place in the column. */}
          {canRefreshAuth && !activeLogin ? (
            <IconButton
              size="sm"
              label={`Refresh ${label} sign-in status`}
              icon={<RefreshCw />}
              onClick={() => void actions.refreshAuth(account)}
              busy={busyKey === `refresh:${account.id}` || checking}
              disabled={busy}
            />
          ) : null}
          <IconButton
            size="sm"
            label={`Account details for ${label}`}
            icon={<ChevronDown className={expanded ? styles.chevronOpen : styles.chevron} />}
            aria-expanded={expanded}
            aria-controls={expanded ? detailsId : undefined}
            onClick={() => setExpanded((open) => !open)}
          />
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <IconButton
                size="sm"
                label={`More actions for ${label}`}
                icon={<MoreHorizontal />}
                busy={busyKey === `default:${account.id}` || busyKey === `logout:${account.id}`}
              />
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              minWidth={12}
              onCloseAutoFocus={(event) => {
                if (!keepMenuFocus.current) return;
                keepMenuFocus.current = false;
                event.preventDefault();
              }}
            >
              {favoriteItems.map((item) =>
                "separator" in item ? null : (
                  <DropdownMenuItem key={item.id} icon={item.icon} onSelect={item.onSelect}>
                    {item.label}
                  </DropdownMenuItem>
                ),
              )}
              {canRefreshAuth ? (
                <DropdownMenuItem
                  icon={<RefreshCw />}
                  disabled={busy || activeLogin}
                  onSelect={() => void actions.refreshAuth(account)}
                  aria-label={`Refresh ${label} status`}
                >
                  Refresh status
                </DropdownMenuItem>
              ) : null}
              {account.isDefault ? null : (
                <DropdownMenuItem
                  icon={<Star />}
                  disabled={busy}
                  onSelect={() => void actions.setDefault(account.id)}
                  aria-label={`Set ${label} as default`}
                >
                  Set as default
                </DropdownMenuItem>
              )}
              <DropdownMenuItem
                icon={<PenLine />}
                disabled={busy}
                onSelect={startRename}
                aria-label={`Rename ${label}`}
              >
                Rename
              </DropdownMenuItem>
              {browserAuth && signedIn && account.providerId !== "cursor" ? (
                <DropdownMenuItem
                  icon={<LogOut />}
                  disabled={busy}
                  onSelect={() => void actions.logoutAuth(account)}
                  aria-label={`Sign out ${label}`}
                >
                  Sign out
                </DropdownMenuItem>
              ) : null}
              <DropdownMenuItem icon={<Info />} onSelect={() => setExpanded((open) => !open)}>
                {expanded ? "Hide account details" : "Account details"}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                icon={<Trash2 />}
                tone="danger"
                disabled={busy || activeLogin}
                onSelect={startRemove}
                aria-label={`Remove ${label} from KalCode`}
              >
                Remove from KalCode
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {expanded ? (
        <div id={detailsId} className={styles.details}>
          <AccountFacts account={account} providerName={providerName} usage={usage} quota={quota} />

          {renaming ? (
            <form className={styles.inlineForm} onSubmit={(event) => void saveName(event)}>
              <Field htmlFor={`${id}-rename`} label={`Account name for ${label}`}>
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
                <Button
                  type="submit"
                  size="sm"
                  variant="primary"
                  busy={busyKey === `rename:${account.id}`}
                  disabled={!name.trim()}
                >
                  Save account name
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setRenaming(false)}>
                  Cancel rename
                </Button>
              </div>
            </form>
          ) : confirmRemove ? (
            <fieldset className={styles.confirm}>
              <legend className="visually-hidden">Remove {label} from KalCode</legend>
              <p>Removing this entry doesn't sign out of {providerName} or delete provider credentials.</p>
              <div className={styles.actions}>
                <Button
                  size="sm"
                  variant="danger"
                  busy={busyKey === `archive:${account.id}`}
                  onClick={async () => {
                    if (await actions.archive(account.id)) setConfirmRemove(false);
                  }}
                  aria-label={`Confirm remove ${label}`}
                >
                  Remove from KalCode
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setConfirmRemove(false)} disabled={busy} autoFocus>
                  Keep account
                </Button>
              </div>
            </fieldset>
          ) : (
            <div className={styles.actions}>
              <Button
                size="sm"
                variant="ghost"
                icon={<PenLine />}
                onClick={startRename}
                disabled={busy}
                aria-label={`Rename ${label}`}
              >
                Rename
              </Button>
              <Button
                size="sm"
                variant="ghost"
                icon={<Trash2 />}
                onClick={startRemove}
                disabled={busy || activeLogin}
                aria-label={`Remove ${label} from KalCode`}
              >
                Remove from KalCode
              </Button>
            </div>
          )}
        </div>
      ) : null}
    </section>
  );
}

/** The details list: labelled facts, each in words. */
function AccountFacts({
  account,
  providerName,
  usage,
  quota,
}: {
  account: ProviderAccount;
  providerName: string;
  usage: AccountUsage | null;
  quota: AccountUsageState;
}) {
  const now = Date.now();
  const known = (quota.status === "fresh" || quota.status === "stale") && quota.windows.length > 0;
  const signIn = accountSignIn(account);
  return (
    <dl className={styles.facts}>
      <div>
        <dt>Identity</dt>
        <dd>
          {account.providerReportedIdentity ? (
            <span data-selectable>{account.providerReportedIdentity}</span>
          ) : (
            <span className={styles.muted}>Not reported by {providerName}</span>
          )}
        </dd>
      </div>
      <div>
        <dt>Plan</dt>
        {quota.plan ? <dd>{quota.plan}</dd> : <dd className={styles.muted}>Not reported</dd>}
      </div>
      <div>
        <dt>Sign-in</dt>
        <dd>
          {account.lastCheckedAt ? (
            <>
              {signIn.label}, checked <When iso={account.lastCheckedAt} now={now} />
            </>
          ) : (
            "Never checked"
          )}
        </dd>
      </div>
      <div>
        <dt>Usage and limits</dt>
        {known ? (
          <dd>
            <ul className={styles.windowList}>
              {quota.windows.map((window) => (
                <li key={window.id} data-tone={window.remainingPercent < LOW_USAGE_PERCENT ? "low" : undefined}>
                  {window.label} · {Math.max(0, Math.min(100, Math.round(window.remainingPercent)))}% left
                  {resetsIn(window.resetsAt, now) ? ` · ${resetsIn(window.resetsAt, now)?.toLowerCase()}` : ""}
                </li>
              ))}
            </ul>
          </dd>
        ) : (
          <dd className={styles.muted}>{usageDetail(quota)}</dd>
        )}
      </div>
      {known && quota.checkedAt ? (
        <div>
          <dt>Usage read</dt>
          <dd>
            <When iso={quota.checkedAt} now={now} />
            {quota.status === "stale" ? " · may be out of date" : ""}
          </dd>
        </div>
      ) : null}
      <div>
        <dt>Last used</dt>
        <dd>{account.lastUsedAt ? <When iso={account.lastUsedAt} now={now} /> : "Never"}</dd>
      </div>
      <div>
        <dt>Added</dt>
        <dd>
          <When iso={account.createdAt} now={now} />
        </dd>
      </div>
      {account.lastErrorCode ? (
        <div>
          <dt>Last error</dt>
          <dd>
            <code data-selectable>{account.lastErrorCode}</code>
          </dd>
        </div>
      ) : null}
      <div>
        <dt>Active agents</dt>
        <dd>{usage ? openUse(usage.agents, usage.agentsRunning) : "Unavailable"}</dd>
      </div>
      <div>
        <dt>Active threads</dt>
        <dd>{usage ? openUse(usage.threads, usage.threadsRunning) : "Unavailable"}</dd>
      </div>
      <div>
        <dt>Workspace default in</dt>
        <dd>{usage ? usage.workspaces.join(", ") || "None" : "Unavailable"}</dd>
      </div>
    </dl>
  );
}

/**
 * The line under the meter: when the weekly window it shows resets ("Weekly · resets in 3d 5h"),
 * that a stale reading is old, or why there is no number ("Signed out", "Not reported by Gemini").
 * Every other window (5-hour, model-scoped) is listed, labelled, in the expanded details.
 */
function usageDetail(usage: AccountUsageState): string {
  if (usage.status === "fresh" || usage.status === "stale") {
    const window = weeklyWindow(usage);
    if (!window) {
      const others = usage.windows.filter((w) => isReportedPercent(w.remainingPercent)).map((w) => w.label);
      return others.length > 0 ? `Only ${others.join(", ")} reported` : "No usage windows reported";
    }
    const reset = resetsIn(window.resetsAt);
    const parts = [window.label, reset ? reset.toLowerCase() : null];
    if (usage.status === "stale" && usage.checkedAt) parts.push(`read ${formatRelative(usage.checkedAt)}`);
    return parts.filter(Boolean).join(" · ");
  }
  if (usage.status === "checking") return "Reading provider usage…";
  if (usage.status === "unavailable") return usage.reason ?? "Not reported by this provider";
  return usage.reason ?? "Not read yet";
}

function When({ iso, now }: { iso: string; now: number }) {
  return (
    <time dateTime={iso} title={formatAbsolute(iso)}>
      {formatRelative(iso, now)}
    </time>
  );
}

/** "2 · 1 running", "1" or "None": a count in text, never a colour. */
function openUse(open: number, running: number): string {
  if (open === 0) return "None";
  return running > 0 ? `${open} · ${running} running` : String(open);
}

/** KalCode's own activity on the account, for the row: "2 agents · 1 thread · 1 running" or "No agents or threads". */
function activity(usage: AccountUsage): string {
  const open = agentsAndThreadsLabel(usage.agents, usage.threads);
  const running = usage.agentsRunning + usage.threadsRunning;
  return running > 0 ? `${open} · ${running} running` : open;
}
