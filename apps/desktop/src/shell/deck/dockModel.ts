/**
 * The Provider Dock's model: one chip per connected Claude/Codex/Gemini account with what KalCode
 * actually knows about it (sign-in, last error, the threads it carries) and which accounts can take
 * a given thread. Compatibility mirrors the native rebind rules (`rebind_target`): same provider,
 * not removed, not signed out, and a thread that is quiet. Nothing here switches an account.
 */
import type { ProviderAccount, ThreadSummary } from "@kalcode/protocol";
import { accountHealth, accountName, sortAccounts } from "../../surfaces/providers/accountIdentity.ts";
import { isWaitingForResources, presentStatus } from "../../surfaces/threads/model.ts";
import { rebindBlocker } from "../../surfaces/threads/useThreadAccount.ts";

/** Dock order: Claude, then Codex, then Gemini, then anything newer by id. */
const PROVIDER_RANK: Record<string, number> = { "claude-code": 0, codex: 1, "gemini-cli": 2 };

const SHORT_PROVIDER: Record<string, string> = { "claude-code": "Claude", codex: "Codex", "gemini-cli": "Gemini" };

/** "Claude", "Codex", "Gemini": the provider word a chip pairs with the account name. */
export function shortProviderName(providerId: string): string {
  return SHORT_PROVIDER[providerId] ?? providerId;
}

/**
 * A chip's two words: the provider ("Claude") and the account's own part of its name ("Work", or
 * "A" for an account named "Claude A"), so narrow windows can drop the provider word.
 */
export function chipParts(account: Pick<ProviderAccount, "providerId" | "displayName">): {
  provider: string;
  name: string;
} {
  const name = accountName(account);
  const provider = shortProviderName(account.providerId);
  const rest = name.toLowerCase().startsWith(`${provider.toLowerCase()} `) ? name.slice(provider.length).trim() : "";
  return { provider, name: rest || name };
}

/** "Claude Work", or "Claude A" for an account already named "Claude A". */
export function chipLabel(account: Pick<ProviderAccount, "providerId" | "displayName">): string {
  const { provider, name } = chipParts(account);
  return name.toLowerCase().startsWith(provider.toLowerCase()) ? name : `${provider} ${name}`;
}

export type DockHealth = "healthy" | "signed_out" | "attention" | "unchecked";

export interface DockAccount {
  account: ProviderAccount;
  /** "W", or "CA" for a two-word name such as "Client A". */
  monogram: string;
  /** Index into the dock's avatar palette, stable for the account's id. */
  hue: number;
  health: DockHealth;
  healthLabel: string;
  /** Open threads bound to this account. */
  threads: number;
  /** Those with a turn starting or running right now. */
  running: number;
  /** Those waiting on the person (an approval). */
  waiting: number;
}

/** How many avatar colours the dock's stylesheet defines. */
export const DOCK_HUES = 8;

export function accountMonogram(account: Pick<ProviderAccount, "displayName">): string {
  const words = accountName(account)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word !== "");
  if (words.length === 0) return "?";
  const letters = words.length === 1 ? [words[0]?.[0]] : [words[0]?.[0], words[1]?.[0]];
  return letters.join("").toUpperCase();
}

/** A colour index from the account id alone, so it never changes with a rename or reorder. */
export function accountHue(id: string): number {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  return hash % DOCK_HUES;
}

export function dockHealth(
  account: Pick<ProviderAccount, "authenticationState" | "lastErrorCode" | "lastCheckedAt">,
): DockHealth {
  if (account.lastErrorCode) return "attention";
  if (account.authenticationState === "authenticated") return "healthy";
  if (account.authenticationState === "not_authenticated") return "signed_out";
  return "unchecked";
}

/** Signed out or failing: the account can't be relied on to carry a thread right now. */
export function isUnavailable(health: DockHealth): boolean {
  return health === "signed_out" || health === "attention";
}

function isRunning(thread: ThreadSummary): boolean {
  return thread.status === "starting" || presentStatus(thread.status).working;
}

