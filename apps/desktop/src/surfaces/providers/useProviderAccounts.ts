import type { ProviderAccount, ProviderAccountBinding, ThreadSummary, Workspace } from "@kalcode/protocol";
import { useToast } from "@kalcode/ui/components";
import { useCallback, useEffect, useRef, useState } from "react";
import type { KalCodeClient } from "../../ipc/client.ts";
import { toKalCodeError } from "../../ipc/errors.ts";
import { useRuntime } from "../../runtime/RuntimeProvider.tsx";
import { isCodingAgent } from "../dashboard/data/agents.ts";
import { presentStatus } from "../threads/model.ts";
import { useOptionalProviderAccountSessions } from "./ProviderAccountSessions.tsx";
import { signInFailureTitle } from "./providerLabels.ts";

/** Providers whose own official sign-in KalCode runs natively for one managed account. */
export type BrowserAuthProvider = "claude-code" | "codex" | "gemini-cli";

export function isBrowserAuthProvider(providerId: string): providerId is BrowserAuthProvider {
  return providerId === "claude-code" || providerId === "codex" || providerId === "gemini-cli";
}

/** Providers whose read-only status command is safe to run outside a real provider launch. */
export function canRefreshProviderAuth(providerId: string): providerId is "codex" | "gemini-cli" {
  return providerId === "codex" || providerId === "gemini-cli";
}

const AUTH_PROVIDER_NAMES: Record<BrowserAuthProvider, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  "gemini-cli": "Gemini",
};

/** The native account-auth commands for one provider. Every call is Rust-owned and opaque. */
function authCommands(client: KalCodeClient, providerId: BrowserAuthProvider) {
  switch (providerId) {
    case "codex":
      return {
        start: (id: string) => client.startCodexLogin(id),
        wait: (handle: string) => client.waitForCodexLogin(handle),
        cancel: (handle: string) => client.cancelCodexLogin(handle),
        logout: (id: string) => client.logoutCodexAccount(id),
      };
    case "claude-code":
      return {
        start: (id: string) => client.startClaudeLogin(id),
        wait: (handle: string) => client.waitForClaudeLogin(handle),
        cancel: (handle: string) => client.cancelClaudeLogin(handle),
        logout: (id: string) => client.logoutClaudeAccount(id),
      };
    case "gemini-cli":
      return {
        start: (id: string) => client.startGeminiLogin(id),
        wait: (handle: string) => client.waitForGeminiLogin(handle),
        cancel: (handle: string) => client.cancelGeminiLogin(handle),
        logout: (id: string) => client.logoutGeminiAccount(id),
      };
  }
}

function refreshProviderAuth(client: KalCodeClient, providerId: "codex" | "gemini-cli", accountId: string) {
  return providerId === "codex" ? client.refreshCodexAccount(accountId) : client.refreshGeminiAccount(accountId);
}

interface ActiveLogin {
  accountId: string;
  handle: string;
  providerId: BrowserAuthProvider;
}

/** What uses one account right now. Derived from public thread and binding metadata only. */
export interface AccountUsage {
  /** Non-archived coding agents (terminal panes in Code) bound to the account. */
  agents: number;
  /** Of those, the ones whose provider is working now. */
  agentsRunning: number;
  /** Non-archived chat threads bound to the account (never coding agents). */
  threads: number;
  /** Of those, the ones whose provider is working now. */
  threadsRunning: number;
  /** Names of the workspaces whose default for this provider is the account, sorted. */
  workspaces: string[];
}

export const NO_USAGE: AccountUsage = { agents: 0, agentsRunning: 0, threads: 0, threadsRunning: 0, workspaces: [] };

/**
 * Per-account usage: non-archived coding agents and threads bound to each account, counted apart
 * (running ones counted separately), and the workspaces that remember each account. A binding for a workspace KalCode no
 * longer lists is not shown.
 */
