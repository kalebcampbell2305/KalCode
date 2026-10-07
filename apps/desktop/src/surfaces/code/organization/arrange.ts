/**
 * Arranging the Terminal Stack: reordering items, moving them between groups and reordering
 * groups. Pure changes to the organization preferences (display metadata only): an item keeps
 * its terminal or coding-agent session, provider, account, model and worktree wherever it goes.
 */
import { ALL_GROUP, groupIdsInOrder, type OrgItem, type OrgPrefs, type StackGroup } from "./model.ts";

/** Moves `value` before `before` in `list` (to the end when `before` is null or missing). */
export function placeBefore(list: readonly string[], value: string, before: string | null): string[] {
  const rest = list.filter((v) => v !== value);
  const index = before === null ? -1 : rest.indexOf(before);
  if (index === -1) return [...rest, value];
  return [...rest.slice(0, index), value, ...rest.slice(index)];
}

/**
 * Moves an item into a group, before another member (at the end when `before` is null). The
 * target group's whole order is recorded, so the arrangement the person sees is exactly the one
 * that persists. Moving an item back to its own purpose group clears the move.
 */
export function moveItem(
  prefs: OrgPrefs,
  groups: readonly StackGroup[],
  item: OrgItem,
  toGroup: string,
  before: string | null,
): OrgPrefs {
  // A built-in group that is empty right now isn't shown, but it can still take an item.
  const members = groups.find((g) => g.id === toGroup)?.members ?? [];
  const order = placeBefore(
    members.map((m) => m.key),
    item.key,
    before === item.key ? null : before,
  );
  const arranged = new Set(order);
  // Re-appended last, so the newest arrangement is what a bounded list keeps.
  const itemOrder = [...prefs.itemOrder.filter((key) => !arranged.has(key)), ...order];
  if (toGroup === ALL_GROUP) return { ...prefs, itemOrder };
  const groupOf = { ...prefs.groupOf };
  delete groupOf[item.key];
  if (toGroup !== item.group) groupOf[item.key] = toGroup;
  return { ...prefs, groupOf, itemOrder };
}

/** Moves a group before another group (to the end when `before` is null). */
export function moveGroup(prefs: OrgPrefs, groupId: string, before: string | null): OrgPrefs {
  if (groupId === ALL_GROUP) return prefs;
  return { ...prefs, groupOrder: placeBefore(groupIdsInOrder(prefs), groupId, before) };
}

/** Where a one-step keyboard move (Alt+↑/↓) takes an item; null at the very top or bottom. */
export function stepItem(
  groups: readonly StackGroup[],
  visible: (group: StackGroup) => readonly OrgItem[],
  key: string,
  step: -1 | 1,
): { group: string; before: string | null } | null {
  const index = groups.findIndex((g) => g.members.some((m) => m.key === key));
  const group = groups[index];
  if (!group) return null;
  const rows = visible(group).map((m) => m.key);
  const at = rows.indexOf(key);
  if (at === -1) return null;
  if (step === -1 && at > 0) return { group: group.id, before: rows[at - 1] ?? null };
  if (step === 1 && at < rows.length - 1) return { group: group.id, before: rows[at + 2] ?? null };
  // Past the edge of its group: the end of the group above, or the start of the group below.
  const next = groups[index + step];
  if (!next) return null;
  if (step === -1) return { group: next.id, before: null };
  return { group: next.id, before: visible(next)[0]?.key ?? null };
}

/** Where a one-step keyboard move takes a group; null at the top or bottom. */
export function stepGroup(groups: readonly StackGroup[], groupId: string, step: -1 | 1): string | null | undefined {
  const index = groups.findIndex((g) => g.id === groupId);
  if (index === -1) return undefined;
  if (step === -1) return index > 0 ? (groups[index - 1]?.id ?? undefined) : undefined;
  if (index >= groups.length - 1) return undefined;
  return groups[index + 2]?.id ?? null;
}
