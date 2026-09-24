import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from "react";

/** A request from outside the Threads surface (command palette) for it to act on. */
export interface ThreadsIntent {
  kind: "new" | "search";
  /** Distinguishes repeated requests of the same kind. */
  nonce: number;
}

interface ThreadsIntentValue {
  intent: ThreadsIntent | null;
  request: (kind: ThreadsIntent["kind"]) => void;
}

const ThreadsIntentContext = createContext<ThreadsIntentValue | null>(null);

export function ThreadsIntentProvider({ children }: { children: ReactNode }) {
  const [intent, setIntent] = useState<ThreadsIntent | null>(null);
  const request = useCallback((kind: ThreadsIntent["kind"]) => {
    setIntent((current) => ({ kind, nonce: (current?.nonce ?? 0) + 1 }));
  }, []);
  const value = useMemo(() => ({ intent, request }), [intent, request]);
  return <ThreadsIntentContext.Provider value={value}>{children}</ThreadsIntentContext.Provider>;
}

export function useThreadsIntent(): ThreadsIntentValue {
  const value = useContext(ThreadsIntentContext);
  if (!value) throw new Error("useThreadsIntent must be used inside <ThreadsIntentProvider>");
  return value;
}
