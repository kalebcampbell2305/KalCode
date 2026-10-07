import type { ModelInfo, ModelSource, ProviderAccount, ProviderAccountBinding } from "@kalcode/protocol";
import type { PaneProviderId } from "./paneChannel.ts";

/**
 * Launching coding agents from Code's + (owner rule, AGENTS.md): an agent is a real Claude Code,
 * Codex or Gemini CLI session in a terminal pane, so "six Claude Code agents" is six panes.
 */

export type ModelEffortInfo = ModelInfo & {
  defaultEffort?: string | null;
  supportedEfforts?: readonly string[];
};

export interface ModelCatalogEvidence {
  source?: ModelSource;
  status?: "checking" | "available" | "stale" | "unavailable";
}

/** Only a fresh runtime account catalog may disprove a saved exact model or effort. */
export function modelCatalogCanVerifyCapabilities(
  catalog: ModelCatalogEvidence,
  legacyCatalogWithoutEvidence = false,
): boolean {
  if (catalog.source === "runtime" && catalog.status === "available") return true;
  return legacyCatalogWithoutEvidence && catalog.source === undefined && catalog.status === undefined;
}

/** Account-reported model effort support wins, then adapter-owned account catalog metadata. */
export function effortsForModel(
  _providerId: PaneProviderId,
  model: ModelEffortInfo | null,
  catalogEfforts?: readonly string[],
): readonly string[] {
  if (model?.supportedEfforts !== undefined) return model.supportedEfforts;
  return catalogEfforts ?? [];
}

/** Keeps an exact supported choice, otherwise uses the account model's reported default when present. */
export function effortForModel(
  providerId: PaneProviderId,
  model: ModelEffortInfo | null,
  current: string | null | undefined,
  catalogEfforts?: readonly string[],
): string {
  const efforts = effortsForModel(providerId, model, catalogEfforts);
  if (current === "") return "";
  if (current && efforts.includes(current)) return current;
  return model?.defaultEffort && efforts.includes(model.defaultEffort) ? model.defaultEffort : "";
}

/** The most agents one launch starts; plan limits are enforced natively on top of this. */
export const MAX_AGENTS_PER_LAUNCH = 10;

export function clampAgentCount(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.min(MAX_AGENTS_PER_LAUNCH, Math.max(1, Math.round(value)));
}

/** Accounts an agent can start with: this provider's, not removed from KalCode. */
export function launchAccounts(accounts: readonly ProviderAccount[], providerId: string): ProviderAccount[] {
  return accounts.filter((account) => account.providerId === providerId && account.archivedAt === null);
}

/**
 * The account a new agent starts with, in the order the runtime resolves one: the workspace's
 * remembered account, then the provider default, then the only signed-in account. Empty when
 * the person has to choose (or there is none, and native says what to add).
 */
export function preselectLaunchAccount(
  accounts: readonly ProviderAccount[],
  bindings: readonly ProviderAccountBinding[],
  providerId: string,
  workspaceId: string,
): string {
  const candidates = launchAccounts(accounts, providerId);
  const bound = bindings.find(
    (b) => b.kind === "workspace" && b.providerId === providerId && b.scopeId === workspaceId,
  );
  if (bound && candidates.some((account) => account.id === bound.accountId)) return bound.accountId;
  const preferred = candidates.find((account) => account.isDefault);
  if (preferred) return preferred.id;
  const signedIn = candidates.filter((account) => account.authenticationState !== "not_authenticated");
  return signedIn.length === 1 ? (signedIn[0]?.id ?? "") : (candidates[0]?.id ?? "");
}

/** "Launch agent", "Launch 6 Claude Code agents". */
export function launchLabel(count: number, providerName: string): string {
  return count === 1 ? `Launch ${providerName} agent` : `Launch ${count} ${providerName} agents`;
}

const EFFORT_LABELS: Record<string, string> = {
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
};

