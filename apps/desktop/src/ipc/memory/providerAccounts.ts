/**
 * Deterministic provider-account test double for unit tests and the ui-test build only.
 * It models public metadata and opaque login handles; it never models or stores credentials.
 */
import type { IpcError, ProviderAccount, ProviderAccountBinding, ProviderAccountBindingKind } from "@kalcode/protocol";
import type { DashboardHandlers } from "./dashboard.ts";

const IDS = {
  claudePersonal: "0192f3c4-0000-7000-8000-000000000101",
  codexPersonal: "0192f3c4-0000-7000-8000-000000000201",
  codexWork: "0192f3c4-0000-7000-8000-000000000202",
  geminiPersonal: "0192f3c4-0000-7000-8000-000000000301",
} as const;

const PROVIDERS = new Set(["claude-code", "codex", "gemini-cli"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PROVIDER_ID = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const CREATED_AT = "2026-09-24T12:00:00.000Z";

function fail(code: string, message: string, category: IpcError["category"] = "validation"): never {
  throw { category, code, message, retryable: false } satisfies IpcError;
}

function label(value: unknown): string {
  const next = typeof value === "string" ? value.trim() : "";
  const hasControlCharacter = [...next].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f;
  });
  if (!next || [...next].length > 80 || hasControlCharacter) {
    fail("provider_account_label_invalid", "Account labels must be between 1 and 80 visible characters.");
  }
  return next;
}

function providerId(value: unknown): string {
  const next = typeof value === "string" ? value : "";
  if (!PROVIDER_ID.test(next) || !PROVIDERS.has(next)) {
    fail("provider_account_provider_invalid", "That provider doesn't support account metadata.");
  }
  return next;
}

function accountId(value: unknown): string {
  const next = typeof value === "string" ? value : "";
  if (!UUID.test(next)) fail("provider_account_id_invalid", "That account or binding id isn't valid.");
  return next;
}

function seed(): ProviderAccount[] {
  return [
    account(IDS.claudePersonal, "claude-code", "Personal", "authenticated", true),
    account(IDS.codexPersonal, "codex", "Personal", "authenticated", true),
    account(IDS.codexWork, "codex", "Work", "not_authenticated", false),
    account(IDS.geminiPersonal, "gemini-cli", "Personal", "unknown", true),
  ];
}

function account(
  id: string,
  providerId: string,
  displayName: string,
  authenticationState: ProviderAccount["authenticationState"],
  isDefault: boolean,
): ProviderAccount {
  return {
    id,
    providerId,
    displayName,
    providerReportedIdentity: null,
    authenticationState,
    isDefault,
    createdAt: CREATED_AT,
    lastUsedAt: null,
    lastCheckedAt: null,
    lastErrorCode: null,
    archivedAt: null,
  };
}

export interface ProviderAccountsMemory {
  handlers: DashboardHandlers;
  /** Resolves active public metadata for the fixture thread runtime. */
  resolve(accountId: string, providerId: string): ProviderAccount;
}

