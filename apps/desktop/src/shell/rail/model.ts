/**
 * The workspace rail's pure model: which tree rows are visible for a rail state and the
 * expansion state, their ARIA levels, and small formatting helpers. Kept free of React so the
 * keyboard behaviour (roving focus over the visible rows) is unit-tested.
 */
import type {
  ProviderRow,
  RailGroupView,
  RailSection,
  RailState,
  RailThread,
  ThreadStatus,
  WorkspaceRailEntry,
} from "@kalcode/protocol";
import { displayStatusOf } from "@kalcode/protocol";

export type RailNode =
  | {
      kind: "section";
      key: string;
      section: RailSection;
      label: string;
      count: number;
      expanded: boolean;
      level: 1;
    }
  | {
      kind: "group";
      key: string;
      group: RailGroupView["group"];
      count: number;
      expanded: boolean;
      level: 2;
    }
  | {
      kind: "workspace";
      key: string;
      entry: WorkspaceRailEntry;
      expanded: boolean;
      hasChildren: boolean;
      level: 2 | 3;
      /** Where it sits (for Move up/down): the pinned list or a folder. */
      siblings: "pinned" | "group" | "recent" | "archived";
      index: number;
      siblingCount: number;
    }
  | {
      kind: "provider";
      key: string;
      workspaceId: string;
      row: ProviderRow;
      expanded: boolean;
      level: 3 | 4;
    }
  | {
      kind: "thread";
      key: string;
      workspaceId: string;
      thread: RailThread;
      level: 4 | 5;
    };

export const SECTION_LABEL: Record<Exclude<RailSection, "rail">, string> = {
  pinned: "Pinned",
  folders: "Folders",
  recent: "Recent",
  archived: "Archived",
};

/** Provider rows the person collapsed this session (not persisted; workspaces are). */
export type CollapsedProviders = ReadonlySet<string>;

export const providerKey = (workspaceId: string, providerId: string) => `${workspaceId}:${providerId}`;

/** Every visible row, top to bottom, for the tree's roving focus and rendering. */
export function visibleNodes(rail: RailState, collapsedProviders: CollapsedProviders = new Set()): RailNode[] {
  const collapsed = new Set(rail.collapsedSections);
  const nodes: RailNode[] = [];
  const pushWorkspace = (
    entry: WorkspaceRailEntry,
    level: 2 | 3,
    siblings: "pinned" | "group" | "recent" | "archived",
    index: number,
    siblingCount: number,
  ) => {
    const hasChildren = entry.providers.length > 0;
    const expanded = hasChildren && !entry.collapsed;
    nodes.push({
      kind: "workspace",
      key: `ws:${siblings}:${entry.workspaceId}`,
      entry,
      expanded,
      hasChildren,
      level,
      siblings,
      index,
      siblingCount,
    });
    if (!expanded) return;
    for (const row of entry.providers) {
      const key = providerKey(entry.workspaceId, row.providerId);
      const open = !collapsedProviders.has(key);
      nodes.push({
        kind: "provider",
        key: `pv:${key}`,
        workspaceId: entry.workspaceId,
        row,
        expanded: open,
        level: level === 2 ? 3 : 4,
      });
      if (!open) continue;
      for (const thread of row.items) {
        nodes.push({
          kind: "thread",
          key: `th:${thread.id}`,
          workspaceId: entry.workspaceId,
          thread,
          level: level === 2 ? 4 : 5,
        });
      }
    }
  };
  const section = (id: Exclude<RailSection, "rail">, count: number, body: () => void) => {
    if (count === 0 && id !== "recent") return;
    const expanded = !collapsed.has(id);
    nodes.push({ kind: "section", key: `sec:${id}`, section: id, label: SECTION_LABEL[id], count, expanded, level: 1 });
    if (expanded) body();
  };
  section("pinned", rail.pinned.length, () =>
    rail.pinned.forEach((e, i) => {
      pushWorkspace(e, 2, "pinned", i, rail.pinned.length);
    }),
  );
  const grouped = rail.groups.reduce((n, g) => n + g.workspaces.length, 0);
  section("folders", rail.groups.length === 0 ? 0 : Math.max(grouped, 1), () => {
    for (const view of rail.groups) {
      const expanded = !view.group.collapsed;
      nodes.push({
        kind: "group",
        key: `grp:${view.group.id}`,
        group: view.group,
        count: view.workspaces.length,
        expanded,
        level: 2,
      });
      if (expanded) {
        view.workspaces.forEach((e, i) => {
          pushWorkspace(e, 3, "group", i, view.workspaces.length);
        });
      }
    }
  });
  section("recent", rail.recent.length, () =>
    rail.recent.forEach((e, i) => {
      pushWorkspace(e, 2, "recent", i, rail.recent.length);
    }),
  );
  section("archived", rail.archived.length, () =>
    rail.archived.forEach((e, i) => {
      pushWorkspace(e, 2, "archived", i, rail.archived.length);
    }),
  );
  return nodes;
}

