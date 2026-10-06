import { useCallback, useEffect, useMemo, useRef, useState } from "react";

export const DRAFT_STORAGE_KEY = "kalcode:drafts:v1:";
const MAX_DRAFTS = 100;
const MAX_DRAFT_CHARS = 65_536;
const MAX_SERIALIZED_CHARS = 524_288;
const MAX_SCOPE_ID_CHARS = 512;

export type DraftScope =
  | { kind: "new-thread"; viewerId: string; workspaceId: string }
  | { kind: "thread"; viewerId: string; workspaceId: string; threadId: string };

interface PersistedDraft {
  kind: DraftScope["kind"];
  viewerId: string;
  workspaceId: string;
  threadId?: string;
  text: string;
  updatedAt: number;
}

interface PersistedDrafts {
  version: 1;
  entries: PersistedDraft[];
}

type StorageAccess = () => Pick<Storage, "getItem" | "setItem" | "removeItem">;

export type DraftPersistenceProblem = {
  code: "corrupt" | "too_large" | "unavailable";
  message: string;
};

export type DraftReadResult = { text: string; problem: DraftPersistenceProblem | null };
export type DraftWriteResult = { ok: boolean; problem: DraftPersistenceProblem | null };
export type DraftClearResult = { cleared: boolean; problem: DraftPersistenceProblem | null };

const CORRUPT_DRAFT: DraftPersistenceProblem = {
  code: "corrupt",
  message: "A saved draft couldn't be recovered. Edit the text to save a fresh copy.",
};
const OVERSIZED_DRAFT: DraftPersistenceProblem = {
  code: "too_large",
  message: "Draft not saved for restart because it is over 65,536 characters. Shorten it to retry.",
};
const UNAVAILABLE_DRAFT: DraftPersistenceProblem = {
  code: "unavailable",
  message: "Draft not saved for restart. Copy it somewhere safe, then free app storage and edit again to retry.",
};

function validId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_SCOPE_ID_CHARS;
}

function validEntry(value: unknown): value is PersistedDraft {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  if (
    (entry.kind !== "new-thread" && entry.kind !== "thread") ||
    !validId(entry.viewerId) ||
    !validId(entry.workspaceId) ||
    typeof entry.text !== "string" ||
    entry.text.length === 0 ||
    entry.text.length > MAX_DRAFT_CHARS ||
    !Number.isSafeInteger(entry.updatedAt) ||
    (entry.updatedAt as number) < 0
  ) {
    return false;
  }
  return entry.kind === "thread" ? validId(entry.threadId) : entry.threadId === undefined;
}

function scopeKey(scope: DraftScope): string {
  return JSON.stringify([
    scope.kind,
    scope.viewerId,
    scope.workspaceId,
    scope.kind === "thread" ? scope.threadId : null,
  ]);
}

/** Encode the verified KalCode viewer ID into an unambiguous per-account profile key. */
export function draftStorageKey(viewerId: string): string {
  return `${DRAFT_STORAGE_KEY}${encodeURIComponent(viewerId)}`;
}

function validScope(scope: DraftScope): boolean {
  return (
    validId(scope.viewerId) && validId(scope.workspaceId) && (scope.kind === "new-thread" || validId(scope.threadId))
  );
}

function parse(raw: string | null): { entries: PersistedDraft[]; problem: DraftPersistenceProblem | null } {
  if (!raw) return { entries: [], problem: null };
  try {
    const value = JSON.parse(raw) as Partial<PersistedDrafts>;
    if (value.version !== 1 || !Array.isArray(value.entries)) return { entries: [], problem: CORRUPT_DRAFT };
    const byScope = new Map<string, PersistedDraft>();
    let corrupt = false;
    for (const entry of value.entries) {
      if (!validEntry(entry)) {
        corrupt = true;
        continue;
      }
      const scope: DraftScope =
        entry.kind === "thread"
          ? {
              kind: "thread",
              viewerId: entry.viewerId,
              workspaceId: entry.workspaceId,
              threadId: entry.threadId as string,
            }
          : { kind: "new-thread", viewerId: entry.viewerId, workspaceId: entry.workspaceId };
      const key = scopeKey(scope);
      const existing = byScope.get(key);
      if (!existing || entry.updatedAt >= existing.updatedAt) byScope.set(key, entry);
    }
    return {
      entries: [...byScope.values()].sort((left, right) => left.updatedAt - right.updatedAt).slice(-MAX_DRAFTS),
      problem: corrupt ? CORRUPT_DRAFT : null,
    };
  } catch {
    return { entries: [], problem: CORRUPT_DRAFT };
  }
}

/**
 * Drafts live in the signed-in viewer's WebView profile and contain user-entered text plus stable
 * IDs only. The store never reads or captures provider handles, credentials or session material.
 */
