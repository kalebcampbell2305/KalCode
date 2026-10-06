/**
 * Terminal Organization preferences, remembered per workspace in this window's storage (like the
 * canvas focus): grouping on or off, collapsed groups, pinned items, moved items, added groups and
 * whether the stack is open. Storage can be missing or full; every read falls back to the defaults
 * and every write is best effort.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { DEFAULT_PREFS, isAutoGroup, type OrgPrefs } from "./model.ts";

const storageKey = (workspaceId: string) => `kalcode.code.organization.${workspaceId}`;

/** Each list keeps its newest entries (appended last), so new pins and moves always survive. */
export const MAX_ITEMS = 500;
const MAX_GROUP_NAME = 40;

const strings = (value: unknown): string[] =>
  Array.isArray(value)
    ? [...new Set(value.filter((v): v is string => typeof v === "string" && v.length > 0))].slice(-MAX_ITEMS)
    : [];

/** Bounds the stored lists to their newest `MAX_ITEMS` entries. */
function capped(prefs: OrgPrefs): OrgPrefs {
  const entries = Object.entries(prefs.groupOf);
  return {
    ...prefs,
    collapsedGroups: prefs.collapsedGroups.slice(-MAX_ITEMS),
    pinned: prefs.pinned.slice(-MAX_ITEMS),
    groupOf: entries.length > MAX_ITEMS ? Object.fromEntries(entries.slice(-MAX_ITEMS)) : prefs.groupOf,
    customGroups: prefs.customGroups.slice(-MAX_ITEMS),
  };
}

/** A group name the person typed: trimmed, short, and never empty. */
export function cleanGroupName(name: string): string | null {
  const clean = name.replace(/\s+/g, " ").trim().slice(0, MAX_GROUP_NAME);
  return clean.length > 0 ? clean : null;
}

/** Reads stored preferences, keeping only well-formed values. */
export function parsePrefs(raw: string | null): OrgPrefs {
  if (!raw) return DEFAULT_PREFS;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return DEFAULT_PREFS;
  }
  if (!value || typeof value !== "object") return DEFAULT_PREFS;
  const v = value as Record<string, unknown>;
  const groupOf: Record<string, string> = {};
  if (v.groupOf && typeof v.groupOf === "object") {
    for (const [key, group] of Object.entries(v.groupOf as Record<string, unknown>).slice(-MAX_ITEMS)) {
      const name = typeof group === "string" ? cleanGroupName(group) : null;
      if (name) groupOf[key] = name;
    }
  }
  return {
    grouping: typeof v.grouping === "boolean" ? v.grouping : DEFAULT_PREFS.grouping,
    collapsedGroups: strings(v.collapsedGroups),
    pinned: strings(v.pinned),
    groupOf,
    customGroups: strings(v.customGroups)
      .map((g) => cleanGroupName(g))
      .filter((g): g is string => g !== null && !isAutoGroup(g)),
    stackOpen: typeof v.stackOpen === "boolean" ? v.stackOpen : null,
  };
}

function read(workspaceId: string): OrgPrefs {
  try {
    return parsePrefs(window.localStorage.getItem(storageKey(workspaceId)));
  } catch {
    return DEFAULT_PREFS;
  }
}

function write(workspaceId: string, prefs: OrgPrefs) {
  try {
    window.localStorage.setItem(storageKey(workspaceId), JSON.stringify(prefs));
  } catch {
    // Best effort: the preferences still apply for this session.
  }
}

const toggle = (list: readonly string[], value: string) =>
  list.includes(value) ? list.filter((v) => v !== value) : [...list, value];

export interface OrgPrefsApi {
  prefs: OrgPrefs;
  setGrouping: (on: boolean) => void;
  toggleGroup: (group: string) => void;
  togglePin: (key: string) => void;
  /** Moves an item to a group; its own purpose group when `group` is null. */
  moveTo: (key: string, group: string | null) => void;
  /** Adds a group and returns its cleaned name (null for an empty name). */
  addGroup: (name: string) => string | null;
  setStackOpen: (open: boolean) => void;
}

/** The workspace's organization preferences, persisted on every change. */
export function useOrgPrefs(workspaceId: string): OrgPrefsApi {
  const [prefs, setPrefs] = useState<OrgPrefs>(() => read(workspaceId));
  useEffect(() => setPrefs(read(workspaceId)), [workspaceId]);
  const update = useCallback(
    (change: (current: OrgPrefs) => OrgPrefs) =>
      setPrefs((current) => {
        const bounded = capped(change(current));
        write(workspaceId, bounded);
        return bounded;
      }),
    [workspaceId],
  );
  const setGrouping = useCallback((on: boolean) => update((p) => ({ ...p, grouping: on })), [update]);
  const toggleGroup = useCallback(
    (group: string) => update((p) => ({ ...p, collapsedGroups: toggle(p.collapsedGroups, group) })),
    [update],
  );
  const togglePin = useCallback((key: string) => update((p) => ({ ...p, pinned: toggle(p.pinned, key) })), [update]);
  const moveTo = useCallback(
    (key: string, group: string | null) =>
      update((p) => {
        const groupOf = { ...p.groupOf };
        // Re-added last, so the newest move is the one a bounded list keeps.
        delete groupOf[key];
        if (group !== null) groupOf[key] = group;
        return { ...p, groupOf };
      }),
    [update],
  );
  const addGroup = useCallback(
    (name: string) => {
      const clean = cleanGroupName(name);
      if (!clean) return null;
      update((p) =>
        isAutoGroup(clean) || p.customGroups.includes(clean) ? p : { ...p, customGroups: [...p.customGroups, clean] },
      );
      return clean;
    },
    [update],
  );
  const setStackOpen = useCallback((open: boolean) => update((p) => ({ ...p, stackOpen: open })), [update]);
  return useMemo(
    () => ({ prefs, setGrouping, toggleGroup, togglePin, moveTo, addGroup, setStackOpen }),
    [prefs, setGrouping, toggleGroup, togglePin, moveTo, addGroup, setStackOpen],
  );
}