/** The row a Left key moves to: the nearest row above with a lower level. */
export function parentIndex(nodes: readonly RailNode[], index: number): number | null {
  const level = nodes[index]?.level;
  if (level === undefined) return null;
  for (let i = index - 1; i >= 0; i--) if ((nodes[i]?.level ?? 0) < level) return i;
  return null;
}

export function isExpandable(node: RailNode): boolean {
  return (
    node.kind === "section" ||
    node.kind === "group" ||
    node.kind === "provider" ||
    (node.kind === "workspace" && node.hasChildren)
  );
}

export function isExpanded(node: RailNode): boolean {
  return node.kind === "thread" ? false : node.expanded;
}

/** Every workspace in the rail, in display order (pinned, folders, recent, archived). */
export function allEntries(rail: RailState): WorkspaceRailEntry[] {
  return [...rail.pinned, ...rail.groups.flatMap((g) => g.workspaces), ...rail.recent, ...rail.archived];
}

/** Short relative time: "now", "5m", "3h", "2d", or a date. */
export function relativeTime(iso: string, now: number = Date.now()): string {
  const at = new Date(iso).getTime();
  if (!Number.isFinite(at)) return "";
  const minutes = Math.max(0, Math.round((now - at) / 60_000));
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d`;
  return new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** Spoken/accessible form of a rail workspace's badges. */
export function badgeLabel(entry: Pick<WorkspaceRailEntry, "working" | "needsYou" | "threads">): string {
  const parts: string[] = [];
  if (entry.needsYou > 0) parts.push(`${entry.needsYou} ${entry.needsYou === 1 ? "needs" : "need"} you`);
  if (entry.working > 0) parts.push(`${entry.working} working`);
  if (parts.length === 0 && entry.threads > 0)
    parts.push(`${entry.threads} ${entry.threads === 1 ? "thread" : "threads"}`);
  return parts.join(", ");
}

/** Accessible name of a thread row: name, status words, time. */
export function threadLabel(thread: RailThread, now: number = Date.now()): string {
  const info = displayStatusOf(thread.status, { resumable: thread.resumable === true });
  const qualifier =
    thread.status === "interrupted" && info.qualifierLabel ? ` (${info.qualifierLabel.replace(" · ", ", ")})` : "";
  return `${thread.name}, ${statusWords(thread.status)}${qualifier}, ${relativeTime(thread.lastActivityAt, now)}`;
}

export function statusWords(status: ThreadStatus): string {
  const words: Record<string, string> = {
    starting: "starting",
    working: "working",
    testing: "testing",
    reviewing: "reviewing",
    permission_required: "permission required",
    waiting_for_you: "waiting for you",
    idle: "idle",
    paused: "paused",
    done: "done",
    failed: "failed",
    recovering: "recovering",
    offline: "offline",
  };
  return words[displayStatusOf(status).status] ?? "idle";
}

/** First letter(s) for a workspace tile. */
export function initials(name: string): string {
  const words = name
    .replace(/[-_.]+/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  const first = words[0]?.[0] ?? "?";
  const second = words.length > 1 ? (words[1]?.[0] ?? "") : (words[0]?.[1] ?? "");
  return `${first}${second}`.toUpperCase();
}

/** `aria-posinset` / `aria-setsize` for each visible row (a flat tree needs them). */
export function positions(nodes: readonly RailNode[]): { posinset: number; setsize: number }[] {
  const out = nodes.map(() => ({ posinset: 1, setsize: 1 }));
  nodes.forEach((node, index) => {
    const parent = parentIndex(nodes, index);
    const siblings: number[] = [];
    for (let i = (parent ?? -1) + 1; i < nodes.length; i++) {
      const level = nodes[i]?.level ?? 0;
      if (level < node.level) break;
      if (level === node.level) siblings.push(i);
    }
    const at = siblings.indexOf(index);
    out[index] = { posinset: at + 1, setsize: siblings.length };
  });
  return out;
}
