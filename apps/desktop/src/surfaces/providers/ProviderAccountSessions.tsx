import type { ProviderAccount } from "@kalcode/protocol";
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { KalCodeClient } from "../../ipc/client.ts";
import { toKalCodeError } from "../../ipc/errors.ts";
import { useRuntime } from "../../runtime/RuntimeProvider.tsx";

function supportsPassiveValidation(providerId: string): providerId is "codex" | "gemini-cli" {
  // Claude's auth-status command can refresh provider-owned OAuth state before exiting. Running it
  // as a short-lived observer risks interrupting that write, so Claude is validated by the real
  // provider launch instead. Persisted Claude state remains available in the meantime.
  return providerId === "codex" || providerId === "gemini-cli";
}

interface ProviderAccountSessionsValue {
  /** Persisted account metadata, available as soon as the local native read completes. */
  accounts: ProviderAccount[] | null;
  loadError: string | null;
  /** Account ids whose provider-native session is being checked in the background. */
  checking: ReadonlySet<string>;
  /** Transient validation failures. Last-known authentication remains authoritative. */
  validationErrors: ReadonlyMap<string, string>;
  reload: () => Promise<ProviderAccount[] | null>;
  validate: (account: ProviderAccount) => Promise<ProviderAccount>;
  replace: (account: ProviderAccount) => ProviderAccount;
  /** Invalidates an older validation before a user-driven mutation starts. */
  supersede: (accountId: string) => void;
}

const ProviderAccountSessionsContext = createContext<ProviderAccountSessionsValue | null>(null);

// Native account metadata is local and normally available immediately. A short bounded retry
// covers startup/runtime handoff races without delaying the shell or creating a refresh prompt.
const RESTORE_RETRY_DELAYS_MS = [160, 640] as const;
const AUTH_EVENT_READ_ATTEMPTS = 3;
const AUTH_FAILURE_CODES = new Set([
  "api_authentication_failed",
  "api_oauth_org_not_allowed",
  "provider_authentication_failed",
  "provider_oauth_org_not_allowed",
]);

type SessionFacts = Pick<
  ProviderAccount,
  "providerReportedIdentity" | "authenticationState" | "lastCheckedAt" | "lastErrorCode"
>;

function sameSessionFacts(left: SessionFacts, right: SessionFacts): boolean {
  return (
    left.providerReportedIdentity === right.providerReportedIdentity &&
    left.authenticationState === right.authenticationState &&
    left.lastCheckedAt === right.lastCheckedAt &&
    left.lastErrorCode === right.lastErrorCode
  );
}

function validation(client: KalCodeClient, account: ProviderAccount): Promise<ProviderAccount> {
  switch (account.providerId) {
    case "codex":
      return client.refreshCodexAccount(account.id);
    case "gemini-cli":
      return client.refreshGeminiAccount(account.id);
    default:
      return Promise.resolve(account);
  }
}

/**
 * Shell-lifetime account state. The local account registry is restored first; provider checks run
 * afterward and never blank the account picker or overwrite a newer logout/archive operation.
 */
