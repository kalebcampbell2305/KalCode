import type { ProviderAccount, ProviderAccountUsage } from "@kalcode/protocol";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KalCodeClient } from "../../ipc/client.ts";
import type { EventFeed } from "../../runtime/eventFeed.ts";
import { type AccountUsageState, isReportedPercent, type UsageWindow } from "./accountUsage.ts";

/** Background refresh cadence while the window is visible. */
export const USAGE_REFRESH_MS = 90_000;
/** Focus/visibility refreshes are skipped when a read started this recently. */
export const USAGE_FOCUS_THROTTLE_MS = 15_000;
/** A provider reading older than this is labelled stale (real numbers, not current). */
export const USAGE_STALE_AFTER_MS = 15 * 60_000;
/** Lets the provider CLI flush its usage record after a turn/session ends before re-reading. */
export const USAGE_AFTER_SESSION_DELAY_MS = 2_000;

const SESSION_END_EVENTS = new Set(["agent.turn_completed", "thread.completed", "thread.failed"]);
const RESET_SINCE_READ = "Usage reset since the last agent run";
const READ_FAILED = "Usage couldn't be read";
const INVALID_READING = "Provider usage is unavailable";
const EMPTY: ReadonlyMap<string, AccountUsageState> = new Map();
const EMPTY_REVISIONS: ReadonlyMap<string, number> = new Map();

type UsageRead = readonly ProviderAccountUsage[] | "checking" | "failed";

function freshness(checkedAt: string | null, now: number): "fresh" | "stale" {
  const at = checkedAt ? Date.parse(checkedAt) : Number.NaN;
  return Number.isFinite(at) && now - at <= USAGE_STALE_AFTER_MS ? "fresh" : "stale";
}

/** Native usage → the canonical UI state. Windows whose reset passed since the read are dropped. */
export function toAccountUsageState(native: ProviderAccountUsage, now: number): AccountUsageState {
  const base = { accountId: native.accountId, plan: native.plan ?? null };
  if (native.status === "unavailable") {
    return { ...base, status: "unavailable", windows: [], checkedAt: null, reason: native.reason };
  }
  const windows: UsageWindow[] =
    native.status === "available" && native.checkedAt !== null && Number.isFinite(Date.parse(native.checkedAt))
      ? native.windows
          .filter(
            (window) =>
              isReportedPercent(window.remainingPercent) &&
              (window.resetsAt === null || Date.parse(window.resetsAt) > now),
          )
          .map((window) => ({
            id: window.id,
            label: window.label,
            remainingPercent: window.remainingPercent,
            resetsAt: window.resetsAt,
          }))
      : [];
  if (windows.length === 0) {
    const resetPassed = native.windows.some((window) => window.resetsAt !== null && Date.parse(window.resetsAt) <= now);
    const reason = native.status === "available" ? (resetPassed ? RESET_SINCE_READ : INVALID_READING) : native.reason;
    return { ...base, status: "not_checked", windows: [], checkedAt: null, reason };
  }
  return {
    ...base,
    status: freshness(native.checkedAt, now),
    windows,
    checkedAt: native.checkedAt,
    reason: null,
  };
}

/** Re-labels fresh/stale by age (and drops elapsed windows) without a new provider read. */
function restamp(state: AccountUsageState, now: number): AccountUsageState {
  if (state.status !== "fresh" && state.status !== "stale") return state;
  return toAccountUsageState(
    {
      accountId: state.accountId,
      status: "available",
      plan: state.plan ?? null,
      windows: [...state.windows],
      checkedAt: state.checkedAt,
      reason: null,
    },
    now,
  );
}

function sameState(left: AccountUsageState, right: AccountUsageState): boolean {
  return (
    left.accountId === right.accountId &&
    left.status === right.status &&
    left.checkedAt === right.checkedAt &&
    left.reason === right.reason &&
    (left.plan ?? null) === (right.plan ?? null) &&
    left.windows.length === right.windows.length &&
    left.windows.every((window, index) => {
      const other = right.windows[index];
      return (
        other !== undefined &&
        window.id === other.id &&
        window.label === other.label &&
        window.remainingPercent === other.remainingPercent &&
        window.resetsAt === other.resetsAt
      );
    })
  );
}

