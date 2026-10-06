/**
 * Terminal Organization preferences, remembered per workspace in this window's storage (like the
 * canvas layout): grouping on or off, collapsed groups, pinned items, moved items, added and
 * renamed groups, the person's order of groups and items, and whether the stack is open. Storage
 * can be missing or full; every read falls back to the defaults and every write is best effort.
 *
 * Items are keyed by their pane content key and groups by stable ids, never by visible names.
 * Earlier versions keyed added groups by name; those read back as `custom:<name>` ids.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { type CustomGroup, DEFAULT_PREFS, isAutoGroup, type OrgPrefs } from "./model.ts";

const storageKey = (workspaceId: string) => `kalcode.code.organization.${workspaceId}`;

/** Each list keeps its newest entries (appended last), so new pins and moves always survive. */
export const MAX_ITEMS = 500;
/** Added groups are few; this only bounds a damaged store. */
const MAX_GROUPS = 100;
export const MAX_GROUP_NAME = 40;
const VERSION = 2;

const strings = (value: unknown): string[] =>
  Array.isArray(value)
    ? [...new Set(value.filter((v): v is string => typeof v === "string" && v.length > 0))].slice(-MAX_ITEMS)
    : [];

const record = (value: unknown): [string, unknown][] =>
  value && typeof value === "object" && !Array.isArray(value)
    ? Object.entries(value as Record<string, unknown>).slice(-MAX_ITEMS)
    : [];

/** Bounds the stored lists to their newest `MAX_ITEMS` entries. */
function capped(prefs: OrgPrefs): OrgPrefs {
  const entries = Object.entries(prefs.groupOf);
  return {
    ...prefs,
    collapsedGroups: prefs.collapsedGroups.slice(-MAX_ITEMS),
    pinned: prefs.pinned.slice(-MAX_ITEMS),
    groupOf: entries.length > MAX_ITEMS ? Object.fromEntries(entries.slice(-MAX_ITEMS)) : prefs.groupOf,
    customGroups: prefs.customGroups.slice(-MAX_GROUPS),
    groupOrder: prefs.groupOrder.slice(-MAX_ITEMS),
    itemOrder: prefs.itemOrder.slice(-MAX_ITEMS),
  };
}

/** A group name the person typed: trimmed, short, and never empty. */
export function cleanGroupName(name: string): string | null {
  const clean = name.replace(/\s+/g, " ").trim().slice(0, MAX_GROUP_NAME);
  return clean.length > 0 ? clean : null;
}

/** A new stable group id. */
export function newGroupId(): string {
  const random =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 10);
  return `g:${Date.now().toString(36)}${random}`;
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
  const legacy = v.version !== VERSION;

  const customGroups: CustomGroup[] = [];
  const addGroup = (id: string, name: string) => {
    if (!isAutoGroup(id) && !customGroups.some((g) => g.id === id)) customGroups.push({ id, name });
  };
  // Earlier versions named added groups and keyed moves and collapses by those names.
  const legacyId = (name: string) => {
    const clean = cleanGroupName(name);
    if (!clean) return null;
    if (isAutoGroup(clean)) return clean;
    addGroup(`custom:${clean}`, clean);
    return `custom:${clean}`;
  };
  if (legacy) {
    for (const name of strings(v.customGroups)) legacyId(name);
  } else if (Array.isArray(v.customGroups)) {
    for (const entry of v.customGroups.slice(-MAX_GROUPS)) {
      if (!entry || typeof entry !== "object") continue;
      const { id, name } = entry as Record<string, unknown>;
      const clean = typeof name === "string" ? cleanGroupName(name) : null;
      if (typeof id === "string" && id.length > 0 && clean) addGroup(id, clean);
    }
  }
  const known = (id: string) => isAutoGroup(id) || customGroups.some((g) => g.id === id);

  const groupOf: Record<string, string> = {};
  for (const [key, group] of record(v.groupOf)) {
    if (typeof group !== "string") continue;
    const id = legacy ? legacyId(group) : group;
    if (id && known(id)) groupOf[key] = id;
  }
  const groupLabels: Record<string, string> = {};
  for (const [id, name] of record(v.groupLabels)) {
    const clean = typeof name === "string" ? cleanGroupName(name) : null;
    if (isAutoGroup(id) && clean && clean !== id) groupLabels[id] = clean;
  }
  const collapsedGroups = strings(v.collapsedGroups)
    .map((g) => (legacy ? legacyId(g) : g))
    .filter((g): g is string => g !== null && known(g));
  return {
    grouping: typeof v.grouping === "boolean" ? v.grouping : DEFAULT_PREFS.grouping,
    collapsedGroups,
    pinned: strings(v.pinned),
    groupOf,
    customGroups,
    groupLabels,
    groupOrder: strings(v.groupOrder).filter(known),
    itemOrder: strings(v.itemOrder),
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
    window.localStorage.setItem(storageKey(workspaceId), JSON.stringify({ version: VERSION, ...prefs }));
  } catch {
    // Best effort: the preferences still apply for this session.
  }
}

