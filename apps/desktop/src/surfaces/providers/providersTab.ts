import { useCallback, useSyncExternalStore } from "react";
import { useNavigation } from "../../shell/navigation.tsx";

/** The Providers surface's views. */
export type ProvidersTab = "setup" | "accounts" | "health";

/**
 * A request to show one Providers tab (the Dashboard's "Health details"). A tiny store rather
 * than a route: the request is read when the Providers page mounts, and followed while it is
 * already open.
 */
let requested: { tab: ProvidersTab; nonce: number } | null = null;
let nextNonce = 1;
const listeners = new Set<() => void>();

function notify() {
  for (const listener of listeners) listener();
}

export function requestProvidersTab(tab: ProvidersTab): void {
  requested = { tab, nonce: nextNonce++ };
  notify();
}

/** Marks a request handled, so a later plain visit opens the default tab. */
export function consumeProvidersTab(nonce: number): void {
  if (requested?.nonce !== nonce) return;
  requested = null;
  notify();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The latest tab request (null until one is made). */
export function useProvidersTabRequest(): { tab: ProvidersTab; nonce: number } | null {
  return useSyncExternalStore(
    subscribe,
    () => requested,
    () => requested,
  );
}

/** What to show when the Accounts tab opens for one provider. */
export interface ProviderAccountsRequest {
  /** The provider whose section to bring into view, e.g. "gemini-cli". */
  providerId: string;
  accountId?: string;
  /**
   * Also open that provider's "Connect another account" form (name field focused). Nothing is
   * created and no sign-in starts until the person names the account and chooses "Add and sign in".
   */
  connect: boolean;
  nonce: number;
}

let accountsRequested: ProviderAccountsRequest | null = null;

/**
 * Opens Providers → Accounts at one provider's section and, with `connect: true`, starts that
 * provider's existing connect-another-account flow. Store only: the caller navigates to
 * "providers" (or uses {@link useOpenProviderAccounts}, which does both).
 */
export function openProviderAccounts({
  providerId,
  accountId,
  connect = false,
}: {
  providerId: string;
  accountId?: string;
  connect?: boolean;
}): void {
  accountsRequested = { providerId, accountId, connect, nonce: nextNonce++ };
  requestProvidersTab("accounts");
}

/** Marks an accounts request handled by the Accounts view. */
export function consumeProviderAccountsRequest(nonce: number): void {
  if (accountsRequested?.nonce !== nonce) return;
  accountsRequested = null;
  notify();
}

/** The pending accounts request (null when none is waiting). */
export function useProviderAccountsRequest(): ProviderAccountsRequest | null {
  return useSyncExternalStore(
    subscribe,
    () => accountsRequested,
    () => accountsRequested,
  );
}

/**
 * `openProviderAccounts` plus navigation: `const open = useOpenProviderAccounts();
 * open({ providerId: "gemini-cli", connect: true })` shows Providers → Accounts with the Gemini CLI
 * connect form open. For menus such as the thread header's "+ Connect another … account".
 */
export function useOpenProviderAccounts(): (request: { providerId: string; connect?: boolean }) => void {
  const { navigate } = useNavigation();
  return useCallback(
    (request) => {
      openProviderAccounts(request);
      navigate("providers");
    },
    [navigate],
  );
}
