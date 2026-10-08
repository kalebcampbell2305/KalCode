import type { ChainStepRoute, ModelInfo, ProviderAccount, ProviderAccountBinding } from "@kalcode/protocol";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { KalCodeClient } from "../../ipc/client.ts";
import { useRuntime } from "../../runtime/RuntimeProvider.tsx";
import {
  effortLabel,
  effortsForModel,
  launchAccounts,
  type ModelEffortInfo,
  readLaunchMemory,
  resolveLaunchAccount,
} from "../code/panes/agentLaunch.ts";
import { PANE_PROVIDERS, type PaneProviderId } from "../code/panes/paneChannel.ts";
import { accountName, accountSessionState, sortAccounts } from "../providers/accountIdentity.ts";
import { useOptionalProviderAccountSessions } from "../providers/ProviderAccountSessions.tsx";
import { type DraftRoute, providerName } from "./model.ts";

/**
 * The provider / account / exact model / effort choices a chain step can use. The same sources
 * and helpers as New agent (`NewAgentDialog`): the shared account sessions, account-scoped model
 * discovery, workspace account bindings and the remembered launch, so a step defaults to what
 * KalCode already knows and the common case needs no choice at all.
 */

interface RouteCache {
  models: ReadonlyMap<string, readonly ModelInfo[]> | null;
  providers: ReadonlySet<string> | null;
  bindings: readonly ProviderAccountBinding[] | null;
}
const caches = new WeakMap<KalCodeClient, RouteCache>();
function cacheFor(client: KalCodeClient): RouteCache {
  let cache = caches.get(client);
  if (!cache) {
    cache = { models: null, providers: null, bindings: null };
    caches.set(client, cache);
  }
  return cache;
}

export interface RouteProviderGroup {
  providerId: PaneProviderId;
  name: string;
  accounts: ProviderAccount[];
}

export interface RouteModels {
  items: readonly ModelEffortInfo[] | null;
  pending: boolean;
  error: string | null;
}

export interface RouteOptions {
  /** Accounts and bindings are known (the default route is the one that will run). */
  ready: boolean;
  error: string | null;
  groups: RouteProviderGroup[];
  account: (accountId: string) => ProviderAccount | undefined;
  usable: (accountId: string) => boolean;
  models: (providerId: string, accountId: string) => RouteModels;
  discover: (accountId: string) => void;
  /** The route a new step starts from: a seed (the source agent), else the remembered launch. */
  defaultRoute: (workspaceId: string, seed?: Partial<DraftRoute> | null) => DraftRoute;
}

const EMPTY_GROUPS: RouteProviderGroup[] = [];