export function createProviderAccountsMemory(requireCore: () => void, empty = false): ProviderAccountsMemory {
  let accounts = empty ? [] : seed();
  let nextAccount = 400;
  let nextLogin = 1;
  const logins = new Map<string, { accountId: string; cancelled: boolean }>();
  const bindings = new Map<string, ProviderAccountBinding>();

  const active = (id: unknown): ProviderAccount => {
    const safeId = accountId(id);
    const found = accounts.find((candidate) => candidate.id === safeId && candidate.archivedAt === null);
    if (!found) fail("provider_account_not_found", "That provider account isn't connected.");
    return found;
  };
  const replace = (next: ProviderAccount) => {
    accounts = accounts.map((candidate) => (candidate.id === next.id ? next : candidate));
    return next;
  };
  const ensureCodex = (id: unknown): ProviderAccount => {
    const found = active(id);
    if (found.providerId !== "codex") {
      fail("provider_account_mismatch", "That account belongs to a different provider.");
    }
    return found;
  };
  const ensureClaude = (id: unknown): ProviderAccount => {
    const found = active(id);
    if (found.providerId !== "claude-code") {
      fail("provider_account_mismatch", "That account belongs to a different provider.");
    }
    return found;
  };
  const ensureGemini = (id: unknown): ProviderAccount => {
    const found = active(id);
    if (found.providerId !== "gemini-cli") {
      fail("provider_account_mismatch", "That account belongs to a different provider.");
    }
    return found;
  };

  const resolve = (id: string, provider: string): ProviderAccount => {
    const selected = active(id);
    if (selected.providerId !== provider) {
      fail("provider_account_mismatch", "That account belongs to a different provider.");
    }
    return selected;
  };

  return {
    resolve,
    handlers: {
      provider_accounts_list: (args) => {
        requireCore();
        const filter = args.providerId == null ? null : providerId(args.providerId);
        return accounts
          .filter((candidate) => candidate.archivedAt === null && (filter === null || candidate.providerId === filter))
          .sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.displayName.localeCompare(b.displayName));
      },
      provider_account_create: (args) => {
        requireCore();
        const provider = providerId(args.providerId);
        const displayName = label(args.displayName);
        if (
          accounts.some(
            (candidate) =>
              candidate.archivedAt === null &&
              candidate.providerId === provider &&
              candidate.displayName.localeCompare(displayName, undefined, { sensitivity: "accent" }) === 0,
          )
        ) {
          fail("provider_account_label_exists", "That provider already has an account with this label.");
        }
        const isDefault = !accounts.some(
          (candidate) => candidate.archivedAt === null && candidate.providerId === provider && candidate.isDefault,
        );
        const suffix = String(nextAccount++).padStart(12, "0");
        const created = account(`0192f3c4-0000-7000-8000-${suffix}`, provider, displayName, "unknown", isDefault);
        accounts = [...accounts, created];
        return created;
      },
      provider_account_rename: (args) => {
        requireCore();
        const current = active(args.accountId);
        const displayName = label(args.displayName);
        if (
          accounts.some(
            (candidate) =>
              candidate.id !== current.id &&
              candidate.archivedAt === null &&
              candidate.providerId === current.providerId &&
              candidate.displayName.localeCompare(displayName, undefined, { sensitivity: "accent" }) === 0,
          )
        ) {
          fail("provider_account_label_exists", "That provider already has an account with this label.");
        }
        return replace({ ...current, displayName });
      },
      provider_account_set_default: (args) => {
        requireCore();
        const current = active(args.accountId);
        accounts = accounts.map((candidate) =>
          candidate.providerId === current.providerId && candidate.archivedAt === null
            ? { ...candidate, isDefault: candidate.id === current.id }
            : candidate,
        );
        return active(current.id);
      },
      provider_account_archive: (args) => {
        requireCore();
        const current = active(args.accountId);
        const archived = replace({ ...current, isDefault: false, archivedAt: new Date().toISOString() });
        const survivor = accounts.find(
          (candidate) => candidate.providerId === current.providerId && candidate.archivedAt === null,
        );
        if (current.isDefault && survivor) replace({ ...survivor, isDefault: true });
        return archived;
      },
      provider_account_bind: (args) => {
        requireCore();
        const provider = providerId(args.providerId);
        const selected = resolve(String(args.accountId), provider);
        const binding: ProviderAccountBinding = {
          providerId: provider,
          kind: args.kind as ProviderAccountBindingKind,
          scopeId: String(args.scopeId),
          accountId: selected.id,
        };
        bindings.set(`${provider}:${binding.kind}:${binding.scopeId}`, binding);
        return binding;
      },
      provider_account_unbind: (args) => {
        requireCore();
        const provider = providerId(args.providerId);
        return bindings.delete(`${provider}:${String(args.kind)}:${String(args.scopeId)}`);
      },
      provider_codex_account_refresh: (args) => {
        requireCore();
        const current = ensureCodex(args.accountId);
        return replace({ ...current, lastCheckedAt: new Date().toISOString(), lastErrorCode: null });
      },
      provider_codex_login_start: (args) => {
        requireCore();
        const current = ensureCodex(args.accountId);
        if ([...logins.values()].some((login) => login.accountId === current.id && !login.cancelled)) {
          fail("provider_account_busy", "That account already has a sign-in in progress.", "provider");
        }
        const loginHandle = `login-${nextLogin++}`;
        logins.set(loginHandle, { accountId: current.id, cancelled: false });
        return { loginHandle };
      },
      provider_codex_login_wait: (args) => {
        requireCore();
        const handle = typeof args.loginHandle === "string" ? args.loginHandle : "";
        const login = logins.get(handle);
        if (!login || login.cancelled) fail("provider_login_unknown", "That sign-in is no longer active.", "provider");
        logins.delete(handle);
        const current = ensureCodex(login.accountId);
        return replace({
          ...current,
          authenticationState: "authenticated",
          lastCheckedAt: new Date().toISOString(),
          lastErrorCode: null,
        });
      },
      provider_codex_login_cancel: (args) => {
        requireCore();
        const handle = typeof args.loginHandle === "string" ? args.loginHandle : "";
        const login = logins.get(handle);
        if (!login) fail("provider_login_unknown", "That sign-in is no longer active.", "provider");
        logins.set(handle, { ...login, cancelled: true });
      },
      provider_codex_logout: (args) => {
        requireCore();
        const current = ensureCodex(args.accountId);
        return replace({
          ...current,
          authenticationState: "not_authenticated",
          providerReportedIdentity: null,
          lastCheckedAt: new Date().toISOString(),
          lastErrorCode: null,
        });
      },
      provider_claude_account_refresh: (args) => {
        requireCore();
        const current = ensureClaude(args.accountId);
        return replace({ ...current, lastCheckedAt: new Date().toISOString(), lastErrorCode: null });
      },
      provider_claude_login_start: (args) => {
        requireCore();
        const current = ensureClaude(args.accountId);
        if ([...logins.values()].some((login) => login.accountId === current.id && !login.cancelled)) {
          fail("provider_account_busy", "That account already has a sign-in in progress.", "provider");
        }
        const loginHandle = `login-${nextLogin++}`;
        logins.set(loginHandle, { accountId: current.id, cancelled: false });
        return { loginHandle };
      },
      provider_claude_login_wait: (args) => {
        requireCore();
        const handle = typeof args.loginHandle === "string" ? args.loginHandle : "";
        const login = logins.get(handle);
        if (!login || login.cancelled) fail("provider_login_unknown", "That sign-in is no longer active.", "provider");
        logins.delete(handle);
        const current = ensureClaude(login.accountId);
        return replace({
          ...current,
          authenticationState: "authenticated",
          lastCheckedAt: new Date().toISOString(),
          lastErrorCode: null,
        });
      },
      provider_claude_login_cancel: (args) => {
        requireCore();
        const handle = typeof args.loginHandle === "string" ? args.loginHandle : "";
        const login = logins.get(handle);
        if (!login) fail("provider_login_unknown", "That sign-in is no longer active.", "provider");
        logins.set(handle, { ...login, cancelled: true });
      },
      provider_claude_logout: (args) => {
        requireCore();
        const current = ensureClaude(args.accountId);
        return replace({
          ...current,
          authenticationState: "not_authenticated",
          providerReportedIdentity: null,
          lastCheckedAt: new Date().toISOString(),
          lastErrorCode: null,
        });
      },
      provider_gemini_account_refresh: (args) => {
        requireCore();
        const current = ensureGemini(args.accountId);
        return replace({
          ...current,
          authenticationState: current.authenticationState === "authenticated" ? "authenticated" : "not_authenticated",
          lastCheckedAt: new Date().toISOString(),
          lastErrorCode: null,
        });
      },
      provider_gemini_login_start: (args) => {
        requireCore();
        const current = ensureGemini(args.accountId);
        if (current.authenticationState === "authenticated") {
          fail("provider_account_already_connected", "This managed Gemini account is already signed in.", "provider");
        }
        if ([...logins.values()].some((login) => login.accountId === current.id && !login.cancelled)) {
          fail("provider_account_busy", "That account already has a sign-in in progress.", "provider");
        }
        const loginHandle = `login-${nextLogin++}`;
        logins.set(loginHandle, { accountId: current.id, cancelled: false });
        return { loginHandle };
      },
      provider_gemini_login_wait: (args) => {
        requireCore();
        const handle = typeof args.loginHandle === "string" ? args.loginHandle : "";
        const login = logins.get(handle);
        if (!login || login.cancelled)
          fail("provider_login_unknown", "That Gemini sign-in is no longer active.", "provider");
        logins.delete(handle);
        const current = ensureGemini(login.accountId);
        return replace({
          ...current,
          authenticationState: "authenticated",
          lastCheckedAt: new Date().toISOString(),
          lastErrorCode: null,
        });
      },
      provider_gemini_login_cancel: (args) => {
        requireCore();
        const handle = typeof args.loginHandle === "string" ? args.loginHandle : "";
        const login = logins.get(handle);
        if (!login) fail("provider_login_unknown", "That Gemini sign-in is no longer active.", "provider");
        logins.set(handle, { ...login, cancelled: true });
      },
      provider_gemini_logout: (args) => {
        requireCore();
        const current = ensureGemini(args.accountId);
        return replace({
          ...current,
          authenticationState: "not_authenticated",
          providerReportedIdentity: null,
          lastCheckedAt: new Date().toISOString(),
          lastErrorCode: null,
        });
      },
    },
  };
}