/**
 * The next usage map for the current accounts. Unchanged entries keep their object identity and
 * an unchanged map is returned as-is, so consumers re-render only when an account's usage moved.
 */
export function nextUsageMap(
  previous: ReadonlyMap<string, AccountUsageState>,
  accounts: readonly ProviderAccount[],
  read: UsageRead,
  now: number,
): ReadonlyMap<string, AccountUsageState> {
  const byId = Array.isArray(read) ? new Map(read.map((usage) => [usage.accountId, usage])) : null;
  const next = new Map<string, AccountUsageState>();
  let changed = previous.size !== accounts.filter((account) => account.archivedAt === null).length;
  for (const account of accounts) {
    if (account.archivedAt !== null) continue;
    const before = previous.get(account.id);
    const native = byId?.get(account.id);
    let state: AccountUsageState;
    if (read === "failed") {
      state = {
        accountId: account.id,
        plan: before?.plan ?? null,
        status: "unavailable",
        windows: [],
        checkedAt: null,
        reason: READ_FAILED,
      };
    } else if (native) state = toAccountUsageState(native, now);
    else if (read === "checking" && before && (before.status === "fresh" || before.status === "stale"))
      state = restamp(before, now);
    else if (read === "checking") state = before ?? notCheckedYet(account.id, "checking");
    else
      state = {
        accountId: account.id,
        plan: before?.plan ?? null,
        status: "unavailable",
        windows: [],
        checkedAt: null,
        reason: INVALID_READING,
      };
    if (before && sameState(before, state)) state = before;
    else changed = true;
    next.set(account.id, state);
  }
  return changed ? next : previous;
}

function notCheckedYet(accountId: string, reason: string | null | "checking"): AccountUsageState {
  if (reason === "checking") return { accountId, status: "checking", windows: [], checkedAt: null, reason: null };
  return { accountId, status: "not_checked", windows: [], checkedAt: null, reason };
}

function isVisible(): boolean {
  return typeof document === "undefined" || document.visibilityState !== "hidden";
}

function accountBinding(account: ProviderAccount, revision = 0): string {
  return JSON.stringify([
    account.providerId,
    account.id,
    account.providerReportedIdentity,
    account.authenticationState,
    account.archivedAt,
    revision,
  ]);
}

interface UsageSnapshot {
  client?: KalCodeClient;
  values: ReadonlyMap<string, AccountUsageState>;
  bindings: ReadonlyMap<string, string>;
}

const EMPTY_SNAPSHOT: UsageSnapshot = { values: EMPTY, bindings: new Map() };

function boundUsage(
  snapshot: UsageSnapshot,
  accounts: readonly ProviderAccount[],
  revisions: ReadonlyMap<string, number>,
): ReadonlyMap<string, AccountUsageState> {
  const allowed = new Map(
    accounts
      .filter((account) => account.archivedAt === null)
      .map((account) => [account.id, accountBinding(account, revisions.get(account.id))]),
  );
  const entries = [...snapshot.values].filter(([id]) => allowed.get(id) === snapshot.bindings.get(id));
  return entries.length === snapshot.values.size ? snapshot.values : new Map(entries);
}

function snapshotFor(
  previous: UsageSnapshot,
  accounts: readonly ProviderAccount[],
  read: UsageRead,
  revisions: ReadonlyMap<string, number>,
  client: KalCodeClient,
): UsageSnapshot {
  return {
    client,
    values: nextUsageMap(boundUsage(previous, accounts, revisions), accounts, read, Date.now()),
    bindings: new Map(accounts.map((account) => [account.id, accountBinding(account, revisions.get(account.id))])),
  };
}

/**
 * Owns the shell-lifetime usage map behind `useAccountUsages`. Reads are passive native file
 * reads and never block anything: the map starts empty, accounts show "checking" while the first
 * read is in flight, and results replace entries in place. Refreshes run after accounts restore
 * or change, every USAGE_REFRESH_MS while visible, on focus (throttled) and after agent sessions
 * end. Concurrent triggers coalesce into one follow-up read.
 */