/** "High", "Extra high"… for a provider-native effort id. */
export function effortLabel(effort: string): string {
  return EFFORT_LABELS[effort] ?? (effort ? effort[0]?.toUpperCase() + effort.slice(1) : "Default");
}

/**
 * The last launch per provider, remembered across restarts so the launcher never asks twice
 * (owner simplicity rule). Local preference only: the workspace's native account binding stays
 * the authority whenever it changed after this launch (Account Center "use for new agents").
 */
export interface RememberedLaunch {
  providerId: PaneProviderId;
  accountId: string;
  /** Exact provider model id, or null for the provider/account default. */
  model: string | null;
  /** The model's display name when launched, so the launcher can name it before options load. */
  modelName: string | null;
  effort: string | null;
  count: number;
  workspaceId: string;
  /** The workspace's bound account for this provider when this launch happened. */
  boundAccountId: string | null;
  at: string;
}

export interface LaunchMemory {
  /** The most recent launch of any provider (the launcher's RECENT row). */
  last: RememberedLaunch | null;
  /** Compatibility index for older consumers. New preference reads use `byContext`. */
  byProvider: Partial<Record<PaneProviderId, RememberedLaunch>>;
  /** Exact project + provider + account preferences, so one context never changes another. */
  byContext: Record<string, RememberedLaunch>;
}

export const LAUNCH_MEMORY_KEY = "kalcode.agentLauncher.v1";
const EMPTY_MEMORY: LaunchMemory = { last: null, byProvider: {}, byContext: {} };
const PROVIDER_IDS: readonly string[] = ["claude-code", "codex", "cursor", "gemini-cli"];

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

function text(value: unknown, maxLength = 400): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength ? value : null;
}

function parseLaunch(value: unknown): RememberedLaunch | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const providerId = text(v.providerId);
  const accountId = text(v.accountId);
  const workspaceId = text(v.workspaceId);
  if (!providerId || !PROVIDER_IDS.includes(providerId) || !accountId || !workspaceId) return null;
  return {
    providerId: providerId as PaneProviderId,
    accountId,
    // Provider model ids are accepted up to 512 bytes at launch. Keep enough UTF-16 room to
    // round-trip that full bounded native value; the provider remains the launch validator.
    model: text(v.model, 1024),
    modelName: text(v.modelName, 1024),
    effort: text(v.effort),
    count: clampAgentCount(typeof v.count === "number" ? v.count : 1),
    workspaceId,
    boundAccountId: text(v.boundAccountId),
    at: text(v.at) ?? "",
  };
}

function launchContextKey(entry: Pick<RememberedLaunch, "workspaceId" | "providerId" | "accountId">): string {
  return JSON.stringify([entry.workspaceId, entry.providerId, entry.accountId]);
}

/** The most recent exact preference for this project/provider, optionally narrowed to one account. */
export function rememberedLaunch(
  memory: LaunchMemory,
  workspaceId: string,
  providerId: PaneProviderId,
  accountId?: string,
): RememberedLaunch | null {
  let newest: RememberedLaunch | null = null;
  for (const entry of Object.values(memory.byContext)) {
    if (
      entry.workspaceId !== workspaceId ||
      entry.providerId !== providerId ||
      (accountId !== undefined && entry.accountId !== accountId)
    )
      continue;
    if (!newest || entry.at >= newest.at) newest = entry;
  }
  if (newest) return newest;
  // v1 originally persisted only this provider index. It is safe solely for the exact context
  // recorded inside the entry; never let it bleed into another project or account.
  const legacy = memory.byProvider[providerId];
  return legacy?.workspaceId === workspaceId && (accountId === undefined || legacy.accountId === accountId)
    ? legacy
    : null;
}

