/**
 * The Code surface's compact view of the active project's Unified Memory: counts, the pinned
 * notes, and an instant inline filter. Reads the canonical store (`unified_memory_list`); keeps
 * no copy of its own beyond what the open popover shows.
 */
import type { MemoryCategory, MemoryRecord } from "@kalcode/protocol";

export const CATEGORY_LABEL: Record<MemoryCategory, string> = {
  project: "Project",
  decisions: "Decision",
  architecture: "Architecture",
  conventions: "Convention",
  product: "Product",
  recent_context: "Recent context",
  known_issues: "Known issue",
};

/** How many notes the popover lists before pointing to Unified Memory for the rest. */
export const VISIBLE_LIMIT = 6;

export interface ProjectMemoryView {
  total: number;
  pinned: number;
  /** Notes whose linked file changed; agents don't receive them until reviewed. */
  stale: number;
  /** What the popover lists: matches for a query, otherwise pinned first, then the newest. */
  shown: MemoryRecord[];
  /** Matching (or listable) notes beyond `shown`. */
  more: number;
  /** The heading over `shown`. */
  heading: "Pinned" | "Recent" | "Pinned and recent" | "Matches";
}

const newestFirst = (a: MemoryRecord, b: MemoryRecord) => b.updatedAt.localeCompare(a.updatedAt);

export function projectMemoryView(records: readonly MemoryRecord[], query: string): ProjectMemoryView {
  const total = records.length;
  const pinned = records.filter((r) => r.pinned).length;
  const stale = records.filter((r) => r.stale).length;
  const needle = query.trim().toLowerCase();
  let list: MemoryRecord[];
  let heading: ProjectMemoryView["heading"];
  if (needle) {
    const words = needle.split(/\s+/);
    list = records
      .filter((r) => {
        const text = `${r.title} ${r.content} ${CATEGORY_LABEL[r.category]} ${r.filePath ?? ""}`.toLowerCase();
        return words.every((word) => text.includes(word));
      })
      .sort((a, b) => Number(b.pinned) - Number(a.pinned) || newestFirst(a, b));
    heading = "Matches";
  } else {
    const pins = records.filter((r) => r.pinned).sort(newestFirst);
    const rest = records.filter((r) => !r.pinned).sort(newestFirst);
    list = [...pins, ...rest];
    heading =
      pins.length === 0 ? "Recent" : pins.length >= VISIBLE_LIMIT || rest.length === 0 ? "Pinned" : "Pinned and recent";
  }
  const shown = list.slice(0, VISIBLE_LIMIT);
  return { total, pinned, stale, shown, more: list.length - shown.length, heading };
}

/** "12 notes · 3 pinned": real counts, zero pins left out. */
export function memoryCountLine(view: Pick<ProjectMemoryView, "total" | "pinned">): string {
  if (view.total === 0) return "No notes yet";
  const notes = `${view.total} ${view.total === 1 ? "note" : "notes"}`;
  return view.pinned > 0 ? `${notes} · ${view.pinned} pinned` : notes;
}

/**
 * What a new agent in this project receives, stated truthfully: automatic provider context is a
 * Pro capability and the workspace can pause sharing (see docs/UNIFIED-MEMORY.md).
 */
export function sharingLine(automatic: boolean, sharingEnabled: boolean | null): string {
  if (!automatic) return "Saved on this device. Sharing notes with agents is included with Pro.";
  if (sharingEnabled === false) return "Sharing with agents is paused for this project.";
  return "Every provider's agents receive pinned notes and context relevant to their task.";
}
