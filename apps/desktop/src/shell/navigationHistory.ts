import type { PaneContent } from "@kalcode/protocol";
import type { Destination } from "./navigation.tsx";

export type NavigationTarget =
  | { kind: "pane"; content: PaneContent }
  | { kind: "thread"; threadId: string }
  | { kind: "provider"; tab: "setup" | "accounts" | "health"; sectionId?: string }
  | {
      kind: "operations";
      tab: "runs" | "queue" | "services" | "environments" | "activity";
      runId?: string;
      filterWorkspaceId?: string;
    }
  | { kind: "section"; sectionId: string };

export interface NavigationLocation {
  destination: Destination;
  workspaceId?: string;
  label?: string;
  target?: NavigationTarget;
}

export interface NavigationEntry extends NavigationLocation {
  id: number;
}

export interface NavigationHistory {
  entries: readonly NavigationEntry[];
  index: number;
  nextId: number;
}

const PERSISTED_VERSION = 1;
const MAX_HISTORY_ENTRIES = 200;
const MAX_ID_LENGTH = 1_024;
const MAX_LABEL_LENGTH = 256;
const MAX_ENTRY_ID = Number.MAX_SAFE_INTEGER - MAX_HISTORY_ENTRIES - 1;

interface PersistedNavigationHistory {
  version: typeof PERSISTED_VERSION;
  entries: readonly NavigationEntry[];
  index: number;
  nextId: number;
}

/** Encode the verified KalCode account ID into an unambiguous per-account storage key. */
export function navigationHistoryStorageKey(accountId: string): string {
  return `kalcode.navigationHistory.v${PERSISTED_VERSION}.${encodeURIComponent(accountId)}`;
}

/** Agent names are live session metadata; navigation keeps only the stable target identity. */
export function navigationEntryLabel(
  entry: NavigationEntry,
  agentNames: ReadonlyMap<string, string>,
): string | undefined {
  const target = entry.target;
  if (target?.kind === "pane" && target.content.kind === "agent") {
    return agentNames.get(target.content.agentId) ?? entry.label;
  }
  return entry.label;
}

function targetKey(target: NavigationTarget | undefined): string {
  if (!target) return "";
  if (target.kind === "section") return `section:${target.sectionId}`;
  if (target.kind === "thread") return `thread:${target.threadId}`;
  if (target.kind === "provider" || target.kind === "operations") return JSON.stringify(target);
  const content = target.content;
  // Browser URL updates are session state, not application navigation.
  if (content.kind === "browser") return `browser:${content.browserId}`;
  return JSON.stringify(content);
}

export function sameLocation(a: NavigationLocation, b: NavigationLocation): boolean {
  return (
    a.destination === b.destination && a.workspaceId === b.workspaceId && targetKey(a.target) === targetKey(b.target)
  );
}

export function initialHistory(destination: Destination): NavigationHistory {
  return { entries: [{ id: 0, destination }], index: 0, nextId: 1 };
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) if ((character.codePointAt(0) ?? 0) < 32) return true;
  return false;
}

function stableId(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_ID_LENGTH && !hasControlCharacter(value)
    ? value
    : undefined;
}

function displayLabel(value: unknown): string | undefined {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_LABEL_LENGTH &&
    !hasControlCharacter(value)
    ? value
    : undefined;
}

function paneContent(value: unknown): PaneContent | undefined {
  const item = record(value);
  if (!item || typeof item.kind !== "string") return undefined;
  switch (item.kind) {
    case "agent": {
      const agentId = stableId(item.agentId);
      return agentId ? { kind: "agent", agentId } : undefined;
    }
    case "thread": {
      const threadId = stableId(item.threadId);
      return threadId ? { kind: "thread", threadId } : undefined;
    }
    case "terminal": {
      const terminalId = stableId(item.terminalId);
      return terminalId ? { kind: "terminal", terminalId } : undefined;
    }
    case "dashboard":
      return { kind: "dashboard" };
    case "widget": {
      const widgetId = stableId(item.widgetId);
      return widgetId ? { kind: "widget", widgetId } : undefined;
    }
    case "browser": {
      const browserId = stableId(item.browserId);
      // Browser navigation owns URLs. Recent application navigation stores only pane identity.
      return browserId ? { kind: "browser", browserId, url: null } : undefined;
    }
    case "git": {
      const workspaceId = stableId(item.workspaceId);
      return workspaceId ? { kind: "git", workspaceId } : undefined;
    }
    default:
      return undefined;
  }
}