export function ProviderAccountSessionsProvider({ children }: { children: ReactNode }) {
  const { client, feed } = useRuntime();
  const [accounts, setAccounts] = useState<ProviderAccount[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [checking, setChecking] = useState<ReadonlySet<string>>(() => new Set());
  const [validationErrors, setValidationErrors] = useState<ReadonlyMap<string, string>>(() => new Map());
  const accountsRef = useRef(accounts);
  accountsRef.current = accounts;
  const versions = useRef(new Map<string, number>());
  const startedFor = useRef<KalCodeClient | null>(null);
  const live = useRef(true);
  const registryVersion = useRef(0);
  const clientEpoch = useRef(0);
  const validations = useRef(new Map<string, Promise<ProviderAccount>>());
  const pendingRestoreRetry = useRef<{ timer: ReturnType<typeof setTimeout>; resolve: () => void } | null>(null);

  const version = useCallback((accountId: string) => versions.current.get(accountId) ?? 0, []);
  const supersede = useCallback((accountId: string) => {
    registryVersion.current += 1;
    versions.current.set(accountId, (versions.current.get(accountId) ?? 0) + 1);
    validations.current.delete(accountId);
    setChecking((current) => {
      if (!current.has(accountId)) return current;
      const next = new Set(current);
      next.delete(accountId);
      return next;
    });
  }, []);

  const commit = useCallback(
    (account: ProviderAccount, expectedVersion?: number): boolean => {
      if (!live.current) return false;
      if (expectedVersion !== undefined && version(account.id) !== expectedVersion) return false;
      if (expectedVersion === undefined) {
        versions.current.set(account.id, version(account.id) + 1);
        registryVersion.current += 1;
      }
      setAccounts((current) => {
        if (!current) return account.archivedAt === null ? [account] : [];
        // A validation response owns session facts only. Owner metadata may have changed while the
        // provider check was running (especially default/order, rename or archive), so it can
        // never replace the whole record or make a different account non-default.
        if (expectedVersion !== undefined) {
          return current.map((candidate) =>
            candidate.id === account.id
              ? {
                  ...candidate,
                  providerReportedIdentity: account.providerReportedIdentity,
                  authenticationState: account.authenticationState,
                  lastCheckedAt: account.lastCheckedAt,
                  lastErrorCode: account.lastErrorCode,
                }
              : candidate,
          );
        }
        const next = current.map((candidate) => {
          if (candidate.id === account.id) return account;
          if (account.isDefault && candidate.providerId === account.providerId)
            return { ...candidate, isDefault: false };
          return candidate;
        });
        if (!next.some((candidate) => candidate.id === account.id) && account.archivedAt === null) next.push(account);
        return next.filter((candidate) => candidate.archivedAt === null);
      });
      return true;
    },
    [version],
  );

  const replace = useCallback(
    (account: ProviderAccount) => {
      commit(account);
      setValidationErrors((current) => {
        if (!current.has(account.id)) return current;
        const next = new Map(current);
        next.delete(account.id);
        return next;
      });
      return account;
    },
    [commit],
  );

  const validate = useCallback(
    (account: ProviderAccount): Promise<ProviderAccount> => {
      if (!supportsPassiveValidation(account.providerId)) return Promise.resolve(account);
      const existing = validations.current.get(account.id);
      if (existing) return existing;
      const expectedVersion = version(account.id);
      const expectedClientEpoch = clientEpoch.current;
      setChecking((current) => new Set(current).add(account.id));
      setValidationErrors((current) => {
        if (!current.has(account.id)) return current;
        const next = new Map(current);
        next.delete(account.id);
        return next;
      });
      const task = Promise.resolve()
        .then(() =>
          clientEpoch.current === expectedClientEpoch && version(account.id) === expectedVersion
            ? validation(client, account)
            : account,
        )
        .then((checked) => {
          if (clientEpoch.current === expectedClientEpoch) commit(checked, expectedVersion);
          return checked;
        })
        .catch((error: unknown) => {
          if (live.current && clientEpoch.current === expectedClientEpoch && version(account.id) === expectedVersion) {
            const message = toKalCodeError(error).message;
            setValidationErrors((current) => new Map(current).set(account.id, message));
          }
          throw error;
        })
        .finally(() => {
          if (validations.current.get(account.id) === task) validations.current.delete(account.id);
          if (live.current && clientEpoch.current === expectedClientEpoch && version(account.id) === expectedVersion) {
            setChecking((current) => {
              const next = new Set(current);
              next.delete(account.id);
              return next;
            });
          }
        });
      validations.current.set(account.id, task);
      return task;
    },
    [client, commit, version],
  );

  const validateRestored = useCallback(
    (restored: readonly ProviderAccount[], owner: KalCodeClient, expectedClientEpoch: number) => {
      const queued = restored.filter(
        (account) => account.archivedAt === null && supportsPassiveValidation(account.providerId),
      );
      let next = 0;
      // Provider checks can start CLI processes. Keep them bounded so a large account list never
      // competes with startup or an agent the user launches immediately.
      const worker = async () => {
        while (
          next < queued.length &&
          live.current &&
          startedFor.current === owner &&
          clientEpoch.current === expectedClientEpoch
        ) {
          const account = queued[next++];
          if (account) await validate(account).catch(() => undefined);
        }
      };
      for (let index = 0; index < Math.min(3, queued.length); index += 1) void worker();
    },
    [validate],
  );

  const readAccounts = useCallback(
    async (reportError: boolean): Promise<ProviderAccount[] | null> => {
      const expectedRegistryVersion = registryVersion.current;
      const expectedClientEpoch = clientEpoch.current;
      try {
        const restored = await client.listProviderAccounts();
        if (!live.current || clientEpoch.current !== expectedClientEpoch) return null;
        // A list read that began before logout/archive/default changed must not restore its older
        // snapshot over the mutation result.
        if (registryVersion.current !== expectedRegistryVersion) return null;
        setAccounts(restored);
        setLoadError(null);
        return restored;
      } catch (error) {
        if (live.current && clientEpoch.current === expectedClientEpoch && reportError) {
          setLoadError(toKalCodeError(error).message);
        }
        return null;
      }
    },
    [client],
  );

  const reload = useCallback(async (): Promise<ProviderAccount[] | null> => {
    const owner = client;
    const expectedClientEpoch = clientEpoch.current;
    const restored = await readAccounts(true);
    if (restored) validateRestored(restored, owner, expectedClientEpoch);
    return restored;
  }, [client, readAccounts, validateRestored]);

  useEffect(() => {
    const cleanup = () => {
      live.current = false;
      const pending = pendingRestoreRetry.current;
      if (pending) {
        clearTimeout(pending.timer);
        pendingRestoreRetry.current = null;
        pending.resolve();
      }
    };
    live.current = true;
    if (startedFor.current === client) return cleanup;
    startedFor.current = client;
    clientEpoch.current += 1;
    const expectedClientEpoch = clientEpoch.current;
    versions.current.clear();
    validations.current.clear();
    registryVersion.current += 1;
    setAccounts(null);
    setChecking(new Set());
    setValidationErrors(new Map());
    const owner = client;
    const restore = async () => {
      let restored: ProviderAccount[] | null = null;
      for (let attempt = 0; attempt <= RESTORE_RETRY_DELAYS_MS.length; attempt += 1) {
        if (!live.current || startedFor.current !== owner || clientEpoch.current !== expectedClientEpoch) return;
        restored = await readAccounts(attempt === RESTORE_RETRY_DELAYS_MS.length);
        if (restored) break;
        if (
          attempt === RESTORE_RETRY_DELAYS_MS.length ||
          !live.current ||
          startedFor.current !== owner ||
          clientEpoch.current !== expectedClientEpoch
        ) {
          return;
        }
        const delay = RESTORE_RETRY_DELAYS_MS[attempt];
        if (delay === undefined) return;
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            if (pendingRestoreRetry.current?.timer === timer) pendingRestoreRetry.current = null;
            resolve();
          }, delay);
          pendingRestoreRetry.current = { timer, resolve };
        });
      }
      if (!restored || !live.current || startedFor.current !== owner || clientEpoch.current !== expectedClientEpoch) {
        return;
      }
      // The restored state paints immediately. These provider-native checks settle independently
      // and a transient failure leaves the last known safe session usable.
      validateRestored(restored, owner, expectedClientEpoch);
    };
    void restore();
    return cleanup;
  }, [client, readAccounts, validateRestored]);

  useEffect(() => {
    // Provider sessions can discover real expiration while they run. Native persists that exact
    // account before emitting its auth-failure event. The shared runtime feed already owns the native
    // subscription; this listener rereads only the local registry and never runs an observer or
    // login command.
    if (!feed) return;
    let active = true;
    let seenSeq = feed.getSnapshot().events[0]?.seq ?? 0;
    const reconcileState = { dirty: false, running: false };

    const reconcile = () => {
      reconcileState.dirty = true;
      if (reconcileState.running) return;
      reconcileState.running = true;
      void (async () => {
        let attempts = 0;
        while (active && reconcileState.dirty && attempts < AUTH_EVENT_READ_ATTEMPTS) {
          reconcileState.dirty = false;
          attempts += 1;
          const expectedClientEpoch = clientEpoch.current;
          const expectedRegistryVersion = registryVersion.current;
          let restored: ProviderAccount[];
          try {
            restored = await client.listProviderAccounts();
          } catch {
            reconcileState.dirty = true;
            continue;
          }
          if (!active || !live.current || clientEpoch.current !== expectedClientEpoch) return;
          // A user mutation landed during this local read. Read again so the latest persisted
          // session facts win without losing nickname/default/order metadata.
          if (registryVersion.current !== expectedRegistryVersion) {
            reconcileState.dirty = true;
            continue;
          }
          const current = accountsRef.current;
          if (!current) {
            // This event can beat the initial restore. Its local snapshot is canonical and bumps
            // the registry generation so the older startup read cannot overwrite it afterward.
            registryVersion.current += 1;
            setAccounts(restored);
            continue;
          }
          const restoredById = new Map(restored.map((account) => [account.id, account]));
          const changedIds = new Set(
            current
              .filter((account) => {
                const next = restoredById.get(account.id);
                return next !== undefined && !sameSessionFacts(account, next);
              })
              .map((account) => account.id),
          );
          if (changedIds.size === 0) continue;
          // Canonical session metadata wins over any older observer already in flight. Metadata
          // such as nickname/default/order and other providers remain exactly as rendered.
          registryVersion.current += 1;
          for (const accountId of changedIds) {
            versions.current.set(accountId, version(accountId) + 1);
            validations.current.delete(accountId);
          }
          setChecking((currentChecking) => {
            if (![...changedIds].some((accountId) => currentChecking.has(accountId))) return currentChecking;
            const next = new Set(currentChecking);
            for (const accountId of changedIds) next.delete(accountId);
            return next;
          });
          setAccounts(
            (currentAccounts) =>
              currentAccounts?.map((account) => {
                if (!changedIds.has(account.id)) return account;
                const next = restoredById.get(account.id);
                return next
                  ? {
                      ...account,
                      providerReportedIdentity: next.providerReportedIdentity,
                      authenticationState: next.authenticationState,
                      lastCheckedAt: next.lastCheckedAt,
                      lastErrorCode: next.lastErrorCode,
                    }
                  : account;
              }) ?? null,
          );
        }
        reconcileState.running = false;
      })();
    };

    const unsubscribe = feed.subscribe(() => {
      if (!active) return;
      const events = feed.getSnapshot().events.filter((event) => event.seq > seenSeq);
      if (events.length === 0) return;
      seenSeq = Math.max(seenSeq, ...events.map((event) => event.seq));
      if (
        events.some(
          (event) =>
            (event.type === "provider.error" || event.type === "thread.failed") &&
            AUTH_FAILURE_CODES.has(event.payload.code),
        )
      ) {
        reconcile();
      }
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [client, feed, version]);

  const value = useMemo<ProviderAccountSessionsValue>(
    () => ({ accounts, loadError, checking, validationErrors, reload, validate, replace, supersede }),
    [accounts, loadError, checking, validationErrors, reload, validate, replace, supersede],
  );
  return <ProviderAccountSessionsContext.Provider value={value}>{children}</ProviderAccountSessionsContext.Provider>;
}

/** Optional so isolated component tests and embedders can retain their direct-client fallback. */
export function useOptionalProviderAccountSessions(): ProviderAccountSessionsValue | null {
  return useContext(ProviderAccountSessionsContext);
}