export function useRouteOptions(): RouteOptions {
  const { client } = useRuntime();
  const sessions = useOptionalProviderAccountSessions();
  const cache = cacheFor(client);
  const [models, setModels] = useState(cache.models);
  const [providers, setProviders] = useState(cache.providers);
  const [bindings, setBindings] = useState(cache.bindings);
  const [localAccounts, setLocalAccounts] = useState<readonly ProviderAccount[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const shared = sessions !== null;

  useEffect(() => {
    let cancelled = false;
    if (!shared) {
      client.listProviderAccounts().then(
        (accounts) => {
          if (!cancelled) setLocalAccounts(accounts);
        },
        () => {
          if (!cancelled) setError("Accounts unavailable");
        },
      );
    }
    client.listProviderAccountBindings({ kind: "workspace" }).then(
      (next) => {
        cacheFor(client).bindings = next;
        if (!cancelled) setBindings(next);
      },
      () => {
        if (!cancelled) setBindings((current) => current ?? []);
      },
    );
    client.threadOptions().then(
      (options) => {
        const nextModels = new Map(options.providers.map((p) => [p.id, p.models]));
        const nextProviders = new Set(options.providers.map((p) => p.id as string));
        const target = cacheFor(client);
        target.models = nextModels;
        target.providers = nextProviders;
        if (cancelled) return;
        setModels(nextModels);
        setProviders(nextProviders);
      },
      () => {
        if (!cancelled) setProviders((current) => current ?? new Set());
      },
    );
    return () => {
      cancelled = true;
    };
  }, [client, shared]);

  const accounts = sessions ? sessions.accounts : localAccounts;
  const loadError = (sessions?.accounts === null ? sessions.loadError : null) ?? error;

  const groups = useMemo(() => {
    if (!accounts) return EMPTY_GROUPS;
    return PANE_PROVIDERS.filter((p) => p === "claude-code" || (providers?.has(p) ?? false))
      .map((providerId) => ({
        providerId,
        name: providerName(providerId),
        accounts: sortAccounts(launchAccounts(accounts, providerId)),
      }))
      .filter((group) => group.accounts.length > 0);
  }, [accounts, providers]);

  const account = useCallback((accountId: string) => accounts?.find((a) => a.id === accountId), [accounts]);
  const usable = useCallback(
    (accountId: string) => {
      const found = accounts?.find((a) => a.id === accountId);
      if (!found) return false;
      return (sessions?.states.get(accountId)?.health ?? accountSessionState(found)).usable;
    },
    [accounts, sessions],
  );

  const routeModels = useCallback(
    (providerId: string, accountId: string): RouteModels => {
      const scoped = accountId ? sessions?.states.get(accountId)?.models : undefined;
      if (scoped?.status === "available" || (scoped?.status === "checking" && scoped.items.length > 0))
        return { items: scoped.items, pending: scoped.status === "checking", error: null };
      if (scoped?.status === "unavailable") {
        const fallback = models?.get(providerId) ?? null;
        return { items: fallback, pending: false, error: scoped.reason };
      }
      const catalog = models?.get(providerId) ?? null;
      return { items: catalog, pending: scoped?.status === "checking" || catalog === null, error: null };
    },
    [sessions, models],
  );

  const discoverModels = sessions?.discoverModels;
  const discover = useCallback(
    (accountId: string) => {
      const found = accounts?.find((a) => a.id === accountId);
      if (found && found.authenticationState !== "not_authenticated") void discoverModels?.(accountId);
    },
    [accounts, discoverModels],
  );

  const defaultRoute = useCallback(
    (workspaceId: string, seed?: Partial<DraftRoute> | null): DraftRoute => {
      const memory = readLaunchMemory();
      const providerId = (seed?.providerId ?? memory.last?.providerId ?? "claude-code") as PaneProviderId;
      const remembered = memory.byProvider[providerId];
      const all = accounts ?? [];
      const seededAccount =
        seed?.providerAccountId && launchAccounts(all, providerId).some((a) => a.id === seed.providerAccountId)
          ? seed.providerAccountId
          : "";
      const accountId =
        seededAccount || (accounts ? resolveLaunchAccount(all, bindings, providerId, workspaceId, remembered) : "");
      const fromSeed = seed?.providerId !== undefined;
      return {
        providerId,
        providerAccountId: accountId,
        model: (fromSeed ? seed?.model : remembered?.model) ?? "",
        effort: (fromSeed ? seed?.effort : remembered?.effort) ?? "",
      };
    },
    [accounts, bindings],
  );

  return {
    ready: accounts !== null && bindings !== null,
    error: loadError,
    groups,
    account,
    usable,
    models: routeModels,
    discover,
    defaultRoute,
  };
}

/** The model a route runs: its exact pick, else the account's reported default, else the first. */
export function routeModel(route: DraftRoute, models: RouteModels): ModelEffortInfo | null {
  const items = models.items ?? [];
  if (route.model) return items.find((m) => m.id === route.model) ?? null;
  return items.find((m) => m.isDefault) ?? items[0] ?? null;
}

/** Efforts the route's model accepts (empty when the provider has no effort setting). */
export function routeEfforts(route: DraftRoute, models: RouteModels): readonly string[] {
  return effortsForModel(route.providerId as PaneProviderId, routeModel(route, models));
}

/** Provider-native effort the route runs: its pick, else the model's default, else a middle one. */
export function routeEffort(route: DraftRoute, models: RouteModels): string {
  const efforts = routeEfforts(route, models);
  if (route.effort && (efforts.length === 0 || efforts.includes(route.effort))) return route.effort;
  const model = routeModel(route, models);
  if (model?.defaultEffort && efforts.includes(model.defaultEffort)) return model.defaultEffort;
  if (efforts.includes("medium")) return "medium";
  // No effort setting: empty means the provider's own default (never a literal "default").
  return efforts[0] ?? "";
}

/**
 * The exact route a chain step is started with. Native requires a concrete model and effort, so a
 * default is resolved here from what the account reports; an unknown catalog is an actionable error.
 */
export function resolveRoute(
  route: DraftRoute,
  options: Pick<RouteOptions, "models" | "account" | "usable">,
): { route: ChainStepRoute } | { error: string } {
  const account = options.account(route.providerAccountId);
  if (!account) return { error: `Choose a ${providerName(route.providerId)} account.` };
  if (!options.usable(account.id))
    return { error: `${accountName(account)} needs to reconnect before it can run a step.` };
  const models = options.models(route.providerId, route.providerAccountId);
  const model = routeModel(route, models);
  if (!model) {
    if (route.model) return { route: { ...base(route), model: route.model, effort: routeEffort(route, models) } };
    return {
      error: models.pending
        ? `Still reading ${accountName(account)}'s models. Try again in a moment.`
        : `${accountName(account)} reports no models. Choose another account.`,
    };
  }
  return { route: { ...base(route), model: model.id, effort: routeEffort(route, models) } };
}

function base(route: DraftRoute) {
  return { providerId: route.providerId, providerAccountId: route.providerAccountId };
}

/** "Work · Opus 4.6 · High" for a draft route (the collapsed picker's one line). */
export function routeSummary(route: DraftRoute, options: Pick<RouteOptions, "account" | "models">): string {
  const account = options.account(route.providerAccountId);
  const models = options.models(route.providerId, route.providerAccountId);
  const model = routeModel(route, models);
  const modelText = route.model
    ? (model?.displayName ?? route.model)
    : model
      ? `${model.displayName}`
      : "Default model";
  const effort = route.effort || (models.items ? routeEffort(route, models) : "");
  return [
    account ? accountName(account) : `No ${providerName(route.providerId)} account`,
    modelText,
    effort ? effortLabel(effort) : null,
  ]
    .filter(Boolean)
    .join(" · ");
}