function navigationTarget(value: unknown): NavigationTarget | undefined {
  const item = record(value);
  if (!item || typeof item.kind !== "string") return undefined;
  switch (item.kind) {
    case "pane": {
      const content = paneContent(item.content);
      return content ? { kind: "pane", content } : undefined;
    }
    case "thread": {
      const threadId = stableId(item.threadId);
      return threadId ? { kind: "thread", threadId } : undefined;
    }
    case "provider": {
      if (item.tab !== "setup" && item.tab !== "accounts" && item.tab !== "health") return undefined;
      const sectionId = item.sectionId === undefined ? undefined : stableId(item.sectionId);
      if (item.sectionId !== undefined && sectionId === undefined) return undefined;
      return { kind: "provider", tab: item.tab, ...(sectionId ? { sectionId } : {}) };
    }
    case "operations": {
      if (
        item.tab !== "runs" &&
        item.tab !== "queue" &&
        item.tab !== "services" &&
        item.tab !== "environments" &&
        item.tab !== "activity"
      )
        return undefined;
      const runId = item.runId === undefined ? undefined : stableId(item.runId);
      const filterWorkspaceId = item.filterWorkspaceId === undefined ? undefined : stableId(item.filterWorkspaceId);
      if (
        (item.runId !== undefined && runId === undefined) ||
        (item.filterWorkspaceId !== undefined && filterWorkspaceId === undefined)
      )
        return undefined;
      return {
        kind: "operations",
        tab: item.tab,
        ...(runId ? { runId } : {}),
        ...(filterWorkspaceId ? { filterWorkspaceId } : {}),
      };
    }
    case "section": {
      const sectionId = stableId(item.sectionId);
      return sectionId ? { kind: "section", sectionId } : undefined;
    }
    default:
      return undefined;
  }
}

function targetMatchesDestination(destination: Destination, target: NavigationTarget): boolean {
  if (target.kind === "pane") return destination === "code";
  if (target.kind === "thread") return destination === "threads";
  if (target.kind === "provider") return destination === "providers";
  if (target.kind === "operations") return destination === "operations";
  return true;
}

function navigationEntry(value: unknown, visible: ReadonlySet<Destination>): NavigationEntry | undefined {
  const item = record(value);
  if (
    !item ||
    !Number.isSafeInteger(item.id) ||
    (item.id as number) < 0 ||
    (item.id as number) > MAX_ENTRY_ID ||
    typeof item.destination !== "string" ||
    !visible.has(item.destination as Destination)
  )
    return undefined;
  const workspaceId = item.workspaceId === undefined ? undefined : stableId(item.workspaceId);
  const label = item.label === undefined ? undefined : displayLabel(item.label);
  if (
    (item.workspaceId !== undefined && workspaceId === undefined) ||
    (item.label !== undefined && label === undefined)
  )
    return undefined;
  const target = item.target === undefined ? undefined : navigationTarget(item.target);
  return {
    id: item.id as number,
    destination: item.destination as Destination,
    ...(workspaceId ? { workspaceId } : {}),
    ...(label ? { label } : {}),
    ...(target && targetMatchesDestination(item.destination as Destination, target) ? { target } : {}),
  };
}