const toggle = (list: readonly string[], value: string) =>
  list.includes(value) ? list.filter((v) => v !== value) : [...list, value];

export interface OrgPrefsApi {
  prefs: OrgPrefs;
  /** Applies any arrangement change (see `arrange.ts`) and persists it. */
  update: (change: (current: OrgPrefs) => OrgPrefs) => void;
  setGrouping: (on: boolean) => void;
  toggleGroup: (groupId: string) => void;
  /** Collapses or expands a group explicitly. */
  setCollapsed: (groupId: string, collapsed: boolean) => void;
  togglePin: (key: string) => void;
  /** Moves an item to a group by id; its own purpose group when `group` is null. */
  moveTo: (key: string, group: string | null) => void;
  /** Adds a group and returns its id (null for an empty name). */
  addGroup: (name: string) => string | null;
  /** Renames a group; a built-in group renamed to its own name goes back to it. */
  renameGroup: (groupId: string, name: string) => void;
  /** Removes an added group; its items go back to their purpose groups. */
  removeGroup: (groupId: string) => void;
  setStackOpen: (open: boolean) => void;
}

/** The workspace's organization preferences, persisted on every change. */
export function useOrgPrefs(workspaceId: string): OrgPrefsApi {
  const [prefs, setPrefs] = useState<OrgPrefs>(() => read(workspaceId));
  useEffect(() => setPrefs(read(workspaceId)), [workspaceId]);
  const update = useCallback(
    (change: (current: OrgPrefs) => OrgPrefs) =>
      setPrefs((current) => {
        const next = change(current);
        if (next === current) return current;
        const bounded = capped(next);
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
  const setCollapsed = useCallback(
    (group: string, collapsed: boolean) =>
      update((p) =>
        p.collapsedGroups.includes(group) === collapsed
          ? p
          : { ...p, collapsedGroups: toggle(p.collapsedGroups, group) },
      ),
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
      const id = newGroupId();
      update((p) => ({ ...p, customGroups: [...p.customGroups, { id, name: clean }] }));
      return id;
    },
    [update],
  );
  const renameGroup = useCallback(
    (groupId: string, name: string) => {
      const clean = cleanGroupName(name);
      if (!clean) return;
      update((p) => {
        if (isAutoGroup(groupId)) {
          const groupLabels = { ...p.groupLabels };
          if (clean === groupId) delete groupLabels[groupId];
          else groupLabels[groupId] = clean;
          return { ...p, groupLabels };
        }
        if (!p.customGroups.some((g) => g.id === groupId)) return p;
        return { ...p, customGroups: p.customGroups.map((g) => (g.id === groupId ? { ...g, name: clean } : g)) };
      });
    },
    [update],
  );
  const removeGroup = useCallback(
    (groupId: string) =>
      update((p) => {
        if (isAutoGroup(groupId)) {
          const groupLabels = { ...p.groupLabels };
          delete groupLabels[groupId];
          return { ...p, groupLabels };
        }
        return {
          ...p,
          customGroups: p.customGroups.filter((g) => g.id !== groupId),
          groupOf: Object.fromEntries(Object.entries(p.groupOf).filter(([, g]) => g !== groupId)),
          collapsedGroups: p.collapsedGroups.filter((g) => g !== groupId),
          groupOrder: p.groupOrder.filter((g) => g !== groupId),
        };
      }),
    [update],
  );
  const setStackOpen = useCallback((open: boolean) => update((p) => ({ ...p, stackOpen: open })), [update]);
  return useMemo(
    () => ({
      prefs,
      update,
      setGrouping,
      toggleGroup,
      setCollapsed,
      togglePin,
      moveTo,
      addGroup,
      renameGroup,
      removeGroup,
      setStackOpen,
    }),
    [
      prefs,
      update,
      setGrouping,
      toggleGroup,
      setCollapsed,
      togglePin,
      moveTo,
      addGroup,
      renameGroup,
      removeGroup,
      setStackOpen,
    ],
  );
}
