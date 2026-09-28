import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from "react";

/** Choices a New thread request fills in (KalVoice "open a new Codex thread with my work account"). */
export interface NewThreadPrefill {
  providerId: string;
  providerAccountId: string | null;
  workspaceId: string | null;
}

/** A request from outside the Threads surface (command palette, KalVoice) for it to act on. */
export interface ThreadsIntent {
  kind: "new" | "search" | "open";
  /** The thread to show (`open`, from KalVoice). */
  threadId?: string;
  /** What the New thread form starts with (`new`). Nothing starts until the person sends. */
  prefill?: NewThreadPrefill;
  /** Distinguishes repeated requests of the same kind. */
  nonce: number;
}

interface ThreadsIntentValue {
  intent: ThreadsIntent | null;
  request: (kind: ThreadsIntent["kind"], threadId?: string, prefill?: NewThreadPrefill) => void;
}

const ThreadsIntentContext = createContext<ThreadsIntentValue | null>(null);

export function ThreadsIntentProvider({ children }: { children: ReactNode }) {
  const [intent, setIntent] = useState<ThreadsIntent | null>(null);
  const request = useCallback((kind: ThreadsIntent["kind"], threadId?: string, prefill?: NewThreadPrefill) => {
    setIntent((current) => ({
      kind,
      ...(threadId ? { threadId } : {}),
      ...(prefill ? { prefill: { ...prefill } } : {}),
      nonce: (current?.nonce ?? 0) + 1,
    }));
  }, []);
  const value = useMemo(() => ({ intent, request }), [intent, request]);
  return <ThreadsIntentContext.Provider value={value}>{children}</ThreadsIntentContext.Provider>;
}

export function useThreadsIntent(): ThreadsIntentValue {
  const value = useContext(ThreadsIntentContext);
  if (!value) throw new Error("useThreadsIntent must be used inside <ThreadsIntentProvider>");
  return value;
}

/** For callers that may render outside the shell (tests, KalVoice in isolation). */
export function useOptionalThreadsIntent(): ThreadsIntentValue | null {
  return useContext(ThreadsIntentContext);
}
