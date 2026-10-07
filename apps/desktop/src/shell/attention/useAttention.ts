import { useMemo, useSyncExternalStore } from "react";
import { useOptionalChains } from "../../runtime/chains/useChains.tsx";
import { useCodingAgents } from "../../surfaces/dashboard/data/DashboardData.tsx";
import { useAgentOverlaps } from "../../surfaces/dashboard/fleet/useAgentOverlaps.ts";
import { useNow } from "../../surfaces/dashboard/useNow.ts";
import { useOptionalPermissions } from "../../surfaces/permissions/PermissionsProvider.tsx";
import { useOptionalDeckData } from "../deck/DeckData.tsx";
import { useOptionalNotifications } from "../notifications/NotificationsProvider.tsx";
import { type AttentionItem, attentionItems } from "./model.ts";

/**
 * Dismissed attention occurrences. A per-device convenience (like a collapsed section): each key
 * names one occurrence, so a later failure or finish of the same agent shows again. Bounded, and
 * the inbox works the same when storage is unavailable.
 */
const STORAGE_KEY = "kalcode.attention.dismissed.v1";
const MAX_DISMISSED = 300;

function load(): string[] {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((k): k is string => typeof k === "string") : [];
  } catch {
    return [];
  }
}

let dismissed: ReadonlySet<string> = new Set(load());
const listeners = new Set<() => void>();

export function dismissAttention(key: string): void {
  if (dismissed.has(key)) return;
  const next = [...dismissed, key].slice(-MAX_DISMISSED);
  dismissed = new Set(next);
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // The dismissal still applies for this session.
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useDismissedAttention(): ReadonlySet<string> {
  return useSyncExternalStore(subscribe, () => dismissed);
}

const NONE: never[] = [];

export interface Attention {
  items: AttentionItem[];
  /** False until the agent list has loaded (the inbox shows a skeleton, never a false "all clear"). */
  ready: boolean;
}

/**
 * The attention inbox's items. Must render inside a Dashboard data boundary (the Shell mounts one);
 * reads the permissions and notifications providers when mounted. Recomputes only when one of its
 * sources changes (or every 30 s, for "no activity for N min").
 */
export function useAttention(): Attention {
  const { state } = useCodingAgents();
  const ownership = useAgentOverlaps();
  const deck = useOptionalDeckData();
  // Both providers wrap the app; a standalone render (tests, a pane) just has nothing from them.
  const pending = useOptionalPermissions()?.pending ?? NONE;
  const notifications = useOptionalNotifications()?.notifications ?? NONE;
  const chainsStore = useOptionalChains();
  const chains = chainsStore?.chains ?? NONE;
  const chainOperations = chainsStore?.operationsById;
  const gone = useDismissedAttention();
  const now = useNow(30_000);
  const agents = state.status === "ready" ? state.data : null;
  const items = useMemo(
    () =>
      attentionItems({
        agents: agents ?? [],
        approvals: pending,
        notifications,
        operations: deck?.operations.data?.items ?? NONE,
        chains,
        chainOperations,
        operationsFailed: deck?.operations.failed ?? false,
        agentReadFailed:
          state.status === "error" ||
          state.status === "unavailable" ||
          (state.status === "ready" && state.error != null),
        overlaps: ownership.overlaps,
        ownershipFailed: ownership.failed,
        ownershipIncomplete: ownership.incomplete,
        dismissed: gone,
        now,
      }),
    [
      agents,
      pending,
      notifications,
      deck?.operations.data?.items,
      chains,
      chainOperations,
      deck?.operations.failed,
      state,
      ownership.overlaps,
      ownership.failed,
      ownership.incomplete,
      gone,
      now,
    ],
  );
  // The shell's shared Operations feed must either answer or fail explicitly before an all-clear.
  // Isolated renders without DeckData preserve the attention model's standalone behavior.
  const operationsReady = deck === null || deck.operations.data !== null || deck.operations.failed;
  const agentsReady = state.status !== "loading";
  const ownershipReady = state.status !== "ready" || ownership.ready;
  return useMemo(
    () => ({ items, ready: agentsReady && operationsReady && ownershipReady }),
    [items, agentsReady, operationsReady, ownershipReady],
  );
}
