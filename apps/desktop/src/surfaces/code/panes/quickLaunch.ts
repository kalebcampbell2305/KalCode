import type { ModelInfo, ProviderAccount, ProviderAccountBinding } from "@kalcode/protocol";
import { accountName } from "../../providers/accountIdentity.ts";
import {
  AGENT_EFFORTS,
  boundLaunchAccount,
  clampAgentCount,
  effortLabel,
  type LaunchMemory,
  launchAccounts,
} from "./agentLaunch.ts";
import { isPaneProvider, type PaneProviderId } from "./paneChannel.ts";
import { providerIdentity } from "./paneLabels.ts";
import type { AgentLaunch } from "./useProviderPanes.ts";

/**
 * One-click New agent (owner simplicity rule: "if KalCode already knows the answer, do not ask").
 * Decides whether a launch has exactly one obvious valid configuration — then it starts at once —
 * or whether the person has to choose, in which case the launcher opens pre-filled. It never
 * guesses an account, never names a model the account no longer offers, and never starts more
 * agents than were explicitly asked for.
 */

export interface QuickLaunchSpec extends AgentLaunch {
  providerId: PaneProviderId;
  count: number;
}

export interface QuickLaunchContext {
  accounts: readonly ProviderAccount[];
  bindings: readonly ProviderAccountBinding[] | null;
  workspaceId: string;
  memory: LaunchMemory;
  /** Providers this build can start in a pane right now. */
  providers: readonly PaneProviderId[];
  /** Whether an account can start an agent now (its real session state). */
  usable: (account: ProviderAccount) => boolean;
  /** The exact models this account offers; null while unknown. */
  modelsOf: (providerId: PaneProviderId, accountId: string) => readonly ModelInfo[] | null;
}

export interface QuickLaunchOverrides {
  providerId?: string;
  count?: number;
}

export type QuickLaunch =
  | { kind: "ready"; spec: QuickLaunchSpec; summary: string }
  | { kind: "choose"; providerId?: PaneProviderId; count?: number; reason: string };

/**
 * The account a one-click launch uses: the workspace's binding or the remembered account (the
 * launcher's own precedence), then the provider default, then the only signed-in account.
 * Null whenever choosing would be a guess.
 */
export function quickLaunchAccount(ctx: QuickLaunchContext, providerId: PaneProviderId): ProviderAccount | null {
  const candidates = launchAccounts(ctx.accounts, providerId);
  const byId = (id: string | null | undefined) => (id ? (candidates.find((a) => a.id === id) ?? null) : null);
  const remembered = ctx.memory.byProvider[providerId];
  const bound = boundLaunchAccount(ctx.accounts, ctx.bindings, providerId, ctx.workspaceId);
  const rememberedAccount = byId(remembered?.accountId);
  if (rememberedAccount && remembered) {
    // An explicit Account Center choice made after the remembered launch wins.
    if (!bound) return rememberedAccount;
    if (remembered.workspaceId === ctx.workspaceId && remembered.boundAccountId === bound) return rememberedAccount;
    return byId(bound);
  }
  if (bound) return byId(bound);
  const preferred = candidates.find((a) => a.isDefault);
  if (preferred) return preferred;
  const signedIn = candidates.filter((a) => a.authenticationState !== "not_authenticated");
  return signedIn.length === 1 ? (signedIn[0] ?? null) : null;
}

/** The provider a one-click launch starts, or null when it would be a guess. */
function quickLaunchProvider(ctx: QuickLaunchContext, requested: string | undefined): PaneProviderId | null {
  if (requested !== undefined) return isPaneProvider(requested) && ctx.providers.includes(requested) ? requested : null;
  const last = ctx.memory.last?.providerId;
  if (last && ctx.providers.includes(last)) return last;
  // Nothing remembered: obvious only when exactly one offered provider has a usable account.
  const ready = ctx.providers.filter((p) => launchAccounts(ctx.accounts, p).some((a) => ctx.usable(a)));
  return ready.length === 1 ? (ready[0] ?? null) : null;
}

export function resolveQuickLaunch(ctx: QuickLaunchContext, overrides: QuickLaunchOverrides = {}): QuickLaunch {
  // One click starts one agent; only an explicit count ("start six agents") starts many.
  const count = clampAgentCount(overrides.count ?? 1);
  const providerId = quickLaunchProvider(ctx, overrides.providerId);
  const choose = (reason: string, provider: PaneProviderId | undefined = providerId ?? undefined): QuickLaunch => ({
    kind: "choose",
    ...(provider ? { providerId: provider } : {}),
    ...(overrides.count !== undefined ? { count } : {}),
    reason,
  });
  if (!providerId) {
    return overrides.providerId !== undefined
      ? choose(`${providerIdentity(overrides.providerId).name} isn't available in this build.`, undefined)
      : choose("Choose a provider and account.");
  }
  const providerName = providerIdentity(providerId).name;
  if (launchAccounts(ctx.accounts, providerId).length === 0) return choose(`Add a ${providerName} account.`);
  const account = quickLaunchAccount(ctx, providerId);
  if (!account) return choose(`Choose which ${providerName} account to use.`);
  if (!ctx.usable(account)) return choose(`${providerName} · ${accountName(account)} needs to sign in again.`);

  // Model and effort follow this provider's last launch, only while still valid.
  const remembered = ctx.memory.byProvider[providerId];
  const offered = ctx.modelsOf(providerId, account.id);
  let model: ModelInfo | null = null;
  if (remembered?.model) {
    if (!offered) return choose(`Checking which ${providerName} models this account offers.`);
    model = offered.find((m) => m.id === remembered.model) ?? null;
    if (!model) return choose(`${remembered.modelName ?? remembered.model} isn't offered by this account any more.`);
    if (model.isDefault) model = null;
  } else if (providerId === "cursor" && offered === null) {
    // Cursor's models belong to the real account/runtime; never launch blind.
    return choose("Checking which Cursor models this account offers.");
  }
  const effort = remembered?.effort && AGENT_EFFORTS[providerId].includes(remembered.effort) ? remembered.effort : null;
  const defaultName = offered?.find((m) => m.isDefault)?.displayName ?? "Default model";
  const summary = [
    count > 1 ? `${count} × ${providerName}` : providerName,
    accountName(account),
    model?.displayName ?? defaultName,
    effort ? effortLabel(effort) : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return {
    kind: "ready",
    spec: { providerId, count, providerAccountId: account.id, model: model?.id ?? null, effort },
    summary,
  };
}
