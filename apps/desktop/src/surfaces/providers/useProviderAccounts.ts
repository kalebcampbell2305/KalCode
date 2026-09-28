import type { ProviderAccount } from "@kalcode/protocol";
import { useToast } from "@kalcode/ui/components";
import { useCallback, useEffect, useRef, useState } from "react";
import type { KalCodeClient } from "../../ipc/client.ts";
import { toKalCodeError } from "../../ipc/errors.ts";
import { useRuntime } from "../../runtime/RuntimeProvider.tsx";
import { signInFailureTitle } from "./providerLabels.ts";

/** Providers whose own official sign-in KalCode runs natively for one managed account. */
export type BrowserAuthProvider = "claude-code" | "codex" | "gemini-cli";

export function isBrowserAuthProvider(providerId: string): providerId is BrowserAuthProvider {
  return providerId === "claude-code" || providerId === "codex" || providerId === "gemini-cli";
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
        refresh: (id: string) => client.refreshCodexAccount(id),
        start: (id: string) => client.startCodexLogin(id),
        wait: (handle: string) => client.waitForCodexLogin(handle),
        cancel: (handle: string) => client.cancelCodexLogin(handle),
        logout: (id: string) => client.logoutCodexAccount(id),
      };
    case "claude-code":
      return {
        refresh: (id: string) => client.refreshClaudeAccount(id),
        start: (id: string) => client.startClaudeLogin(id),
        wait: (handle: string) => client.waitForClaudeLogin(handle),
        cancel: (handle: string) => client.cancelClaudeLogin(handle),
        logout: (id: string) => client.logoutClaudeAccount(id),
      };
    case "gemini-cli":
      return {
        refresh: (id: string) => client.refreshGeminiAccount(id),
        start: (id: string) => client.startGeminiLogin(id),
        wait: (handle: string) => client.waitForGeminiLogin(handle),
        cancel: (handle: string) => client.cancelGeminiLogin(handle),
        logout: (id: string) => client.logoutGeminiAccount(id),
      };
  }
}

interface ActiveLogin {
  accountId: string;
  handle: string;
  providerId: BrowserAuthProvider;
}

export function useProviderAccounts(enabled: boolean) {
  const { client } = useRuntime();
  const toast = useToast();
  const [accounts, setAccounts] = useState<ProviderAccount[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
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

  const load = useCallback(async () => {
    if (!enabled) return;
    setLoadError(null);
    try {
      setAccounts(await client.listProviderAccounts());
    } catch (error) {
      setLoadError(toKalCodeError(error).message);
    }
  }, [client, enabled]);

  useEffect(() => {
    void load();
  }, [load]);

  const replace = useCallback((account: ProviderAccount) => {
    setAccounts((current) => {
      if (!current) return [account];
      const next = current.map((candidate) => {
        if (candidate.id === account.id) return account;
        if (account.isDefault && candidate.providerId === account.providerId) return { ...candidate, isDefault: false };
        return candidate;
      });
      if (!next.some((candidate) => candidate.id === account.id)) next.push(account);
      return next.filter((candidate) => candidate.archivedAt === null);
    });
    return account;
  }, []);

  const run = useCallback(
    async (
      key: string,
      failureTitle: string,
      operation: () => Promise<ProviderAccount>,
    ): Promise<ProviderAccount | null> => {
      setBusyKey(key);
      try {
        return replace(await operation());
      } catch (error) {
        toast.show({ tone: "danger", title: failureTitle, description: toKalCodeError(error).message });
        return null;
      } finally {
        setBusyKey((current) => (current === key ? null : current));
      }
    },
    [replace, toast],
  );

  const create = useCallback(
    (providerId: string, displayName: string) =>
      run("create", "Account wasn't added", () => client.createProviderAccount(providerId, displayName)),
    [client, run],
  );
  const rename = useCallback(
    (accountId: string, displayName: string) =>
      run(`rename:${accountId}`, "Account name wasn't saved", () =>
        client.renameProviderAccount(accountId, displayName),
      ),
    [client, run],
  );
  const setDefault = useCallback(
    (accountId: string) =>
      run(`default:${accountId}`, "Default account wasn't changed", () => client.setDefaultProviderAccount(accountId)),
    [client, run],
  );
  const archive = useCallback(
    (accountId: string) =>
      run(`archive:${accountId}`, "Account wasn't removed", () => client.archiveProviderAccount(accountId)),
    [client, run],
  );
  const refreshAuth = useCallback(
    async (account: ProviderAccount) => {
      if (!isBrowserAuthProvider(account.providerId)) return null;
      const providerId = account.providerId;
      return run(`refresh:${account.id}`, `${AUTH_PROVIDER_NAMES[providerId]} status couldn't be refreshed`, () =>
        authCommands(client, providerId).refresh(account.id),
      );
    },
    [client, run],
  );
  const logoutAuth = useCallback(
    async (account: ProviderAccount) => {
      if (!isBrowserAuthProvider(account.providerId)) return null;
      const providerId = account.providerId;
      return run(`logout:${account.id}`, `${AUTH_PROVIDER_NAMES[providerId]} couldn't sign out`, () =>
        authCommands(client, providerId).logout(account.id),
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
    [client, replace, toast],
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
    accounts,
    loadError,
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
