import { ObjectContextMenu, type ObjectMenuItem } from "@kalcode/ui/components";
import { Pin, PinOff, Star } from "lucide-react";
import type { ReactElement } from "react";
import { useOptionalWorkspaces } from "../../runtime/WorkspaceProvider.tsx";
import styles from "./Favorites.module.css";
import type { FavoriteTarget } from "./model.ts";
import { useFavorites } from "./store.ts";

function useFavoriteScope(scopeId: string | null | undefined) {
  const workspaces = useOptionalWorkspaces();
  return scopeId === undefined ? (workspaces?.active?.id ?? null) : scopeId;
}

export function useFavoriteMenuItems(
  target: FavoriteTarget | null,
  title: string,
  scopeId?: string | null,
): ObjectMenuItem[] {
  const favorites = useFavorites();
  const scope = useFavoriteScope(scopeId);
  if (!target) return [];
  const pinned = favorites.has(target, null);
  const items: ObjectMenuItem[] = [];
  if (scope !== null) {
    items.push({
      id: "workspace-favorite",
      label: favorites.has(target, scope) ? "Remove Favorite" : "Add Favorite",
      icon: <Star />,
      onSelect: () => favorites.toggle(target, title, scope),
    });
  }
  items.push({
    id: "global-pin",
    label: pinned ? "Unpin globally" : "Pin globally",
    icon: pinned ? <PinOff /> : <Pin />,
    onSelect: () => favorites.toggle(target, title, null),
  });
  return items;
}

/** The same action on rows, tabs and toolbars; never dispatches the object's action. */
export function FavoriteButton({
  target,
  title,
  scopeId,
  className,
}: {
  target: FavoriteTarget;
  title: string;
  scopeId?: string | null;
  className?: string;
}) {
  const favorites = useFavorites();
  const scope = useFavoriteScope(scopeId);
  const saved = favorites.has(target, scope);
  const action =
    scope === null ? (saved ? "Unpin globally" : "Pin globally") : saved ? "Remove Favorite" : "Add Favorite";
  return (
    <button
      type="button"
      className={[styles.favoriteButton, className].filter(Boolean).join(" ")}
      data-favorite-action
      data-saved={saved || undefined}
      aria-label={`${action}: ${title}`}
      aria-pressed={saved}
      title={scope === null ? `${action}: ${title}` : `${action}: ${title} (this workspace)`}
      onPointerDown={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        if (event.key === "Tab" || event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) return;
        event.stopPropagation();
      }}
      onClick={(event) => {
        event.stopPropagation();
        favorites.toggle(target, title, scope);
      }}
    >
      {scope === null ? <Pin aria-hidden="true" /> : <Star aria-hidden="true" />}
    </button>
  );
}

export function FavoriteToggle({
  target,
  title,
  scopeId,
  children,
}: {
  target: FavoriteTarget;
  title: string;
  scopeId?: string | null;
  children: ReactElement;
}) {
  const items = useFavoriteMenuItems(target, title, scopeId);
  return (
    <ObjectContextMenu label={`${title} favorites`} items={items}>
      {children}
    </ObjectContextMenu>
  );
}
