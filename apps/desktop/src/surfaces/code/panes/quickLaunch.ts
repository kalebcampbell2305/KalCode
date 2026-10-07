import type { ModelSource, ProviderAccount, ProviderAccountBinding } from "@kalcode/protocol";
import { accountName } from "../../providers/accountIdentity.ts";
import {
  boundLaunchAccount,
  clampAgentCount,
  effortLabel,
  effortsForModel,
  type LaunchMemory,
  launchAccounts,
  type ModelEffortInfo,
  modelCatalogCanVerifyCapabilities,
  rememberedLaunch,
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
  modelsOf: (providerId: PaneProviderId, accountId: string) => readonly ModelEffortInfo[] | null;
  /** Account-catalog truth when the adapter exposes provenance and provider-level effort support. */
  modelCatalogOf?: (providerId: PaneProviderId, accountId: string) => QuickLaunchModelCatalog;
}

export interface QuickLaunchModelCatalog {
  models: readonly ModelEffortInfo[] | null;
  source?: ModelSource;
  supportedEfforts?: readonly string[];
  status?: "checking" | "available" | "stale" | "unavailable";
}

export interface QuickLaunchOverrides {
  providerId?: string;
  count?: number;
}

export type QuickLaunch =
  | { kind: "ready"; spec: QuickLaunchSpec; summary: string }
  | { kind: "choose"; providerId?: PaneProviderId; count?: number; reason: string };

function exactModelLabel(model: Pick<ModelEffortInfo, "id" | "displayName">): string {
  return model.displayName === model.id ? model.id : `${model.displayName} · ${model.id}`;
}

/**
 * The account a one-click launch uses: the workspace's binding or the remembered account (the
 * launcher's own precedence), then the provider default, then the only signed-in account.
 * Null whenever choosing would be a guess.
 */
export function quickLaunchAccount(ctx: QuickLaunchContext, providerId: PaneProviderId): ProviderAccount | null {
  const candidates = launchAccounts(ctx.accounts, providerId);
  const byId = (id: string | null | undefined) => (id ? (candidates.find((a) => a.id === id) ?? null) : null);
  const remembered = rememberedLaunch(ctx.memory, ctx.workspaceId, providerId);
  const bound = boundLaunchAccount(ctx.accounts, ctx.bindings, providerId, ctx.workspaceId);
  if (remembered) {
    const rememberedAccount = byId(remembered.accountId);
    // An explicit Account Center choice made after the remembered launch wins.
    if (bound && (remembered.workspaceId !== ctx.workspaceId || remembered.boundAccountId !== bound)) {
      return byId(bound);
    }
    // Preserve the missing identity as an unresolved choice. Never substitute a default or the
    // sole remaining account when the remembered account was removed or archived.
    return rememberedAccount;
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
  const last = ctx.providers
    .map((providerId) => rememberedLaunch(ctx.memory, ctx.workspaceId, providerId))
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
    .reduce((newest, entry) => (!newest || entry.at >= newest.at ? entry : newest), null as typeof ctx.memory.last);
  if (last && ctx.providers.includes(last.providerId)) return last.providerId;
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
  const candidates = launchAccounts(ctx.accounts, providerId);
  const account = quickLaunchAccount(ctx, providerId);
  const rememberedAccount = rememberedLaunch(ctx.memory, ctx.workspaceId, providerId);
  if (!account && rememberedAccount && !candidates.some((candidate) => candidate.id === rememberedAccount.accountId)) {
    return choose(`The saved ${providerName} account is no longer available. Choose another account.`);
  }
  if (candidates.length === 0) return choose(`Add a ${providerName} account.`);
  if (!account) return choose(`Choose which ${providerName} account to use.`);
  if (!ctx.usable(account)) return choose(`${providerName} · ${accountName(account)} needs to sign in again.`);

  // Model and effort follow this provider's last launch, only while still valid.
  const remembered = rememberedLaunch(ctx.memory, ctx.workspaceId, providerId, account.id);
  const catalog = ctx.modelCatalogOf?.(providerId, account.id) ?? {
    models: ctx.modelsOf(providerId, account.id),
  };
  const offered = catalog.models;
  const catalogCanVerifyCapabilities = modelCatalogCanVerifyCapabilities(catalog, ctx.modelCatalogOf === undefined);
  const unverifiedCatalog = !catalogCanVerifyCapabilities;
  if (offered === null && !unverifiedCatalog)
    return choose(`Checking which ${providerName} models this account offers.`);
  let model: ModelEffortInfo | null = null;
  if (remembered?.model) {
    model = offered?.find((m) => m.id === remembered.model) ?? null;
    if (!model) {
      // Only runtime account discovery (and legacy catalogs with no provenance) can prove exact
      // absence. Documented aliases are suggestions, never an availability ceiling.
      if (!unverifiedCatalog && (catalog.source === "runtime" || catalog.source === undefined)) {
        const label = remembered.modelName ?? remembered.model;
        return choose(
          `${label === remembered.model ? label : `${label} · ${remembered.model}`} isn't offered by this account any more.`,
        );
      }
      model = {
        id: remembered.model,
        displayName: remembered.modelName ?? remembered.model,
        isDefault: false,
      };
    }
  }
  const capabilityModel = model ?? offered?.find((candidate) => candidate.isDefault) ?? null;
  const effort = remembered?.effort ?? null;
  if (
    effort &&
    catalogCanVerifyCapabilities &&
    !effortsForModel(providerId, capabilityModel, catalog.supportedEfforts).includes(effort)
  ) {
    return choose(
      `${effortLabel(effort)} effort isn't available for ${capabilityModel ? exactModelLabel(capabilityModel) : "the provider default"}.`,
    );
  }
  const defaultName = capabilityModel ? exactModelLabel(capabilityModel) : "Default model";
  const summary = [
    count > 1 ? `${count} × ${providerName}` : providerName,
    accountName(account),
    model ? exactModelLabel(model) : defaultName,
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
