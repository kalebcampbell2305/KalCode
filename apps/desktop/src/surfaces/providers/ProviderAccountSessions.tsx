import type { ProviderAccount } from "@kalcode/protocol";
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { KalCodeClient } from "../../ipc/client.ts";
import { toKalCodeError } from "../../ipc/errors.ts";
import { useRuntime } from "../../runtime/RuntimeProvider.tsx";
import type { AccountUsageState } from "./accountUsage.ts";
import { useAccountUsageReader } from "./accountUsageReader.ts";
import { type AccountModels, type ProviderAccountState, providerAccountState } from "./providerAccountState.ts";

function supportsPassiveValidation(providerId: string): providerId is "codex" | "gemini-cli" {
  // Claude's auth-status command can refresh provider-owned OAuth state before exiting. Running it
  // as a short-lived observer risks interrupting that write, so Claude is validated by the real
  // provider launch instead. Persisted Claude state remains available in the meantime.
  // Cursor's status/models commands can also refresh native credentials; run them only for
  // explicit connection, refresh or model discovery, never as a startup observer.
  return providerId === "codex" || providerId === "gemini-cli";
}

interface ProviderAccountSessionsValue {
  /** Shared account snapshots for launchers, provider management and terminal identity. */
  states: ReadonlyMap<string, ProviderAccountState>;
  discoverModels: (accountId: string) => Promise<void>;
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
  /** Canonical provider-quota usage per account id (see accountUsage.ts). */
  usage: ReadonlyMap<string, AccountUsageState>;
  refreshUsage: () => void;
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
  // A launch that finds the native session expired persists `not_authenticated` for that exact
  // account (`launch_with_active_account`) and fails the agent with this code.
  "provider_not_authenticated",
]);
const MODEL_DISCOVERY_AUTH_FAILURE_CODES = new Set([
  "provider_account_not_authenticated",
  "cursor_session_expired",
  "cursor_not_authenticated",
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
  const [accountModels, setAccountModels] = useState<ReadonlyMap<string, AccountModels>>(() => new Map());
  const modelRequests = useRef(new Map<string, Promise<void>>());
  const pendingRestoreRetry = useRef<{ timer: ReturnType<typeof setTimeout>; resolve: () => void } | null>(null);

  const version = useCallback((accountId: string) => versions.current.get(accountId) ?? 0, []);
  const supersede = useCallback((accountId: string) => {
    registryVersion.current += 1;
    versions.current.set(accountId, (versions.current.get(accountId) ?? 0) + 1);
    validations.current.delete(accountId);
    modelRequests.current.delete(accountId);
    setAccountModels((current) => {
      const next = new Map(current);
      next.delete(accountId);
      return next;
    });
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
      const previous = accountsRef.current?.find((candidate) => candidate.id === account.id);
      if (expectedVersion !== undefined && previous && !sameSessionFacts(previous, account))
        registryVersion.current += 1;
      if (
        previous &&
        (previous.providerReportedIdentity !== account.providerReportedIdentity ||
          previous.authenticationState !== account.authenticationState)
      ) {
        versions.current.set(account.id, version(account.id) + 1);
        modelRequests.current.delete(account.id);
        setChecking((current) => {
          const next = new Set(current);
          next.delete(account.id);
          return next;
        });
        setAccountModels((current) => {
          const next = new Map(current);
          next.delete(account.id);
          return next;
        });
      }
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

  const discoverModels = useCallback(
    (accountId: string): Promise<void> => {
      const account = accountsRef.current?.find(
        (candidate) => candidate.id === accountId && candidate.archivedAt === null,
      );
      if (!account || account.authenticationState === "not_authenticated") return Promise.resolve();
      const existing = modelRequests.current.get(account.id);
      if (existing) return existing;
      const expectedVersion = version(account.id);
      const expectedEpoch = clientEpoch.current;
      const current = () =>
        live.current && clientEpoch.current === expectedEpoch && version(account.id) === expectedVersion;
      setAccountModels((previous) =>
        new Map(previous).set(account.id, {
          status: "checking",
          items: previous.get(account.id)?.items ?? [],
          reason: null,
        }),
      );
      let task!: Promise<void>;
      task = (async () => {
        await Promise.resolve();
        try {
          const catalog = await client.providerAccountModels(account.id);
          if (!current()) return;
          if (catalog.accountId !== account.id || catalog.providerId !== account.providerId) {
            throw new Error("Model response did not match the selected account");
          }
          const result: AccountModels = { status: "available", items: catalog.models, reason: null };
          if (current()) setAccountModels((previous) => new Map(previous).set(account.id, result));
        } catch (error) {
          const failure = toKalCodeError(error);
          if (MODEL_DISCOVERY_AUTH_FAILURE_CODES.has(failure.code) && current()) {
            try {
              const restored = (await client.listProviderAccounts()).find(
                (candidate) => candidate.id === account.id && candidate.providerId === account.providerId,
              );
              if (restored && current() && restored.authenticationState === "not_authenticated") {
                commit(restored, expectedVersion);
                return;
              }
            } catch {
              // Model discovery already has the safe provider error. A failed local metadata read
              // cannot revoke a last-known valid session or broaden the affected account.
            }
          }
          if (current())
            setAccountModels((previous) =>
              new Map(previous).set(account.id, {
                status: "unavailable",
                items: [],
                reason: failure.message,
              }),
            );
        } finally {
          if (modelRequests.current.get(account.id) === task) {
            modelRequests.current.delete(account.id);
            if (!current() && live.current && clientEpoch.current === expectedEpoch)
              setAccountModels((previous) =>
                new Map(previous).set(account.id, {
                  status: "unavailable",
                  items: [],
                  reason: "Model availability changed. Choose the account again to refresh.",
                }),
              );
          }
        }
      })();
      modelRequests.current.set(account.id, task);
      return task;
    },
    [client, commit, version],
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
        for (const previous of accountsRef.current ?? []) {
          const next = restored.find((account) => account.id === previous.id);
          if (
            !next ||
            next.archivedAt !== null ||
            next.providerId !== previous.providerId ||
            next.providerReportedIdentity !== previous.providerReportedIdentity ||
            next.authenticationState !== previous.authenticationState
          )
            supersede(previous.id);
        }
        accountsRef.current = restored;
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
    [client, supersede],
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
    modelRequests.current.clear();
    setAccountModels(new Map());
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
    const reconcileState = { eventGeneration: 0, running: false };

    const runReconcileBatch = (): void => {
      reconcileState.running = true;
      const expectedEventGeneration = reconcileState.eventGeneration;
      void (async () => {
        let attempts = 0;
        while (active && attempts < AUTH_EVENT_READ_ATTEMPTS) {
          attempts += 1;
          const expectedClientEpoch = clientEpoch.current;
          const expectedRegistryVersion = registryVersion.current;
          let restored: ProviderAccount[];
          try {
            restored = await client.listProviderAccounts();
          } catch {
            continue;
          }
          if (!active || !live.current || clientEpoch.current !== expectedClientEpoch) return;
          // A user mutation landed during this local read. Read again so the latest persisted
          // session facts win without losing nickname/default/order metadata.
          if (registryVersion.current !== expectedRegistryVersion) {
            continue;
          }
          const current = accountsRef.current;
          if (!current) {
            // This event can beat the initial restore. Its local snapshot is canonical and bumps
            // the registry generation so the older startup read cannot overwrite it afterward.
            registryVersion.current += 1;
            setAccounts(restored);
            break;
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
          if (changedIds.size === 0) break;
          // Canonical session metadata wins over any older observer already in flight. Metadata
          // such as nickname/default/order and other providers remain exactly as rendered.
          registryVersion.current += 1;
          for (const accountId of changedIds) {
            versions.current.set(accountId, version(accountId) + 1);
            validations.current.delete(accountId);
            modelRequests.current.delete(accountId);
          }
          setAccountModels((previous) => {
            const next = new Map(previous);
            for (const accountId of changedIds) next.delete(accountId);
            return next;
          });
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
          break;
        }
        reconcileState.running = false;
        // A real auth event that arrived during the final attempt gets its own fresh bounded
        // batch. A persistent local read failure cannot reschedule itself indefinitely.
        if (active && reconcileState.eventGeneration !== expectedEventGeneration) runReconcileBatch();
      })();
    };

    const reconcile = () => {
      reconcileState.eventGeneration += 1;
      if (!reconcileState.running) runReconcileBatch();
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

  // Real provider quota usage, read passively in the background (accountUsageReader.ts). It
  // never blocks restore, menus or launches; entries update in place when a read lands.
  const [usageRequest, setUsageRequest] = useState(0);
  const refreshUsage = useCallback(() => setUsageRequest((request) => request + 1), []);
  const usage = useAccountUsageReader(client, accounts, feed, usageRequest, versions.current);
  const states = useMemo(
    () =>
      new Map(
        (accounts ?? []).map((account) => [
          account.id,
          providerAccountState(
            account,
            usage.get(account.id) ?? {
              accountId: account.id,
              status: "not_checked",
              windows: [],
              checkedAt: null,
              reason: null,
            },
            checking.has(account.id),
            validationErrors.get(account.id),
            accountModels.get(account.id) ?? null,
          ),
        ]),
      ),
    [accounts, usage, checking, validationErrors, accountModels],
  );

  const value = useMemo<ProviderAccountSessionsValue>(
    () => ({
      states,
      discoverModels,
      accounts,
      loadError,
      checking,
      validationErrors,
      reload,
      validate,
      replace,
      supersede,
      usage,
      refreshUsage,
    }),
    [
      states,
      discoverModels,
      accounts,
      loadError,
      checking,
      validationErrors,
      reload,
      validate,
      replace,
      supersede,
      usage,
      refreshUsage,
    ],
  );
  return <ProviderAccountSessionsContext.Provider value={value}>{children}</ProviderAccountSessionsContext.Provider>;
}

/** Optional so isolated component tests and embedders can retain their direct-client fallback. */
export function useOptionalProviderAccountSessions(): ProviderAccountSessionsValue | null {
  return useContext(ProviderAccountSessionsContext);
}
