import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import type {
  AccountOpenResult,
  AccountSnapshot,
  AccountUsageSnapshot,
  BillingInterval,
  PurchasableTier,
  RuntimeStatus,
} from "../ipc/account.ts";
import { type AccountUiError, type AccountUiState, initialAccountUiState, reduceAccountUi } from "./accountState.ts";

export const MAX_CONFIRMATION_POLLS = 6;
export const MAX_RUNTIME_STATUS_POLLS = 120;
export const MAX_SOCIAL_STATUS_POLLS = 1_200;
const DEFAULT_CONFIRMATION_POLL_MS = 2_000;
const DEFAULT_RUNTIME_POLL_MS = 250;
const DEFAULT_SOCIAL_STATUS_POLL_MS = 500;

export type SocialProvider = "google" | "microsoft";

export interface AccountOperations {
  status(): Promise<AccountSnapshot>;
  runtimeStatus(): Promise<RuntimeStatus>;
  retryRuntime(): Promise<void>;
  startEmail(email: string): Promise<AccountSnapshot>;
  startSocial(provider: SocialProvider): Promise<AccountSnapshot>;
  pollEmail(): Promise<AccountSnapshot>;
  cancelAuth(): Promise<AccountSnapshot>;
  activateFree(): Promise<AccountSnapshot>;
  checkout(tier: PurchasableTier, interval?: BillingInterval): Promise<AccountSnapshot>;
  portal(): Promise<AccountOpenResult>;
  refresh(): Promise<AccountSnapshot>;
  logout(): Promise<AccountSnapshot>;
  usage(): Promise<AccountUsageSnapshot | null>;
}

export interface AccountActions {
  startEmail(email: string): Promise<void>;
  startSocial(provider: SocialProvider): Promise<void>;
  pollEmail(): Promise<void>;
  cancelAuth(): Promise<void>;
  activateFree(): Promise<void>;
  checkout(tier: PurchasableTier, interval?: BillingInterval): Promise<void>;
  portal(): Promise<void>;
  refresh(): Promise<void>;
  logout(): Promise<void>;
  retry(): Promise<void>;
  /**
   * Re-reads KalVoice usage in the background (never busy, never blocks): surfaces that show it
   * call this when they open, so requests used during the session appear.
   */
  refreshUsage(): Promise<void>;
}

export interface AccountContextValue extends AccountUiState {
  usage: AccountUsageSnapshot | null;
  actions: AccountActions;
}

const AccountContext = createContext<AccountContextValue | null>(null);

function safeError(error: unknown): AccountUiError {
  if (error && typeof error === "object") {
    const value = error as Record<string, unknown>;
    if (typeof value.code === "string" && typeof value.message === "string" && typeof value.retryable === "boolean") {
      return { code: value.code, message: value.message, retryable: value.retryable };
    }
  }
  return {
    code: "account_request_failed",
    message: "KalCode couldn't verify your account. Try again.",
    retryable: true,
  };
}

function hasActiveAuthority(snapshot: AccountSnapshot): boolean {
  return snapshot.phase === "ready" || snapshot.phase === "offline_grace";
}

function runtimeSettled(snapshot: AccountSnapshot, runtime: RuntimeStatus): boolean {
  if (runtime.phase === "blocked_unclean" || runtime.phase === "app_exiting") return true;
  return hasActiveAuthority(snapshot) ? runtime.phase === "ready" : runtime.phase === "signed_out";
}