export function accountUsage(
  threads: readonly ThreadSummary[],
  bindings: readonly ProviderAccountBinding[],
  workspaces: readonly Pick<Workspace, "id" | "name">[],
): Map<string, AccountUsage> {
  const usage = new Map<string, AccountUsage>();
  const entry = (accountId: string) => {
    let current = usage.get(accountId);
    if (!current) {
      current = { agents: 0, agentsRunning: 0, threads: 0, threadsRunning: 0, workspaces: [] };
      usage.set(accountId, current);
    }
    return current;
  };
  for (const thread of threads) {
    if (thread.archivedAt !== null || !thread.providerAccountId) continue;
    const current = entry(thread.providerAccountId);
    const running = presentStatus(thread.status).working ? 1 : 0;
    if (isCodingAgent(thread)) {
      current.agents += 1;
      current.agentsRunning += running;
    } else {
      current.threads += 1;
      current.threadsRunning += running;
    }
  }
  const names = new Map(workspaces.map((workspace) => [workspace.id, workspace.name]));
  for (const binding of bindings) {
    if (binding.kind !== "workspace") continue;
    const name = names.get(binding.scopeId);
    if (name !== undefined) entry(binding.accountId).workspaces.push(name);
  }
  for (const current of usage.values()) current.workspaces.sort((a, b) => a.localeCompare(b));
  return usage;
}

