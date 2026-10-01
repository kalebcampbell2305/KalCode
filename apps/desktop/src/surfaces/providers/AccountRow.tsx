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
import { accountFullLabel, accountHealth, accountName, accountSignIn } from "./accountIdentity.ts";
import styles from "./ProviderAccountsView.module.css";
import { type AccountUsage, isBrowserAuthProvider } from "./useProviderAccounts.ts";

export interface AccountRowActions {
  rename: (accountId: string, displayName: string) => Promise<ProviderAccount | null>;
  setDefault: (accountId: string) => Promise<ProviderAccount | null>;
  archive: (accountId: string) => Promise<ProviderAccount | null>;
  refreshAuth: (account: ProviderAccount) => Promise<ProviderAccount | null>;
  signInAuth: (account: ProviderAccount) => Promise<void>;
  cancelLogin: () => Promise<void>;
  logoutAuth: (account: ProviderAccount) => Promise<ProviderAccount | null>;
}

/**
 * One account as a dense row: name (with a quiet Default marker) and identity, health and
 * sign-in, usage, then one contextual action and an overflow menu. Everything shown is what
 * KalCode actually knows; provider usage, limits and plans aren't reported to KalCode, so they
 * say so instead of showing a number.
 */
export function AccountRow({
  account,
  providerName,
  usage,
  busyKey,
  activeLogin,
  loginInProgress,
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
  const busy = busyKey?.endsWith(account.id) ?? false;
  const browserAuth = isBrowserAuthProvider(account.providerId);
  const signedIn = account.authenticationState === "authenticated";
  const health = accountHealth(account);
  const signIn = accountSignIn(account);
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
    <section className={styles.row} aria-label={accountFullLabel(account)} data-expanded={expanded || undefined}>
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
        </div>

        <div className={styles.cellStatus}>
          <StatusIndicator tone={health.tone} pulse={activeLogin}>
            {health.label}
          </StatusIndicator>
          {activeLogin ? (
            <span className={styles.sub} role="status">
              Waiting for browser sign-in…
            </span>
          ) : signIn.label !== health.label ? (
            <span className={styles.sub}>{signIn.label}</span>
          ) : null}
        </div>

        <div className={styles.cellUsage}>
          <span className={styles.muted}>{account.lastCheckedAt ? "Usage unavailable" : "Usage not checked"}</span>
          <span className={styles.sub}>{usage ? activity(usage) : "Activity unavailable"}</span>
        </div>

        <div className={styles.cellActions}>
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
          ) : browserAuth && !signedIn ? (
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
          {browserAuth && !activeLogin ? (
            <IconButton
              size="sm"
              label={`Refresh ${label} sign-in status`}
              icon={<RefreshCw />}
              onClick={() => void actions.refreshAuth(account)}
              busy={busyKey === `refresh:${account.id}`}
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
              {browserAuth ? (
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
              {browserAuth && signedIn ? (
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
          <AccountFacts account={account} providerName={providerName} usage={usage} />

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
}: {
  account: ProviderAccount;
  providerName: string;
  usage: AccountUsage | null;
}) {
  const now = Date.now();
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
        <dd className={styles.muted}>Not reported</dd>
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
        <dd className={styles.muted}>Not available in KalCode</dd>
      </div>
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
        <dt>Active threads</dt>
        <dd>{usage ? threadUse(usage) : "Unavailable"}</dd>
      </div>
      <div>
        <dt>Workspace default in</dt>
        <dd>{usage ? usage.workspaces.join(", ") || "None" : "Unavailable"}</dd>
      </div>
    </dl>
  );
}

function When({ iso, now }: { iso: string; now: number }) {
  return (
    <time dateTime={iso} title={formatAbsolute(iso)}>
      {formatRelative(iso, now)}
    </time>
  );
}

/** "2 · 1 running", "1" or "None": a count in text, never a colour. */
function threadUse(usage: AccountUsage): string {
  if (usage.threads === 0) return "None";
  return usage.running > 0 ? `${usage.threads} · ${usage.running} running` : String(usage.threads);
}

/** KalCode's own activity on the account, for the row: "2 threads · 1 running" or "No threads". */
function activity(usage: AccountUsage): string {
  if (usage.threads === 0) return "No threads";
  const threads = `${usage.threads} thread${usage.threads === 1 ? "" : "s"}`;
  return usage.running > 0 ? `${threads} · ${usage.running} running` : threads;
}
