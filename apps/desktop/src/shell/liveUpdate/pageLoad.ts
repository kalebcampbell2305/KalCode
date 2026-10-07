/**
 * Whether this page load is a cold start of KalCode or a reload of the same window (a live UI
 * update reloads only the renderer while the shell keeps running). Renderer-local state is reset
 * by both, so features that remember "already tried" in the page (for example an automatic resume
 * that failed) use this to avoid repeating, after a reload, what they did before it.
 *
 * sessionStorage lives as long as the window, across reloads, and is empty in a new process.
 */
const SESSION_MARK = "kalcode.page.session";

export type PageLoadKind = "cold" | "reload";

function detect(): PageLoadKind {
  try {
    const storage = window.sessionStorage;
    const kind: PageLoadKind = storage.getItem(SESSION_MARK) ? "reload" : "cold";
    storage.setItem(SESSION_MARK, "1");
    return kind;
  } catch {
    return "cold";
  }
}

let kind: PageLoadKind | null = null;

/** Decided once, at the first call in this page. */
export function pageLoadKind(): PageLoadKind {
  kind ??= detect();
  return kind;
}

/** Test helper. */
export function resetPageLoadKind(): void {
  kind = null;
}

/**
 * A set of ids that lasts as long as this window: it survives renderer reloads (a live UI update)
 * and starts empty in a new KalCode process. For "already tried" bookkeeping that a reload must
 * not reset, such as automatic recovery attempts. Ids are opaque and capped.
 */
export function windowSet(name: string, limit = 500) {
  const key = `kalcode.window.${name}`;
  const read = (): string[] => {
    try {
      const value: unknown = JSON.parse(window.sessionStorage.getItem(key) ?? "[]");
      return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [];
    } catch {
      return [];
    }
  };
  const write = (ids: string[]) => {
    try {
      window.sessionStorage.setItem(key, JSON.stringify(ids.slice(-limit)));
    } catch {
      // Storage unavailable: the set is in-page only, as before.
    }
  };
  let ids = new Set(read());
  return {
    has: (id: string) => ids.has(id),
    add(id: string) {
      if (ids.has(id)) return;
      ids.add(id);
      write([...ids]);
    },
    delete(id: string) {
      if (!ids.delete(id)) return;
      write([...ids]);
    },
    /** Re-reads storage (tests). */
    reload() {
      ids = new Set(read());
    },
  };
}
