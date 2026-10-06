/**
 * Deterministic provider-account test double for unit tests and the ui-test build only.
 * It models public metadata and opaque login handles; it never models or stores credentials.
 */
import type {
  IpcError,
  ModelInfo,
  ProviderAccount,
  ProviderAccountBinding,
  ProviderAccountBindingKind,
  ProviderAccountModel,
  ProviderAccountUsage,
  ProviderUsageWindow,
} from "@kalcode/protocol";
import type { DashboardHandlers } from "./dashboard.ts";

/** Mutable only in the ui-test runtime: tests supply discovery results, never a product model catalog. */
export const cursorModelFixture: ModelInfo[] = [];

const IDS = {
  claudePersonal: "0192f3c4-0000-7000-8000-000000000101",
  codexPersonal: "0192f3c4-0000-7000-8000-000000000201",
  codexWork: "0192f3c4-0000-7000-8000-000000000202",
  geminiPersonal: "0192f3c4-0000-7000-8000-000000000301",
} as const;

const PROVIDERS = new Set(["claude-code", "codex", "gemini-cli", "cursor"]);
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

const BINDING_KINDS: readonly ProviderAccountBindingKind[] = [
  "workspace",
  "agent",
  "mission",
  "thread",
  "provider_profile",
];

/** Like native: every kind decodes, but only workspace and thread bindings can be written. */
function bindingKind(value: unknown, anyKnown = false): ProviderAccountBindingKind {
  const kind = BINDING_KINDS.find((candidate) => candidate === value);
  if (!kind) fail("ipc_rejected", "KalCode couldn't complete that request.", "internal");
  if (!anyKnown && kind !== "workspace" && kind !== "thread") {
    fail(
      "provider_account_binding_kind_unsupported",
      "That account binding scope isn't available in this KalCode build.",
    );
  }
  return kind;
}