/** The active accounts in dock order with the open threads each carries. */
export function dockAccounts(accounts: readonly ProviderAccount[], threads: readonly ThreadSummary[]): DockAccount[] {
  const active = accounts.filter((account) => !account.archivedAt);
  const providers = [...new Set(active.map((account) => account.providerId))].sort(
    (a, b) => (PROVIDER_RANK[a] ?? 99) - (PROVIDER_RANK[b] ?? 99) || a.localeCompare(b),
  );
  const open = threads.filter((thread) => !thread.archivedAt);
  return providers.flatMap((providerId) =>
    sortAccounts(active.filter((account) => account.providerId === providerId)).map((account) => {
      const mine = open.filter((thread) => thread.providerAccountId === account.id);
      const health = dockHealth(account);
      return {
        account,
        monogram: accountMonogram(account),
        hue: accountHue(account.id),
        health,
        healthLabel: accountHealth(account).label,
        threads: mine.length,
        running: mine.filter(isRunning).length,
        waiting: mine.filter((thread) => thread.status === "waiting_for_permission" || thread.pendingApprovals > 0)
          .length,
      };
    }),
  );
}

/** "2 running · 5 threads", "1 needs you · 3 threads", "Idle · 2 threads", "No threads". */
export function usageLine(entry: Pick<DockAccount, "threads" | "running" | "waiting">): string {
  if (entry.threads === 0) return "No threads";
  const total = entry.threads === 1 ? "1 thread" : `${entry.threads} threads`;
  const live = [
    entry.waiting > 0 ? (entry.waiting === 1 ? "1 needs you" : `${entry.waiting} need you`) : null,
    entry.running > 0 ? `${entry.running} running` : null,
  ].filter(Boolean);
  return [...(live.length > 0 ? live : ["Idle"]), total].join(" · ");
}

/** The activity ring's fill, 0..1: the share of the account's threads that are running. */
export function activityShare(entry: Pick<DockAccount, "threads" | "running">): number {
  return entry.threads === 0 ? 0 : Math.min(1, entry.running / entry.threads);
}

export type Compatibility =
  | { ok: true }
  | { ok: false; reason: "current" | "provider" | "signed_out" | "busy"; detail: string };

/** `rebindBlocker`'s reason, short enough for a menu line and a drag caption. */
function busyReason(thread: ThreadSummary): string {
  if (thread.archivedAt) return "Archived threads keep their account";
  if (thread.status === "waiting_for_permission" || thread.pendingApprovals > 0) return "Answer its approval first";
  if (isWaitingForResources(thread)) return "Waiting to start. Stop it first";
  return "Working. Finish or stop the turn first";
}

/** Whether `target` can take `thread` right now, and why not when it can't. */
export function compatibility(thread: ThreadSummary, target: DockAccount): Compatibility {
  if (thread.providerAccountId === target.account.id) {
    return { ok: false, reason: "current", detail: "Already uses this account" };
  }
  if (thread.providerId !== target.account.providerId) {
    return { ok: false, reason: "provider", detail: `Not a ${thread.providerName} account` };
  }
  if (target.account.authenticationState === "not_authenticated") {
    return { ok: false, reason: "signed_out", detail: "Signed out. Sign in to use it" };
  }
  if (rebindBlocker(thread)) return { ok: false, reason: "busy", detail: busyReason(thread) };
  return { ok: true };
}

/**
 * "Claude Work is signed out · Claude B can take it": what the dock says next to its outlined
 * alternatives. Null when there is nothing to suggest.
 */
export function alternativesHint(
  thread: ThreadSummary,
  entries: readonly DockAccount[],
  alternatives: readonly DockAccount[],
): string | null {
  const [first] = alternatives;
  if (!first) return null;
  const own = entries.find((entry) => entry.account.id === thread.providerAccountId);
  const problem = own
    ? `${chipLabel(own.account)} ${own.health === "signed_out" ? "is signed out" : "needs attention"}`
    : "This thread's account isn't connected";
  const offer =
    alternatives.length === 1
      ? `${chipLabel(first.account)} can take it`
      : `${alternatives.length} accounts can take it`;
  return `${problem} · ${offer}`;
}

/**
 * When the thread's own account is unavailable (signed out, failing, removed or missing), the
 * other accounts that could take it. Empty when its account is fine: the dock only suggests. A
 * legacy thread without a stored account runs on whatever native resolves (workspace or provider
 * default), so the dock makes no claim about it.
 */
export function alternativesFor(thread: ThreadSummary, entries: readonly DockAccount[]): DockAccount[] {
  if (!thread.providerAccountId) return [];
  const own = entries.find((entry) => entry.account.id === thread.providerAccountId);
  if (own && !isUnavailable(own.health)) return [];
  return entries.filter(
    (entry) =>
      entry.account.providerId === thread.providerId &&
      entry.account.id !== thread.providerAccountId &&
      entry.account.authenticationState !== "not_authenticated" &&
      entry.health !== "attention",
  );
}
