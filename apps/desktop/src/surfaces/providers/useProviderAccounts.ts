import type { ProviderAccount } from "@kalcode/protocol";
import { useToast } from "@kalcode/ui/components";
import { useCallback, useEffect, useRef, useState } from "react";
import { toKalCodeError } from "../../ipc/errors.ts";
import { useRuntime } from "../../runtime/RuntimeProvider.tsx";
import { useUiIntents } from "../../runtime/uiIntents.tsx";
import { PaneChannel } from "../code/panes/paneChannel.ts";

type BrowserAuthProvider = "claude-code" | "codex";

interface ActiveLogin {
  accountId: string;
  handle: string;
  providerId: BrowserAuthProvider;
}

export function useProviderAccounts(enabled: boolean) {
  const { client } = useRuntime();
  const intents = useUiIntents();
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
        const cancel =
          login.providerId === "codex" ? client.cancelCodexLogin(login.handle) : client.cancelClaudeLogin(login.handle);
        void cancel.catch(() => undefined);
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
    (account: ProviderAccount) =>
      run(
        `refresh:${account.id}`,
        `${account.providerId === "codex" ? "Codex" : "Claude Code"} status couldn't be refreshed`,
        () =>
          account.providerId === "codex"
            ? client.refreshCodexAccount(account.id)
            : client.refreshClaudeAccount(account.id),
      ),
    [client, run],
  );
  const logoutAuth = useCallback(
    (account: ProviderAccount) =>
      run(
        `logout:${account.id}`,
        `${account.providerId === "codex" ? "Codex" : "Claude Code"} couldn't sign out`,
        () =>
          account.providerId === "codex"
            ? client.logoutCodexAccount(account.id)
            : client.logoutClaudeAccount(account.id),
      ),
    [client, run],
  );

  const signInAuth = useCallback(
    async (account: ProviderAccount) => {
      if (account.providerId !== "codex" && account.providerId !== "claude-code") return;
      const providerId = account.providerId;
      const key = `login:${account.id}`;
      setBusyKey(key);
      let handle: string | null = null;
      try {
        const started =
          providerId === "codex" ? await client.startCodexLogin(account.id) : await client.startClaudeLogin(account.id);
        handle = started.loginHandle;
        setActiveLogin({ accountId: account.id, handle, providerId });
        setBusyKey(null);
        replace(await (providerId === "codex" ? client.waitForCodexLogin(handle) : client.waitForClaudeLogin(handle)));
      } catch (error) {
        if (handle === null || !cancelledLogins.current.delete(handle)) {
          toast.show({
            tone: "danger",
            title: `${providerId === "codex" ? "Codex" : "Claude Code"} sign-in didn't finish`,
            description: toKalCodeError(error).message,
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
      if (activeLogin.providerId === "codex") await client.cancelCodexLogin(activeLogin.handle);
      else await client.cancelClaudeLogin(activeLogin.handle);
      setActiveLogin(null);
    } catch (error) {
      cancelledLogins.current.delete(activeLogin.handle);
      toast.show({ tone: "danger", title: "Sign-in wasn't cancelled", description: toKalCodeError(error).message });
    } finally {
      setBusyKey(null);
    }
  }, [activeLogin, client, toast]);

  const openGeminiAuth = useCallback(
    async (account: ProviderAccount) => {
      const key = `gemini-auth:${account.id}`;
      setBusyKey(key);
      try {
        const workspace = await client.activeWorkspace();
        if (!workspace) {
          toast.show({
            tone: "info",
            title: "Open a workspace first",
            description: "Gemini sign-in runs inside a managed Gemini CLI pane in the active workspace.",
          });
          return;
        }
        const channel = new PaneChannel(client);
        const thread = await channel.create({
          providerId: "gemini-cli",
          providerAccountId: account.id,
          workspaceId: workspace.id,
          permissionMode: "approve",
          name: "Gemini sign-in",
        });
        await channel.write(thread.id, "/auth\r");
        await intents.focus({ kind: "thread", threadId: thread.id, workspaceId: workspace.id });
      } catch (error) {
        toast.show({
          tone: "danger",
          title: "Gemini sign-in pane couldn't open",
          description: toKalCodeError(error).message,
        });
      } finally {
        setBusyKey((current) => (current === key ? null : current));
      }
    },
    [client, intents, toast],
  );

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
    openGeminiAuth,
  };
}