/** Never throws: unreadable or malformed memory is simply empty. */
export function readLaunchMemory(store: Storage | null = storage()): LaunchMemory {
  try {
    const raw = store?.getItem(LAUNCH_MEMORY_KEY);
    if (!raw) return EMPTY_MEMORY;
    const parsed = JSON.parse(raw) as {
      last?: unknown;
      byProvider?: Record<string, unknown>;
      byContext?: Record<string, unknown>;
    };
    const byProvider: LaunchMemory["byProvider"] = {};
    const byContext: LaunchMemory["byContext"] = {};
    for (const value of Object.values(parsed.byContext ?? {})) {
      const entry = parseLaunch(value);
      if (entry) byContext[launchContextKey(entry)] = entry;
    }
    for (const id of PROVIDER_IDS) {
      const entry = parseLaunch(parsed.byProvider?.[id]);
      if (entry && entry.providerId === id) {
        byProvider[id as PaneProviderId] = entry;
        byContext[launchContextKey(entry)] ??= entry;
      }
    }
    const last = parseLaunch(parsed.last);
    if (last) byContext[launchContextKey(last)] ??= last;
    return { last, byProvider, byContext };
  } catch {
    return EMPTY_MEMORY;
  }
}

/** Records a launch that actually started. Best effort: a full or blocked store changes nothing. */
export function rememberLaunch(entry: RememberedLaunch, store: Storage | null = storage()): LaunchMemory {
  const current = readLaunchMemory(store);
  const next: LaunchMemory = {
    last: entry,
    byProvider: { ...current.byProvider, [entry.providerId]: entry },
    byContext: { ...current.byContext, [launchContextKey(entry)]: entry },
  };
  try {
    store?.setItem(LAUNCH_MEMORY_KEY, JSON.stringify(next));
  } catch {
    // Not remembered; the launch itself already happened.
  }
  return next;
}

/** The workspace's bound account for a provider, when it is still a launchable account. */
export function boundLaunchAccount(
  accounts: readonly ProviderAccount[],
  bindings: readonly ProviderAccountBinding[] | null,
  providerId: string,
  workspaceId: string,
): string | null {
  const bound = bindings?.find(
    (b) => b.kind === "workspace" && b.providerId === providerId && b.scopeId === workspaceId,
  );
  return bound && launchAccounts(accounts, providerId).some((a) => a.id === bound.accountId) ? bound.accountId : null;
}

/**
 * The account the launcher highlights for a provider: the last one launched, unless this
 * workspace's native binding changed since that launch (an explicit Account Center choice wins),
 * then the runtime's own order (binding, default, sole signed-in account).
 */
export function resolveLaunchAccount(
  accounts: readonly ProviderAccount[],
  bindings: readonly ProviderAccountBinding[] | null,
  providerId: string,
  workspaceId: string,
  remembered: RememberedLaunch | null | undefined,
): string {
  const bound = boundLaunchAccount(accounts, bindings, providerId, workspaceId);
  if (remembered) {
    const known = launchAccounts(accounts, providerId).some((a) => a.id === remembered.accountId);
    // A changed Account Center binding is a newer explicit choice, including when the old
    // account was removed. Otherwise an unavailable remembered account must stay unresolved:
    // falling through to a default or sole account would cross account identity boundaries.
    if (bound && (remembered.workspaceId !== workspaceId || remembered.boundAccountId !== bound)) return bound;
    return known ? remembered.accountId : "";
  }
  return preselectLaunchAccount(accounts, bindings ?? [], providerId, workspaceId);
}

/**
 * Accounts that are the same provider sign-in as an earlier account (same provider-reported
 * identity), mapped to that earlier account's name: "Same sign-in as KalCode". Order is the
 * stable account order, so the first account keeps its plain identity.
 */
export function sameSignIns(
  accounts: readonly Pick<ProviderAccount, "id" | "providerId" | "displayName" | "providerReportedIdentity">[],
): Map<string, string> {
  const first = new Map<string, string>();
  const same = new Map<string, string>();
  for (const account of accounts) {
    const identity = account.providerReportedIdentity?.trim().toLowerCase();
    if (!identity) continue;
    const key = `${account.providerId}\u0000${identity}`;
    const owner = first.get(key);
    if (owner === undefined) first.set(key, account.displayName.trim() || "Unnamed account");
    else same.set(account.id, owner);
  }
  return same;
}
