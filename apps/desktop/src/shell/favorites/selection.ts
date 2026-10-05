import { type FavoriteEntry, type FavoriteTarget, favoriteTargetKey } from "./model.ts";

/** Global pins take the single visible slot when a target is also a workspace favorite. */
export function visibleFavorites(entries: readonly FavoriteEntry[], scopeId: string | null): FavoriteEntry[] {
  const seen = new Set<string>();
  return [
    ...entries.filter((entry) => entry.scopeId === null),
    ...entries.filter((entry) => scopeId !== null && entry.scopeId === scopeId),
  ].filter((entry) => {
    const identity = favoriteTargetKey(entry.target);
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
}

export function isVisibleFavorite(
  entries: readonly FavoriteEntry[],
  scopeId: string | null,
  target: FavoriteTarget,
): boolean {
  const identity = favoriteTargetKey(target);
  return visibleFavorites(entries, scopeId).some((entry) => favoriteTargetKey(entry.target) === identity);
}