export function AccountProvider({
  client,
  confirmationPollMs = DEFAULT_CONFIRMATION_POLL_MS,
  runtimePollMs = DEFAULT_RUNTIME_POLL_MS,
  socialStatusPollMs = DEFAULT_SOCIAL_STATUS_POLL_MS,
  children,
}: {
  client: AccountOperations;
  confirmationPollMs?: number;
  runtimePollMs?: number;
  socialStatusPollMs?: number;
  children: ReactNode;
}) {
  const [state, dispatch] = useReducer(reduceAccountUi, initialAccountUiState);
  const [usage, setUsage] = useState<AccountUsageSnapshot | null>(null);
  const latestState = useRef(state);
  latestState.current = state;
  const generation = useRef(0);
  const confirmationTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const runtimeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const socialTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mounted = useRef(true);

  const clearTimers = useCallback(() => {
    if (confirmationTimer.current !== null) clearTimeout(confirmationTimer.current);
    if (runtimeTimer.current !== null) clearTimeout(runtimeTimer.current);
    if (socialTimer.current !== null) clearTimeout(socialTimer.current);
    confirmationTimer.current = null;
    runtimeTimer.current = null;
    socialTimer.current = null;
  }, []);

  const nextGeneration = useCallback(() => {
    generation.current += 1;
    clearTimers();
    return generation.current;
  }, [clearTimers]);

  const refreshUsage = useCallback(
    async (expectedGeneration: number, snapshot: AccountSnapshot, runtime: RuntimeStatus) => {
      if (!hasActiveAuthority(snapshot) || !runtime.ready) {
        if (mounted.current && expectedGeneration === generation.current) setUsage(null);
        return;
      }
      try {
        const next = await client.usage();
        if (mounted.current && expectedGeneration === generation.current) setUsage(next);
      } catch {
        if (mounted.current && expectedGeneration === generation.current) setUsage(null);
      }
    },
    [client],
  );

  const pollRuntime = useCallback(
    (expectedGeneration: number, snapshot: AccountSnapshot, attempt: number) => {
      if (attempt >= MAX_RUNTIME_STATUS_POLLS || expectedGeneration !== generation.current) {
        if (attempt >= MAX_RUNTIME_STATUS_POLLS && mounted.current && expectedGeneration === generation.current) {
          dispatch({
            type: "error",
            generation: expectedGeneration,
            error: {
              code: "runtime_transition_timeout",
              message: "KalCode couldn't finish securing the workspace. Try again.",
              retryable: true,
            },
          });
        }
        return;
      }
      runtimeTimer.current = setTimeout(() => {
        runtimeTimer.current = null;
        if (!mounted.current || expectedGeneration !== generation.current) return;
        void client
          .runtimeStatus()
          .then((runtime) => {
            if (!mounted.current || expectedGeneration !== generation.current) return;
            dispatch({ type: "runtime", generation: expectedGeneration, runtime });
            if (!runtimeSettled(snapshot, runtime)) {
              pollRuntime(expectedGeneration, snapshot, attempt + 1);
            } else {
              void refreshUsage(expectedGeneration, snapshot, runtime);
            }
          })
          .catch((error: unknown) => {
            if (!mounted.current || expectedGeneration !== generation.current) return;
            dispatch({ type: "error", generation: expectedGeneration, error: safeError(error) });
          });
      }, runtimePollMs);
    },
    [client, refreshUsage, runtimePollMs],
  );

  const pollConfirmation = useCallback(
    (expectedGeneration: number, attempt: number) => {
      if (attempt >= MAX_CONFIRMATION_POLLS || expectedGeneration !== generation.current) {
        if (attempt >= MAX_CONFIRMATION_POLLS && mounted.current && expectedGeneration === generation.current) {
          dispatch({
            type: "error",
            generation: expectedGeneration,
            error: {
              code: "plan_confirmation_timeout",
              message: "KalCode is still waiting for signed plan confirmation. Try again.",
              retryable: true,
            },
          });
        }
        return;
      }
      confirmationTimer.current = setTimeout(() => {
        confirmationTimer.current = null;
        if (!mounted.current || expectedGeneration !== generation.current) return;
        void client
          .refresh()
          .then(async (snapshot) => {
            if (!mounted.current || expectedGeneration !== generation.current) return;
            let runtime: RuntimeStatus;
            try {
              runtime = await client.runtimeStatus();
            } catch (error) {
              if (!mounted.current || expectedGeneration !== generation.current) return;
              dispatch({ type: "snapshot", generation: expectedGeneration, snapshot });
              dispatch({ type: "error", generation: expectedGeneration, error: safeError(error) });
              return;
            }
            if (!mounted.current || expectedGeneration !== generation.current) return;
            dispatch({ type: "resolved", generation: expectedGeneration, snapshot, runtime });
            if (snapshot.phase === "confirming_plan") {
              pollConfirmation(expectedGeneration, attempt + 1);
            } else if (!runtimeSettled(snapshot, runtime)) {
              pollRuntime(expectedGeneration, snapshot, 0);
            } else {
              void refreshUsage(expectedGeneration, snapshot, runtime);
            }
          })
          .catch((error: unknown) => {
            if (!mounted.current || expectedGeneration !== generation.current) return;
            dispatch({ type: "error", generation: expectedGeneration, error: safeError(error) });
          });
      }, confirmationPollMs);
    },
    [client, confirmationPollMs, pollRuntime, refreshUsage],
  );

  const pollSocialStatus = useCallback(
    (expectedGeneration: number, attempt: number) => {
      if (expectedGeneration !== generation.current) return;
      if (attempt >= MAX_SOCIAL_STATUS_POLLS) {
        void client
          .cancelAuth()
          .then(async (snapshot) => {
            if (!mounted.current || expectedGeneration !== generation.current) return;
            const runtime = await client.runtimeStatus();
            if (!mounted.current || expectedGeneration !== generation.current) return;
            dispatch({ type: "resolved", generation: expectedGeneration, snapshot, runtime });
            dispatch({
              type: "error",
              generation: expectedGeneration,
              error: {
                code: "social_sign_in_timeout",
                message: "The browser sign-in expired. Start again.",
                retryable: false,
              },
            });
          })
          .catch((error: unknown) => {
            if (mounted.current && expectedGeneration === generation.current) {
              dispatch({ type: "error", generation: expectedGeneration, error: safeError(error) });
            }
          });
        return;
      }
      socialTimer.current = setTimeout(() => {
        socialTimer.current = null;
        if (!mounted.current || expectedGeneration !== generation.current) return;
        void client
          .status()
          .then(async (snapshot) => {
            if (!mounted.current || expectedGeneration !== generation.current) return;
            if (snapshot.phase === "social_pending") {
              dispatch({ type: "snapshot", generation: expectedGeneration, snapshot });
              pollSocialStatus(expectedGeneration, attempt + 1);
              return;
            }
            const runtime = await client.runtimeStatus();
            if (!mounted.current || expectedGeneration !== generation.current) return;
            dispatch({ type: "resolved", generation: expectedGeneration, snapshot, runtime });
            if (!runtimeSettled(snapshot, runtime)) pollRuntime(expectedGeneration, snapshot, 0);
            else void refreshUsage(expectedGeneration, snapshot, runtime);
          })
          .catch((error: unknown) => {
            if (!mounted.current || expectedGeneration !== generation.current) return;
            const nextError = safeError(error);
            dispatch({ type: "error", generation: expectedGeneration, error: nextError });
            if (nextError.retryable) pollSocialStatus(expectedGeneration, attempt + 1);
          });
      }, socialStatusPollMs);
    },
    [client, pollRuntime, refreshUsage, socialStatusPollMs],
  );

  const pollBootstrap = useCallback(
    (expectedGeneration: number, attempt: number) => {
      if (expectedGeneration !== generation.current) return;
      if (attempt >= MAX_RUNTIME_STATUS_POLLS) {
        if (mounted.current) {
          dispatch({
            type: "error",
            generation: expectedGeneration,
            error: {
              code: "account_bootstrap_timeout",
              message: "KalCode couldn't finish restoring your session. Try again.",
              retryable: true,
            },
          });
        }
        return;
      }
      runtimeTimer.current = setTimeout(() => {
        runtimeTimer.current = null;
        if (!mounted.current || expectedGeneration !== generation.current) return;
        void client
          .status()
          .then(async (snapshot) => {
            if (!mounted.current || expectedGeneration !== generation.current) return;
            const runtime = await client.runtimeStatus();
            if (!mounted.current || expectedGeneration !== generation.current) return;
            dispatch({ type: "resolved", generation: expectedGeneration, snapshot, runtime });
            if (snapshot.phase === "bootstrapping") pollBootstrap(expectedGeneration, attempt + 1);
            else if (snapshot.phase === "social_pending") pollSocialStatus(expectedGeneration, 0);
            else if (snapshot.phase === "confirming_plan") pollConfirmation(expectedGeneration, 0);
            else if (!runtimeSettled(snapshot, runtime)) pollRuntime(expectedGeneration, snapshot, 0);
            else void refreshUsage(expectedGeneration, snapshot, runtime);
          })
          .catch((error: unknown) => {
            if (!mounted.current || expectedGeneration !== generation.current) return;
            dispatch({ type: "error", generation: expectedGeneration, error: safeError(error) });
          });
      }, runtimePollMs);
    },
    [client, pollConfirmation, pollRuntime, pollSocialStatus, refreshUsage, runtimePollMs],
  );

  const runSnapshot = useCallback(
    async (operation: () => Promise<AccountSnapshot>, confirmPaid = false) => {
      const expectedGeneration = nextGeneration();
      dispatch({ type: "begin", generation: expectedGeneration });
      let snapshot: AccountSnapshot | null = null;
      try {
        snapshot = await operation();
        if (!mounted.current || expectedGeneration !== generation.current) return;
        const runtime = await client.runtimeStatus();
        if (!mounted.current || expectedGeneration !== generation.current) return;
        dispatch({ type: "resolved", generation: expectedGeneration, snapshot, runtime });
        if (snapshot.phase === "bootstrapping") {
          pollBootstrap(expectedGeneration, 0);
        } else if (snapshot.phase === "social_pending") {
          pollSocialStatus(expectedGeneration, 0);
        } else if (confirmPaid && snapshot.phase === "confirming_plan") {
          pollConfirmation(expectedGeneration, 0);
        } else if (!runtimeSettled(snapshot, runtime)) {
          pollRuntime(expectedGeneration, snapshot, 0);
        } else {
          await refreshUsage(expectedGeneration, snapshot, runtime);
        }
      } catch (error) {
        if (!mounted.current || expectedGeneration !== generation.current) return;
        if (snapshot !== null) dispatch({ type: "snapshot", generation: expectedGeneration, snapshot });
        dispatch({ type: "error", generation: expectedGeneration, error: safeError(error) });
      }
    },
    [client, nextGeneration, pollBootstrap, pollConfirmation, pollRuntime, pollSocialStatus, refreshUsage],
  );

  useEffect(() => {
    mounted.current = true;
    void runSnapshot(() => client.status());
    return () => {
      mounted.current = false;
      generation.current += 1;
      clearTimers();
    };
  }, [clearTimers, client, runSnapshot]);

  // Reads usage for the current authority; an account action that starts meanwhile wins.
  const refreshUsageNow = useCallback(
    () => refreshUsage(generation.current, latestState.current.snapshot, latestState.current.runtime),
    [refreshUsage],
  );

  const actions = useMemo<AccountActions>(
    () => ({
      startEmail: (email) => runSnapshot(() => client.startEmail(email)),
      startSocial: (provider) => runSnapshot(() => client.startSocial(provider)),
      pollEmail: () => runSnapshot(() => client.pollEmail()),
      cancelAuth: () => runSnapshot(() => client.cancelAuth()),
      activateFree: () => runSnapshot(() => client.activateFree()),
      checkout: (tier, interval) => runSnapshot(() => client.checkout(tier, interval), true),
      portal: () =>
        runSnapshot(async () => {
          await client.portal();
          return client.status();
        }),
      refresh: () => runSnapshot(() => client.refresh()),
      logout: () => runSnapshot(() => client.logout()),
      retry: () =>
        state.runtime.phase === "blocked_unclean"
          ? runSnapshot(async () => {
              await client.retryRuntime();
              return client.status();
            })
          : state.snapshot.phase === "confirming_plan"
            ? runSnapshot(() => client.refresh(), true)
            : runSnapshot(() => client.status()),
      refreshUsage: refreshUsageNow,
    }),
    [client, refreshUsageNow, runSnapshot, state.snapshot.phase, state.runtime.phase],
  );

  const value = useMemo<AccountContextValue>(() => ({ ...state, usage, actions }), [actions, state, usage]);
  return <AccountContext.Provider value={value}>{children}</AccountContext.Provider>;
}

/** The account, or null outside an AccountProvider (e.g. isolated component tests). */
export function useOptionalAccount(): AccountContextValue | null {
  return useContext(AccountContext);
}

export function useAccount(): AccountContextValue {
  const value = useContext(AccountContext);
  if (!value) throw new Error("useAccount must be used inside AccountProvider");
  return value;
}
