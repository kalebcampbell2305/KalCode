import type { PaneContent, PaneLayout, PaneNode } from "@kalcode/protocol";
import { contentKey, validateLayout } from "./model.ts";

const VERSION = 1;
const KEY_PREFIX = "kalcode:pane-layout-write-ahead:v1:";
const MAX_SCOPE_LENGTH = 4_096;
const MAX_RECORD_LENGTH = 128 * 1_024;
let sequence = 0;

interface StoredPendingLayout {
  version: typeof VERSION;
  scope: string;
  id: string;
  layout: PaneLayout;
}

export interface PendingLayout {
  id: string;
  layout: PaneLayout;
}

function scopeHash(scope: string): string {
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < scope.length; index++) {
    const code = scope.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193);
    second = Math.imul(second ^ code, 0x85ebca6b);
  }
  return `${(first >>> 0).toString(36)}-${(second >>> 0).toString(36)}`;
}

function storageKey(scope: string): string {
  return `${KEY_PREFIX}${scopeHash(scope)}`;
}

function withoutBrowserLocation(content: PaneContent): PaneContent {
  return content.kind === "browser" ? { ...content, url: null } : content;
}

function safeNode(node: PaneNode): PaneNode {
  if (node.kind === "leaf") return { ...node, tabs: node.tabs.map(withoutBrowserLocation) };
  return { ...node, children: node.children.map(safeNode) };
}

/**
 * Keep this recovery record intentionally small and non-secret. The native store remains the
 * layout authority; this record only bridges a crash between a UI mutation and its async write.
 */
export function writePendingLayout(scope: string, layout: PaneLayout): string | null {
  if (scope.length > MAX_SCOPE_LENGTH || validateLayout(layout) !== null) return null;
  const id = `${Date.now().toString(36)}-${(++sequence).toString(36)}`;
  const record: StoredPendingLayout = {
    version: VERSION,
    scope,
    id,
    layout: { ...layout, root: safeNode(layout.root), dock: layout.dock.map(withoutBrowserLocation) },
  };
  try {
    const serialized = JSON.stringify(record);
    if (serialized.length > MAX_RECORD_LENGTH) return null;
    localStorage.setItem(storageKey(scope), serialized);
    return id;
  } catch {
    return null;
  }
}

export function readPendingLayout(scope: string): PendingLayout | null {
  if (scope.length > MAX_SCOPE_LENGTH) return null;
  const key = storageKey(scope);
  try {
    const serialized = localStorage.getItem(key);
    if (!serialized || serialized.length > MAX_RECORD_LENGTH) return null;
    const value = JSON.parse(serialized) as Partial<StoredPendingLayout>;
    if (
      value.version !== VERSION ||
      value.scope !== scope ||
      typeof value.id !== "string" ||
      !value.layout ||
      validateLayout(value.layout) !== null
    )
      return null;
    return { id: value.id, layout: value.layout };
  } catch {
    return null;
  }
}

function visitContents(node: PaneNode, visit: (content: PaneContent) => void): void {
  if (node.kind === "leaf") {
    for (const content of node.tabs) visit(content);
    return;
  }
  for (const child of node.children) visitContents(child, visit);
}

/** Browser locations remain in the native authority and are joined back by their stable ID. */
export function hydratePendingLayout(pending: PaneLayout, canonical: PaneLayout): PaneLayout {
  const canonicalContents = new Map<string, PaneContent>();
  visitContents(canonical.root, (content) => canonicalContents.set(contentKey(content), content));
  for (const content of canonical.dock) canonicalContents.set(contentKey(content), content);
  const hydrate = (content: PaneContent): PaneContent => {
    if (content.kind !== "browser" || content.url !== null) return content;
    const match = canonicalContents.get(contentKey(content));
    return match?.kind === "browser" ? match : content;
  };
  const hydrateNode = (node: PaneNode): PaneNode => {
    if (node.kind === "leaf") return { ...node, tabs: node.tabs.map(hydrate) };
    return { ...node, children: node.children.map(hydrateNode) };
  };
  return { ...pending, root: hydrateNode(pending.root), dock: pending.dock.map(hydrate) };
}

/** A completed older write must never clear the recovery record for a newer layout. */
export function clearPendingLayout(scope: string, id: string): void {
  if (scope.length > MAX_SCOPE_LENGTH) return;
  const key = storageKey(scope);
  try {
    const serialized = localStorage.getItem(key);
    if (!serialized || serialized.length > MAX_RECORD_LENGTH) return;
    const value = JSON.parse(serialized) as Partial<StoredPendingLayout>;
    if (value.version === VERSION && value.scope === scope && value.id === id) localStorage.removeItem(key);
  } catch {
    // The native store already accepted the layout. A stale recovery record is safe to replay.
  }
}