function seed(): ProviderAccount[] {
  return [
    account(IDS.claudePersonal, "claude-code", "Personal", "authenticated", true),
    account(IDS.codexPersonal, "codex", "Personal", "authenticated", true),
    account(IDS.codexWork, "codex", "Work", "not_authenticated", false),
    account(IDS.geminiPersonal, "gemini-cli", "Personal", "unknown", true),
    account("0192f3c4-0000-7000-8000-000000000401", "cursor", "Cursor", "authenticated", true),
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

const MINUTE = 60_000;

function usageWindow(id: string, remainingPercent: number, resetsInMinutes: number, now: number): ProviderUsageWindow {
  const label = id === "five_hour" ? "5-hour" : "Weekly";
  return { id, label, remainingPercent, resetsAt: new Date(now + resetsInMinutes * MINUTE).toISOString() };
}

/**
 * Realistic fixture usage, relative to now so reset countdowns read naturally in ui-test
 * screenshots. Seeded accounts: Claude "Personal" 64% 5-hour / 42% weekly; Codex "Personal"
 * 56% weekly; Codex "Work" signed out; Gemini unavailable. Accounts created during a test get a
 * second profile per provider: Claude at 91%, Codex at 8% (running low).
 */
function fixtureUsage(account: ProviderAccount, now: number): ProviderAccountUsage {
  const base = { accountId: account.id, plan: null, windows: [], checkedAt: null };
  if (account.providerId !== "claude-code" && account.providerId !== "codex") {
    return { ...base, status: "unavailable", reason: "This provider doesn't report plan usage" };
  }
  if (account.authenticationState === "not_authenticated") {
    return { ...base, status: "not_checked", reason: "Signed out" };
  }
  const checkedAt = new Date(now - 40_000).toISOString();
  const windows: ProviderUsageWindow[] =
    account.id === IDS.claudePersonal
      ? [usageWindow("weekly", 42, 3 * 1440 + 5 * 60, now), usageWindow("five_hour", 64, 2 * 60 + 14, now)]
      : account.id === IDS.codexPersonal
        ? [usageWindow("weekly", 56, 4 * 1440 + 9 * 60, now), usageWindow("five_hour", 88, 3 * 60 + 2, now)]
        : account.providerId === "claude-code"
          ? [usageWindow("five_hour", 91, 4 * 60 + 40, now), usageWindow("weekly", 96, 6 * 1440, now)]
          : [usageWindow("weekly", 8, 1440 + 6 * 60, now)];
  const plan = account.providerId === "claude-code" ? "Max 20x" : account.id === IDS.codexPersonal ? "Plus" : "Pro";
  return { ...base, status: "available", plan, windows, checkedAt, reason: null };
}

/** UI-test data only; production catalogs always come from the native provider adapter. */
function fixtureModels(account: ProviderAccount): ProviderAccountModel[] {
  if (account.providerId === "cursor") {
    return cursorModelFixture.map((model) => ({
      ...model,
      defaultEffort: null,
      supportedEfforts: [],
    }));
  }
  if (account.providerId === "codex") {
    return [
      {
        id: "codex-ui-test-exact",
        displayName: "Codex exact model",
        isDefault: true,
        defaultEffort: "high",
        supportedEfforts: ["low", "medium", "high", "xhigh"],
      },
    ];
  }
  if (account.providerId === "claude-code") {
    return [
      {
        id: "default",
        displayName: "Account default",
        isDefault: true,
        defaultEffort: null,
        supportedEfforts: ["low", "medium", "high", "xhigh", "max"],
      },
    ];
  }
  return [
    {
      id: "auto",
      displayName: "Auto (default)",
      isDefault: true,
      defaultEffort: null,
      supportedEfforts: [],
    },
  ];
}

export interface ProviderAccountsMemory {
  handlers: DashboardHandlers;
  /** Resolves active public metadata for the fixture thread runtime. */
  resolve(accountId: string, providerId: string): ProviderAccount;
  /** Deletes every binding scoped to a removed workspace (native `remove_workspace` does too). */
  forgetWorkspace(workspaceId: string): void;
}

export function createProviderAccountsMemory(requireCore: () => void, empty = false): ProviderAccountsMemory {
  let accounts = empty ? [] : seed();
  let nextAccount = 500;
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
    // Like native thread create and rebind: a removed (archived) account has its own code.
    if (accounts.some((candidate) => candidate.id === accountId(id) && candidate.archivedAt !== null)) {
      fail(
        "provider_account_archived",
        "That account was removed from KalCode. Reconnect it or choose an active account.",
      );
    }
    const selected = active(id);
    if (selected.providerId !== provider) {
      fail("provider_account_mismatch", "That account belongs to a different provider.");
    }
    return selected;
  };

  return {
    resolve,
    forgetWorkspace(workspaceId) {
      for (const [key, binding] of bindings) {
        if (binding.kind === "workspace" && binding.scopeId === workspaceId) bindings.delete(key);
      }
    },
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
          provider === "cursor" &&
          accounts.some((candidate) => candidate.providerId === "cursor" && candidate.archivedAt === null)
        ) {
          fail(
            "cursor_native_account_exists",
            "Cursor uses one native sign-in. Rename or reconnect the existing account.",
          );
        }
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
        // Like native: archiving removes every binding that selected the account.
        for (const [key, binding] of bindings) if (binding.accountId === current.id) bindings.delete(key);
        return archived;
      },
      provider_account_bind: (args) => {
        requireCore();
        const provider = providerId(args.providerId);
        const selected = resolve(String(args.accountId), provider);
        const binding: ProviderAccountBinding = {
          providerId: provider,
          kind: bindingKind(args.kind),
          scopeId: accountId(args.scopeId),
          accountId: selected.id,
        };
        bindings.set(`${provider}:${binding.kind}:${binding.scopeId}`, binding);
        return binding;
      },
      provider_account_unbind: (args) => {
        requireCore();
        const provider = providerId(args.providerId);
        return bindings.delete(`${provider}:${bindingKind(args.kind)}:${accountId(args.scopeId)}`);
      },
      provider_account_usage: (args) => {
        requireCore();
        const ids = Array.isArray(args.accountIds) ? new Set(args.accountIds.map(accountId)) : null;
        const now = Date.now();
        return accounts
          .filter((candidate) => candidate.archivedAt === null && (ids === null || ids.has(candidate.id)))
          .map((candidate) => fixtureUsage(candidate, now));
      },
      provider_account_models: (args) => {
        requireCore();
        const current = active(args.accountId);
        if (current.providerId === "codex" && current.authenticationState === "not_authenticated") {
          fail(
            "provider_account_not_authenticated",
            "Connect this Codex account before loading its available models.",
            "provider",
          );
        }
        return {
          accountId: current.id,
          providerId: current.providerId,
          models: fixtureModels(current),
        };
      },
      provider_account_bindings_list: (args) => {
        requireCore();
        const provider = args.providerId == null ? null : providerId(args.providerId);
        const kind = args.kind == null ? null : bindingKind(args.kind, true);
        const scope = args.scopeId == null ? null : accountId(args.scopeId);
        const order = (binding: ProviderAccountBinding) => `${binding.providerId}\0${binding.kind}\0${binding.scopeId}`;
        return [...bindings.values()]
          .filter(
            (binding) =>
              (provider === null || binding.providerId === provider) &&
              (kind === null || binding.kind === kind) &&
              (scope === null || binding.scopeId === scope) &&
              accounts.some((candidate) => candidate.id === binding.accountId && candidate.archivedAt === null),
          )
          .sort((a, b) => (order(a) < order(b) ? -1 : order(a) > order(b) ? 1 : 0));
      },
      provider_cursor_account_refresh: (args) => {
        requireCore();
        const current = active(args.accountId);
        if (current.providerId !== "cursor")
          fail("provider_account_mismatch", "That account belongs to a different provider.");
        return {
          account: current,
          models: cursorModelFixture,
          modelsError: cursorModelFixture.length ? null : "No model discovery fixture configured",
        };
      },
      provider_cursor_login: (args) => {
        requireCore();
        const current = active(args.accountId);
        if (current.providerId !== "cursor")
          fail("provider_account_mismatch", "That account belongs to a different provider.");
        return {
          account: replace({
            ...current,
            authenticationState: "authenticated",
            lastErrorCode: null,
            lastCheckedAt: new Date().toISOString(),
          }),
          models: [],
          modelsError: null,
        };
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