function sanitizeEntries(values: readonly unknown[], visible: ReadonlySet<Destination>): readonly NavigationEntry[] {
  const entries: NavigationEntry[] = [];
  const ids = new Set<number>();
  for (const value of values.slice(-MAX_HISTORY_ENTRIES)) {
    const entry = navigationEntry(value, visible);
    if (!entry || ids.has(entry.id)) continue;
    ids.add(entry.id);
    entries.push(entry);
  }
  return entries;
}

/** Parse local storage as untrusted input and project it onto stable, visible navigation identities. */
export function parsePersistedNavigationHistory(
  value: unknown,
  visible: ReadonlySet<Destination>,
): NavigationHistory | null {
  const item = record(value);
  if (
    !item ||
    item.version !== PERSISTED_VERSION ||
    !Array.isArray(item.entries) ||
    !Number.isInteger(item.index) ||
    !Number.isSafeInteger(item.nextId) ||
    (item.nextId as number) < 1 ||
    (item.index as number) < 0 ||
    (item.index as number) >= item.entries.length
  )
    return null;
  const current = record(item.entries[item.index as number]);
  const currentId = Number.isSafeInteger(current?.id) ? (current?.id as number) : null;
  const entries = sanitizeEntries(item.entries, visible);
  if (entries.length === 0) return null;
  const restoredIndex = currentId === null ? -1 : entries.findIndex((entry) => entry.id === currentId);
  const index = restoredIndex >= 0 ? restoredIndex : entries.length - 1;
  const nextId = Math.max(...entries.map((entry) => entry.id)) + 1;
  return { entries, index, nextId };
}

export function readNavigationHistory(
  storage: Pick<Storage, "getItem">,
  storageKey: string,
  visible: ReadonlySet<Destination>,
): NavigationHistory | null {
  try {
    const raw = storage.getItem(storageKey);
    return raw === null ? null : parsePersistedNavigationHistory(JSON.parse(raw) as unknown, visible);
  } catch {
    return null;
  }
}

/** Persist only the allowlisted model. Runtime handles, extra fields and Browser URLs are discarded. */
export function writeNavigationHistory(
  storage: Pick<Storage, "setItem">,
  storageKey: string,
  state: NavigationHistory,
  visible: ReadonlySet<Destination>,
): void {
  const entries = sanitizeEntries(state.entries, visible);
  if (entries.length === 0) return;
  const currentId = state.entries[state.index]?.id;
  const restoredIndex = entries.findIndex((entry) => entry.id === currentId);
  const index = restoredIndex >= 0 ? restoredIndex : entries.length - 1;
  const payload: PersistedNavigationHistory = {
    version: PERSISTED_VERSION,
    entries,
    index,
    nextId: Math.max(...entries.map((entry) => entry.id)) + 1,
  };
  try {
    storage.setItem(storageKey, JSON.stringify(payload));
  } catch {
    // Navigation remains fully usable when local storage is unavailable or full.
  }
}

/** Bounded, chronological history. A new visit after Back discards the forward branch. */
export function visitLocation(state: NavigationHistory, location: NavigationLocation): NavigationHistory {
  const current = state.entries[state.index];
  if (current && sameLocation(current, location)) {
    if (!location.label || location.label === current.label) return state;
    const entries = [...state.entries];
    entries[state.index] = { ...current, label: location.label };
    return { ...state, entries };
  }
  // A surface initially opens before its focused pane/section has rendered. Enrich that
  // visit rather than forcing the user through a duplicate, empty surface on Back.
  if (
    current &&
    current.destination === location.destination &&
    !current.target &&
    (!current.workspaceId || current.workspaceId === location.workspaceId)
  ) {
    const entries = [...state.entries];
    entries[state.index] = { ...location, id: current.id };
    return { ...state, entries };
  }
  const entries = [...state.entries.slice(0, state.index + 1), { ...location, id: state.nextId }].slice(
    -MAX_HISTORY_ENTRIES,
  );
  return { entries, index: entries.length - 1, nextId: state.nextId + 1 };
}