export function useProviderAccounts(enabled: boolean) {
  const { client } = useRuntime();
  const toast = useToast();
  const sessions = useOptionalProviderAccountSessions();
  const sessionReload = sessions?.reload;
  const retrySessionLoad = sessions?.accounts === null && sessions.loadError !== null;
  const [localAccounts, setLocalAccounts] = useState<ProviderAccount[] | null>(null);
  const [localLoadError, setLocalLoadError] = useState<string | null>(null);
  const [usage, setUsage] = useState<Map<string, AccountUsage> | null>(null);
  const [usageError, setUsageError] = useState<string | null>(null);
  const [usageRefreshing, setUsageRefreshing] = useState(false);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [activeLogin, setActiveLogin] = useState<ActiveLogin | null>(null);
  const cancelledLogins = useRef(new Set<string>());
  const activeLoginRef = useRef<ActiveLogin | null>(null);
  activeLoginRef.current = activeLogin;

  useEffect(
    () => () => {
      const login = activeLoginRef.current;
      if (login) {
        // Navigating away intentionally cancels the browser flow. Mark it before the native
        // cancellation races the pending wait, so the wait rejection cannot surface as a false
        // sign-in failure toast on the next screen.
        cancelledLogins.current.add(login.handle);
        void authCommands(client, login.providerId)
          .cancel(login.handle)
          .catch(() => undefined);
      }
    },
    [client],
  );

  // Thread use and workspace defaults are read separately: if they can't load, the accounts (and
  // their sign-in) still can, and the card says the usage is unavailable instead of showing zero.
  const loadUsage = useCallback(async () => {
    setUsageRefreshing(true);
    try {
      const [threads, bindings, workspaces] = await Promise.all([
        client.listThreads(),
        client.listProviderAccountBindings({ kind: "workspace" }),
        client.listWorkspaces(),
      ]);
      setUsage(accountUsage(threads, bindings, workspaces));
      setUsageError(null);
    } catch (error) {
      setUsageError(toKalCodeError(error).message);
    } finally {
      setUsageRefreshing(false);
    }
  }, [client]);

  const load = useCallback(async () => {
    if (!enabled) return;
    setLocalLoadError(null);
    void loadUsage();
    if (sessionReload) {
      if (retrySessionLoad) await sessionReload();
      return;
    }
    try {
      setLocalAccounts(await client.listProviderAccounts());
    } catch (error) {
      setLocalLoadError(toKalCodeError(error).message);
    }
  }, [client, enabled, loadUsage, retrySessionLoad, sessionReload]);

  useEffect(() => {
    void load();
  }, [load]);

  const replace = useCallback(
    (account: ProviderAccount) => {
      if (sessions) return sessions.replace(account);
      setLocalAccounts((current) => {
        if (!current) return [account];
        const next = current.map((candidate) => {
          if (candidate.id === account.id) return account;
          if (account.isDefault && candidate.providerId === account.providerId)
            return { ...candidate, isDefault: false };
          return candidate;
        });
        if (!next.some((candidate) => candidate.id === account.id)) next.push(account);
        return next.filter((candidate) => candidate.archivedAt === null);
      });
      return account;
    },
    [sessions],
  );

  const run = useCallback(
    async (
      key: string,
      failureTitle: string,
      operation: () => Promise<ProviderAccount>,
      accountId?: string,
      commitResult = true,
    ): Promise<ProviderAccount | null> => {
      setBusyKey(key);
      if (accountId) sessions?.supersede(accountId);
      try {
        const account = await operation();
        return commitResult ? replace(account) : account;
      } catch (error) {
        toast.show({ tone: "danger", title: failureTitle, description: toKalCodeError(error).message });
        return null;
      } finally {
        setBusyKey((current) => (current === key ? null : current));
      }
    },
    [replace, sessions, toast],
  );

  const create = useCallback(
    (providerId: string, displayName: string) =>
      run("create", "Account wasn't added", () => client.createProviderAccount(providerId, displayName)),
    [client, run],
  );
  const rename = useCallback(
    (accountId: string, displayName: string) =>
      run(
        `rename:${accountId}`,
        "Account name wasn't saved",
        () => client.renameProviderAccount(accountId, displayName),
        accountId,
      ),
    [client, run],
  );
  const setDefault = useCallback(
    (accountId: string) =>
      run(
        `default:${accountId}`,
        "Default account wasn't changed",
        () => client.setDefaultProviderAccount(accountId),
        accountId,
      ),
    [client, run],
  );
  const archive = useCallback(
    (accountId: string) =>
      run(`archive:${accountId}`, "Account wasn't removed", () => client.archiveProviderAccount(accountId), accountId),
    [client, run],
  );
  const refreshAuth = useCallback(
    async (account: ProviderAccount) => {
      if (!canRefreshProviderAuth(account.providerId)) return account;
      const providerId = account.providerId;
      return run(
        `refresh:${account.id}`,
        `${AUTH_PROVIDER_NAMES[providerId]} status couldn't be refreshed`,
        () => (sessions ? sessions.validate(account) : refreshProviderAuth(client, providerId, account.id)),
        undefined,
        sessions === null,
      );
    },
    [client, run, sessions],
  );
  const logoutAuth = useCallback(
    async (account: ProviderAccount) => {
      if (!isBrowserAuthProvider(account.providerId)) return null;
      const providerId = account.providerId;
      return run(
        `logout:${account.id}`,
        `${AUTH_PROVIDER_NAMES[providerId]} couldn't sign out`,
        () => authCommands(client, providerId).logout(account.id),
        account.id,
      );
    },
    [client, run],
  );

  const signInAuth = useCallback(
    async (account: ProviderAccount) => {
      if (!isBrowserAuthProvider(account.providerId)) return;
      const providerId = account.providerId;
      const commands = authCommands(client, providerId);
      const key = `login:${account.id}`;
      sessions?.supersede(account.id);
      setBusyKey(key);
      let handle: string | null = null;
      try {
        const started = await commands.start(account.id);
        handle = started.loginHandle;
        setActiveLogin({ accountId: account.id, handle, providerId });
        setBusyKey(null);
        replace(await commands.wait(handle));
      } catch (error) {
        if (handle === null || !cancelledLogins.current.delete(handle)) {
          const failure = toKalCodeError(error);
          toast.show({
            tone: "danger",
            title: signInFailureTitle(AUTH_PROVIDER_NAMES[providerId], failure.code),
            description: failure.message,
          });
        }
      } finally {
        setBusyKey((current) => (current === key ? null : current));
        setActiveLogin((current) => (current?.handle === handle ? null : current));
      }
    },
    [client, replace, sessions, toast],
  );

  const cancelLogin = useCallback(async () => {
    if (!activeLogin) return;
    cancelledLogins.current.add(activeLogin.handle);
    setBusyKey(`cancel:${activeLogin.accountId}`);
    try {
      await authCommands(client, activeLogin.providerId).cancel(activeLogin.handle);
      setActiveLogin(null);
    } catch (error) {
      cancelledLogins.current.delete(activeLogin.handle);
      toast.show({ tone: "danger", title: "Sign-in wasn't cancelled", description: toKalCodeError(error).message });
    } finally {
      setBusyKey(null);
    }
  }, [activeLogin, client, toast]);

  return {
    accounts: sessions?.accounts ?? localAccounts,
    loadError: sessions?.loadError ?? localLoadError,
    checking: sessions?.checking ?? new Set<string>(),
    validationErrors: sessions?.validationErrors ?? new Map<string, string>(),
    usage,
    usageError,
    usageRefreshing,
    usageStale: usage !== null && usageError !== null,
    busyKey,
    activeLogin,
    load,
    create,
    rename,
    setDefault,
    archive,
    refreshAuth,
    signInAuth,
    cancelLogin,
    logoutAuth,
  };
}
