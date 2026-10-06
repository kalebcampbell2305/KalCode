/**
 * What a live update keeps across a renderer reload (Level 1) or a core handoff (Level 3).
 * Canonical state (layout, terminals, agents, workspaces, settings) already lives in the native
 * stores and survives on its own; this only carries what exists solely in the page: the place the
 * person was looking at and text they typed but haven't sent.
 */

export interface DraftSnapshot {
  key: string;
  value: string;
}

export interface LiveSnapshot {
  version: 1;
  /** Unix milliseconds. */
  savedAt: number;
  destination: string | null;
  drafts: DraftSnapshot[];
}

/** A reload keeps its snapshot in sessionStorage; a handoff crosses processes in localStorage. */
export const RELOAD_KEY = "kalcode.liveUpdate.reload";
export const HANDOFF_KEY = "kalcode.liveUpdate.handoff";
/** A snapshot older than this belongs to some other session and is ignored. */
export const SNAPSHOT_MAX_AGE_MS = 10 * 60 * 1000;
const MAX_DRAFTS = 50;
const MAX_DRAFT_LENGTH = 100_000;

const EDITABLE = "textarea, input:not([type]), input[type='text'], input[type='search'], input[type='url']";

/** A stable name for an editable field, or null when it has none worth restoring into. */
function draftKey(element: HTMLInputElement | HTMLTextAreaElement): string | null {
  // xterm's hidden input and secrets are never drafts.
  if (element.classList.contains("xterm-helper-textarea") || element.closest(".xterm")) return null;
  if (element.readOnly || element.disabled) return null;
  const name =
    element.dataset.draftKey ||
    element.id ||
    element.getAttribute("name") ||
    element.getAttribute("aria-label") ||
    element.getAttribute("placeholder");
  return name ? `${element.tagName.toLowerCase()}:${name}` : null;
}

/** Disambiguates fields that share a name by their order in the document. */
function keyedFields(root: ParentNode): Array<[string, HTMLInputElement | HTMLTextAreaElement]> {
  const seen = new Map<string, number>();
  const result: Array<[string, HTMLInputElement | HTMLTextAreaElement]> = [];
  for (const element of root.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(EDITABLE)) {
    const base = draftKey(element);
    if (!base) continue;
    const index = seen.get(base) ?? 0;
    seen.set(base, index + 1);
    result.push([`${base}#${index}`, element]);
  }
  return result;
}

export function captureSnapshot(destination: string | null, root: ParentNode = document): LiveSnapshot {
  const drafts: DraftSnapshot[] = [];
  for (const [key, element] of keyedFields(root)) {
    if (!element.value || element.value.length > MAX_DRAFT_LENGTH) continue;
    drafts.push({ key, value: element.value });
    if (drafts.length >= MAX_DRAFTS) break;
  }
  return { version: 1, savedAt: Date.now(), destination, drafts };
}

function storage(kind: "session" | "local"): Storage | null {
  try {
    return kind === "session" ? window.sessionStorage : window.localStorage;
  } catch {
    return null;
  }
}

export function saveSnapshot(key: string, snapshot: LiveSnapshot): void {
  const store = storage(key === RELOAD_KEY ? "session" : "local");
  try {
    store?.setItem(key, JSON.stringify(snapshot));
  } catch {
    // Storage full or blocked: the update still applies, only drafts aren't carried over.
  }
}

function isSnapshot(value: unknown): value is LiveSnapshot {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<LiveSnapshot>;
  return (
    candidate.version === 1 &&
    typeof candidate.savedAt === "number" &&
    (candidate.destination === null || typeof candidate.destination === "string") &&
    Array.isArray(candidate.drafts) &&
    candidate.drafts.every((draft) => typeof draft?.key === "string" && typeof draft?.value === "string")
  );
}

/** Reads and removes the newest fresh snapshot (a reload's or a handoff's), if any. */
export function takeSnapshot(now = Date.now()): LiveSnapshot | null {
  let newest: LiveSnapshot | null = null;
  for (const key of [RELOAD_KEY, HANDOFF_KEY]) {
    const store = storage(key === RELOAD_KEY ? "session" : "local");
    let raw: string | null = null;
    try {
      raw = store?.getItem(key) ?? null;
      store?.removeItem(key);
    } catch {
      raw = null;
    }
    if (!raw) continue;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (isSnapshot(parsed) && now - parsed.savedAt <= SNAPSHOT_MAX_AGE_MS && parsed.savedAt <= now + 60_000) {
        if (!newest || parsed.savedAt > newest.savedAt) newest = parsed;
      }
    } catch {
      // A damaged snapshot is dropped.
    }
  }
  return newest;
}

/** Sets a field's value so React's controlled-input state sees it as typed. */
function typeInto(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
  if (setter) setter.call(element, value);
  else element.value = value;
  element.dispatchEvent(new Event("input", { bubbles: true }));
}

/**
 * Puts drafts back into their fields as those fields appear (surfaces mount progressively after a
 * reload). A field the person already typed into is left alone. Returns a function that stops
 * waiting; waiting also ends by itself after `timeoutMs`.
 */
export function restoreDrafts(drafts: DraftSnapshot[], root: ParentNode = document, timeoutMs = 15_000): () => void {
  const pending = new Map(drafts.map((draft) => [draft.key, draft.value]));
  if (pending.size === 0) return () => undefined;
  const apply = () => {
    for (const [key, element] of keyedFields(root)) {
      const value = pending.get(key);
      if (value === undefined) continue;
      if (!element.value) typeInto(element, value);
      pending.delete(key);
    }
    if (pending.size === 0) stop();
  };
  const observer = typeof MutationObserver === "undefined" ? null : new MutationObserver(apply);
  const timer = setTimeout(() => stop(), timeoutMs);
  function stop() {
    observer?.disconnect();
    clearTimeout(timer);
  }
  observer?.observe(root instanceof Document ? root.body : (root as Node), { childList: true, subtree: true });
  apply();
  return stop;
}
