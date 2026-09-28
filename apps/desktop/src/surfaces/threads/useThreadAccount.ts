import type { ProviderAccount, ThreadSummary } from "@kalcode/protocol";
import { useCallback, useEffect, useRef, useState } from "react";
import { toKalCodeError } from "../../ipc/errors.ts";
import { useEvents, useRuntime } from "../../runtime/RuntimeProvider.tsx";
import { presentStatus } from "./model.ts";

/** How an account's sign-in state reads in the switcher (text, never colour alone). */
export function accountStatus(state: ProviderAccount["authenticationState"]): { label: string; usable: boolean } {
  if (state === "authenticated") return { label: "Signed in", usable: true };
  if (state === "not_authenticated") return { label: "Signed out", usable: false };
  return { label: "Not checked", usable: true };
}

/** The label a thread shows for its account (legacy threads may have none). */
export function threadAccountLabel(thread: Pick<ThreadSummary, "accountLabel">): string {
  return thread.accountLabel?.trim() || "Default account";
}

/** Why a thread can't be rebound right now, or null when it can. */
export function rebindBlocker(thread: ThreadSummary, archived = false): string | null {
  if (archived || thread.archivedAt !== null) return "Archived threads keep the account they were created with.";
  if (thread.status === "waiting_for_permission" || thread.pendingApprovals > 0) {
    return "This thread is waiting for your approval. Answer it or interrupt the turn first, then switch accounts.";
  }
  if (thread.status === "starting" || presentStatus(thread.status).working) {
    return "This thread is working. Finish or stop the current turn first, then switch accounts.";
  }
  return null;
}

export interface RebindFailure {
  title: string;
  description: string;
  /** The target account needs signing in before the thread can use it. */
  signIn: boolean;
}

/** Human copy for a refused rebind (Phase 0 / runtime lane codes); unknown codes keep native copy. */
export function describeRebindError(
  error: unknown,
  context: { target: string; providerName: string; thread: ThreadSummary | null },
): RebindFailure {
  const err = toKalCodeError(error);
  const { target, providerName, thread } = context;
  const title = `Couldn't switch to ${target}`;
  const waitingForApproval =
    thread !== null && (thread.status === "waiting_for_permission" || thread.pendingApprovals > 0);
  switch (err.code) {
    case "thread_rebind_busy":
      return {
        title,
        description: waitingForApproval
          ? `This thread is waiting for your approval. Answer it or interrupt the turn first, then switch to ${target}.`
          : `This thread is still working. Finish or stop the current turn first, then switch to ${target}.`,
        signIn: false,
      };
    case "thread_rebind_pending_approval":
    case "thread_rebind_awaiting_approval":
      return {
        title,
        description: `This thread is waiting for your approval. Answer it or interrupt the turn first, then switch to ${target}.`,
        signIn: false,
      };
    case "provider_account_not_authenticated":
      return {
        title,
        description: `${target} isn't signed in. Sign in to ${target} in Providers → Accounts, then switch.`,
        signIn: true,
      };
    case "provider_account_mismatch":
      return {
        title,
        description: `${target} belongs to a different provider. Choose a ${providerName} account for this thread.`,
        signIn: false,
      };
    case "provider_account_not_found":
      return {
        title,
        description: `${target} isn't connected any more. Choose another ${providerName} account.`,
        signIn: false,
      };
    case "thread_archived":
      return { title, description: "Archived threads keep the account they were created with.", signIn: false };
    case "thread_rebind_unavailable":
      return {
        title,
        description: "Switching a thread's account isn't available in this build yet. Nothing was changed.",
        signIn: false,
      };
    default:
      return { title, description: err.message, signIn: false };
  }
}

/** The active (non-archived) accounts of one provider, re-read on demand (e.g. when a menu opens). */
export function useProviderAccountList(providerId: string) {
  const { client } = useRuntime();
  const [accounts, setAccounts] = useState<ProviderAccount[]>([]);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const request = useRef(0);

  /** Re-reads the accounts; resolves with the fresh list, or null when the read failed. */
  const reload = useCallback(async (): Promise<ProviderAccount[] | null> => {
    const id = ++request.current;
    try {
      const list = (await client.listProviderAccounts(providerId)).filter(
        (account) => account.providerId === providerId && account.archivedAt === null,
      );
      if (id === request.current) {
        setAccounts(list);
        setState("ready");
      }
      return list;
    } catch {
      if (id === request.current) setState((current) => (current === "ready" ? "ready" : "error"));
      return null;
    }
  }, [client, providerId]);

  useEffect(() => {
    setState("loading");
    void reload();
  }, [reload]);

  return { accounts, state, reload };
}

export interface AccountChange {
  threadId: string;
  providerAccountId: string;
  accountLabel: string | null;
}

/**
 * Calls `onChange` for every new `thread.account_changed` event about `threadId` (or any thread
 * when `threadId` is null), so the header and list follow a rebind made anywhere.
 */
export function useThreadAccountChanges(threadId: string | null, onChange: (change: AccountChange) => void) {
  const { events } = useEvents();
  const lastSeq = useRef<number | null>(null);
  const latest = useRef(onChange);
  latest.current = onChange;

  useEffect(() => {
    const newest = events[0]?.seq ?? 0;
    if (lastSeq.current === null) {
      lastSeq.current = newest;
      return;
    }
    const since = lastSeq.current;
    lastSeq.current = Math.max(since, newest);
    // Events are newest first; apply the fresh ones oldest first.
    for (const event of [...events].reverse()) {
      if (event.seq <= since || event.type !== "thread.account_changed") continue;
      if (threadId !== null && event.payload.threadId !== threadId) continue;
      latest.current(event.payload);
    }
  }, [events, threadId]);
}