export function createDraftStore(storage: StorageAccess) {
  const readEntries = (viewerId: string): { entries: PersistedDraft[]; problem: DraftPersistenceProblem | null } => {
    try {
      return parse(storage().getItem(draftStorageKey(viewerId)));
    } catch {
      return { entries: [], problem: UNAVAILABLE_DRAFT };
    }
  };

  const read = (scope: DraftScope): DraftReadResult => {
    if (!validScope(scope)) return { text: "", problem: CORRUPT_DRAFT };
    const { entries, problem } = readEntries(scope.viewerId);
    const key = scopeKey(scope);
    const found = entries.find((entry) => {
      const entryScope: DraftScope =
        entry.kind === "thread"
          ? {
              kind: "thread",
              viewerId: entry.viewerId,
              workspaceId: entry.workspaceId,
              threadId: entry.threadId as string,
            }
          : { kind: "new-thread", viewerId: entry.viewerId, workspaceId: entry.workspaceId };
      return scopeKey(entryScope) === key;
    });
    return { text: found?.text ?? "", problem };
  };

  const write = (scope: DraftScope, text: string): DraftWriteResult => {
    if (!validScope(scope)) return { ok: false, problem: CORRUPT_DRAFT };
    if (text.length > MAX_DRAFT_CHARS) return { ok: false, problem: OVERSIZED_DRAFT };
    const loaded = readEntries(scope.viewerId);
    if (loaded.problem?.code === "unavailable") return { ok: false, problem: loaded.problem };
    const key = scopeKey(scope);
    let entries = loaded.entries.filter((entry) => {
      const entryScope: DraftScope =
        entry.kind === "thread"
          ? {
              kind: "thread",
              viewerId: entry.viewerId,
              workspaceId: entry.workspaceId,
              threadId: entry.threadId as string,
            }
          : { kind: "new-thread", viewerId: entry.viewerId, workspaceId: entry.workspaceId };
      return scopeKey(entryScope) !== key;
    });
    if (text !== "") {
      entries.push({ ...scope, text, updatedAt: Date.now() });
      entries = entries.slice(-MAX_DRAFTS);
    }

    let serialized = JSON.stringify({ version: 1, entries } satisfies PersistedDrafts);
    while (serialized.length > MAX_SERIALIZED_CHARS && entries.length > 1) {
      entries = entries.slice(1);
      serialized = JSON.stringify({ version: 1, entries } satisfies PersistedDrafts);
    }
    if (serialized.length > MAX_SERIALIZED_CHARS) return { ok: false, problem: OVERSIZED_DRAFT };

    try {
      const target = storage();
      const key = draftStorageKey(scope.viewerId);
      if (entries.length === 0) {
        try {
          target.removeItem(key);
        } catch {
          // Some WebViews can refuse removal while still accepting a tiny replacement value.
          // An empty envelope prevents successfully submitted text from returning on restart.
          target.setItem(key, serialized);
        }
      } else {
        target.setItem(key, serialized);
      }
      return { ok: true, problem: null };
    } catch {
      return { ok: false, problem: UNAVAILABLE_DRAFT };
    }
  };

  return { read, write };
}

let shared: ReturnType<typeof createDraftStore> | undefined;
function sharedDraftStore() {
  shared ??= createDraftStore(() => localStorage);
  return shared;
}

/**
 * A controlled draft that hydrates synchronously and persists on each edit. Loading never submits
 * anything. `clearSubmitted` uses the exact captured text so an edit made while a send is pending
 * remains both on screen and in profile storage.
 */
export function usePersistentDraft(scope: DraftScope | null) {
  const store = sharedDraftStore();
  const key = scope ? scopeKey(scope) : null;
  const hydrated = useMemo<DraftReadResult>(
    () => (scope ? store.read(scope) : { text: "", problem: null }),
    [scope, store],
  );
  const [state, setState] = useState(() => ({ key, text: hydrated.text, problem: hydrated.problem }));
  const current = state.key === key ? state : { key, text: hydrated.text, problem: hydrated.problem };
  const text = current.text;
  const latest = useRef({ key, text });
  latest.current = { key, text };

  useEffect(() => {
    setState((current) => (current.key === key ? current : { key, text: hydrated.text, problem: hydrated.problem }));
  }, [hydrated, key]);

  const setText = useCallback(
    (next: string) => {
      latest.current = { key, text: next };
      const result = scope ? store.write(scope, next) : { ok: true, problem: null };
      setState({ key, text: next, problem: result.problem });
    },
    [key, scope, store],
  );

  const clearSubmitted = useCallback(
    (submitted: string): DraftClearResult => {
      if (latest.current.key !== key || latest.current.text !== submitted) {
        return { cleared: false, problem: null };
      }
      latest.current = { key, text: "" };
      const result = scope ? store.write(scope, "") : { ok: true, problem: null };
      setState({ key, text: "", problem: result.problem });
      return { cleared: true, problem: result.problem };
    },
    [key, scope, store],
  );

  return { text, setText, clearSubmitted, problem: current.problem };
}