export function useAccountUsageReader(
  client: KalCodeClient,
  accounts: readonly ProviderAccount[] | null,
  feed: EventFeed | null | undefined,
  refreshRequest = 0,
  revisions: ReadonlyMap<string, number> = EMPTY_REVISIONS,
): ReadonlyMap<string, AccountUsageState> {
  const [usage, setUsage] = useState<UsageSnapshot>(EMPTY_SNAPSHOT);
  const accountsRef = useRef(accounts);
  accountsRef.current = accounts;
  const revisionsRef = useRef(revisions);
  revisionsRef.current = revisions;
  const run = useRef({ generation: 0, inflight: false, again: false, lastStarted: Number.NEGATIVE_INFINITY });

  const refresh = useCallback((): void => {
    const reader = (client as Partial<KalCodeClient>).providerAccountUsage;
    if (typeof reader !== "function") return;
    const state = run.current;
    if (state.inflight) {
      state.again = true;
      return;
    }
    const current = accountsRef.current;
    if (!current) return;
    if (current.length === 0) {
      setUsage(EMPTY_SNAPSHOT);
      return;
    }
    state.inflight = true;
    state.lastStarted = Date.now();
    const generation = state.generation;
    const requestedBindings = new Map(
      current.map((account) => [account.id, accountBinding(account, revisionsRef.current.get(account.id))]),
    );
    const matchingAccounts = () =>
      (accountsRef.current ?? []).filter(
        (account) =>
          requestedBindings.get(account.id) === accountBinding(account, revisionsRef.current.get(account.id)),
      );
    setUsage((previous) => snapshotFor(previous, current, "checking", revisionsRef.current, client));
    Promise.resolve()
      .then(() => reader.call(client))
      .then(
        (read) => {
          if (generation !== state.generation) return;
          setUsage((previous) => snapshotFor(previous, matchingAccounts(), read, revisionsRef.current, client));
        },
        () => {
          if (generation !== state.generation) return;
          setUsage((previous) => snapshotFor(previous, matchingAccounts(), "failed", revisionsRef.current, client));
        },
      )
      .finally(() => {
        if (generation !== state.generation) return;
        state.inflight = false;
        if (state.again) {
          state.again = false;
          refreshRef.current();
        }
      });
  }, [client]);
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;

  // A different native client is a different runtime: forget everything read from the old one.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the client identity is the trigger.
  useEffect(() => {
    const state = run.current;
    state.generation += 1;
    state.inflight = false;
    state.again = false;
    state.lastStarted = Number.NEGATIVE_INFINITY;
    setUsage(EMPTY_SNAPSHOT);
  }, [client]);

  // Restored, connected, signed-in/out or removed accounts get a read right away.
  const accountsKey =
    accounts
      ?.map((account) => accountBinding(account, revisions.get(account.id)))
      .sort()
      .join("|") ?? null;
  useEffect(() => {
    void refreshRequest;
    if (accountsKey !== null) refresh();
  }, [accountsKey, refresh, refreshRequest]);

  useEffect(() => {
    const interval = setInterval(() => {
      if (isVisible()) refreshRef.current();
    }, USAGE_REFRESH_MS);
    const onFocus = () => {
      if (isVisible() && Date.now() - run.current.lastStarted >= USAGE_FOCUS_THROTTLE_MS) refreshRef.current();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      clearInterval(interval);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, []);

  // A finished turn/session is when providers record new usage.
  useEffect(() => {
    if (!feed) return;
    let seenSeq = feed.getSnapshot().events[0]?.seq ?? 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = feed.subscribe(() => {
      const events = feed.getSnapshot().events.filter((event) => event.seq > seenSeq);
      if (events.length === 0) return;
      seenSeq = Math.max(seenSeq, ...events.map((event) => event.seq));
      if (!events.some((event) => SESSION_END_EVENTS.has(event.type))) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        refreshRef.current();
      }, USAGE_AFTER_SESSION_DELAY_MS);
    });
    return () => {
      if (timer) clearTimeout(timer);
      unsubscribe();
    };
  }, [feed]);

  // Hide the old identity's cache in the very render that receives the new identity.
  // In-flight reads are also restricted to the identities captured when they started.
  // biome-ignore lint/correctness/useExhaustiveDependencies: accountsKey is the stable account binding signature.
  return useMemo(
    () => (usage.client === client ? boundUsage(usage, accounts ?? [], revisions) : EMPTY),
    [usage, accountsKey, client],
  );
}
