import type { RailState } from "@kalcode/protocol";

/** Optimistic projection of the native rail's pin transaction; never sort pins by activity. */
export function projectPinChange(state: RailState, workspaceId: string, change: boolean | number): RailState {
  const all = [...state.pinned, ...state.recent, ...state.archived, ...state.groups.flatMap((g) => g.workspaces)];
  const entry = all.find((e) => e.workspaceId === workspaceId);
  if (!entry || (typeof change === "number" && !entry.pinned)) return state;
  if (typeof change === "boolean" && change === entry.pinned) return state;
  const without = (entries: typeof all) => entries.filter((e) => e.workspaceId !== workspaceId);
  const pinned = without(state.pinned);
  if (change !== false) {
    const index = typeof change === "number" ? Math.max(0, Math.min(change, pinned.length)) : pinned.length;
    pinned.splice(index, 0, { ...entry, pinned: true, archived: false });
  }
  const unpinned = { ...entry, pinned: false };
  return {
    ...state,
    pinned,
    recent: change === false && !entry.groupId ? [...state.recent, unpinned] : without(state.recent),
    archived: without(state.archived),
    groups: state.groups.map((g) => ({
      ...g,
      workspaces:
        change === false && entry.groupId === g.group.id ? [...g.workspaces, unpinned] : without(g.workspaces),
    })),
  };
}
