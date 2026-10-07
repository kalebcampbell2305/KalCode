import type { LaunchRecipe } from "@kalcode/protocol";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  EmptyState,
  IconButton,
} from "@kalcode/ui/components";
import {
  Copy,
  Folder,
  GripVertical,
  LayoutTemplate,
  MoreHorizontal,
  Pencil,
  Pin,
  PinOff,
  Play,
  Plus,
  Trash2,
  X,
} from "lucide-react";
import { Dialog } from "radix-ui";
import { type KeyboardEvent, type PointerEvent as ReactPointerEvent, useEffect, useRef, useState } from "react";
import { useOptionalAccount } from "../../account/AccountProvider.tsx";
import { planTier } from "../../ipc/account.ts";
import { useRecipeLibrary, useRecipeRequest } from "../../runtime/recipes/RecipeLaunchProvider.tsx";
import { requestRecipeCapture } from "../../runtime/recipes/useRecipeCapture.ts";
import { useWorkspaces } from "../../runtime/WorkspaceProvider.tsx";
import { describeCounts, moveId, partCounts } from "./partCounts.ts";
import styles from "./RecipesLibrary.module.css";

const DRAG_THRESHOLD = 4;

interface DragState {
  id: string;
  startY: number;
  active: boolean;
  /** Insertion index among the list without the dragged row. */
  index: number;
}

export function RecipesLibrary() {
  const library = useRecipeLibrary();
  const requestRecipe = useRecipeRequest();
  const workspaces = useWorkspaces();
  const account = useOptionalAccount();
  const tier = planTier(account?.snapshot);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const rows = useRef(new Map<string, HTMLLIElement>());
  const dragRef = useRef<DragState | null>(null);
  const { recipes } = library;
  const ids = recipes.map((recipe) => recipe.id);
  const idsRef = useRef(ids);
  idsRef.current = ids;

  const run = async (action: () => Promise<unknown>) => {
    setFailure(null);
    try {
      await action();
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error));
    }
  };

  const reorderTo = (id: string, index: number) => {
    const next = moveId(idsRef.current, id, index);
    if (next.join() === idsRef.current.join()) return;
    const name = recipes.find((recipe) => recipe.id === id)?.name ?? "Recipe";
    setAnnouncement(`Moved ${name} to position ${next.indexOf(id) + 1} of ${next.length}`);
    void run(() => library.reorder(next));
  };
  const reorderRef = useRef(reorderTo);
  reorderRef.current = reorderTo;

  const dragging = drag !== null;
  // Pointer drag: window listeners live only while a drag is armed.
  useEffect(() => {
    if (!dragging) return;
    const move = (event: PointerEvent) => {
      const current = dragRef.current;
      if (!current) return;
      if (!current.active && Math.abs(event.clientY - current.startY) < DRAG_THRESHOLD) return;
      const others = idsRef.current.filter((id) => id !== current.id);
      let index = others.length;
      for (let i = 0; i < others.length; i += 1) {
        const box = rows.current.get(others[i] as string)?.getBoundingClientRect();
        if (box && event.clientY < box.top + box.height / 2) {
          index = i;
          break;
        }
      }
      const next = { ...current, active: true, index };
      dragRef.current = next;
      setDrag(next);
    };
    const finish = (commit: boolean) => {
      const current = dragRef.current;
      dragRef.current = null;
      setDrag(null);
      if (commit && current?.active) reorderRef.current(current.id, current.index);
    };
    const up = () => finish(true);
    const key = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        finish(false);
      }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("keydown", key, true);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("keydown", key, true);
    };
  }, [dragging]);

  const startDrag = (event: ReactPointerEvent, id: string) => {
    if (event.button !== 0) return;
    const state = { id, startY: event.clientY, active: false, index: ids.indexOf(id) };
    dragRef.current = state;
    setDrag(state);
  };

  const stepKey = (event: KeyboardEvent, id: string) => {
    if (!event.altKey || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return false;
    event.preventDefault();
    reorderTo(id, ids.indexOf(id) + (event.key === "ArrowUp" ? -1 : 1));
    return true;
  };

  const onRowKey = (event: KeyboardEvent<HTMLLIElement>, recipe: LaunchRecipe) => {
    if (event.target !== event.currentTarget) return;
    if (event.key === "F2") {
      event.preventDefault();
      setRenaming(recipe.id);
    } else {
      stepKey(event, recipe.id);
    }
  };

  const used = recipes.length;
  const limited = library.limit !== null;
  const insertion = drag?.active ? drag.index : null;
  const others = drag ? ids.filter((id) => id !== drag.id) : ids;

  return (
    <Dialog.Root open={library.library.isOpen} onOpenChange={(open) => !open && library.library.close()}>
      <Dialog.Portal>
        <Dialog.Overlay className={styles.overlay} />
        <Dialog.Content className={styles.drawer} aria-describedby={undefined}>
          <header className={styles.header}>
            <span className={styles.mark} aria-hidden="true">
              <LayoutTemplate />
            </span>
            <div className={styles.headline}>
              <Dialog.Title className={styles.title}>Recipes</Dialog.Title>
              <p className={styles.sub}>Saved desks you launch in one move.</p>
            </div>
            {limited ? (
              <span className={styles.limit} data-full={used >= (library.limit ?? 0) || undefined}>
                {used} of {library.limit} on {tier === "free" ? "Free" : tier.toUpperCase()}
              </span>
            ) : null}
            <Button size="sm" variant="primary" icon={<Plus />} onClick={() => library.editor.open(null)}>
              New Recipe
            </Button>
            <Dialog.Close asChild>
              <IconButton label="Close Recipes" icon={<X />} size="sm" />
            </Dialog.Close>
          </header>

          {failure || library.error ? (
            <p className={styles.failure} role="alert">
              {failure ?? library.error}
            </p>
          ) : null}

          <div className={styles.body}>
            {recipes.length === 0 && !library.loading ? (
              <EmptyState
                title="Save this desk as a Recipe"
                art={<LayoutTemplate />}
                align="center"
                actions={
                  <>
                    <Button
                      variant="primary"
                      onClick={() => {
                        requestRecipeCapture();
                        library.library.close();
                      }}
                    >
                      Save this desk
                    </Button>
                    <Button icon={<Plus />} onClick={() => library.editor.open(null)}>
                      New Recipe
                    </Button>
                  </>
                }
              >
                Your agents, terminals, browser and services, ready to relaunch.
              </EmptyState>
            ) : (
              <ul className={styles.list} aria-label="Recipes" data-dragging={drag?.active || undefined}>
                {recipes.map((recipe) => {
                  const isDragged = drag?.active && drag.id === recipe.id;
                  const position = others.indexOf(recipe.id);
                  const lineBefore = insertion !== null && !isDragged && position === insertion;
                  const lineAfter =
                    insertion !== null && !isDragged && position === others.length - 1 && insertion === others.length;
                  const workspace = recipe.workspaceId
                    ? workspaces.workspaces.find((item) => item.id === recipe.workspaceId)
                    : null;
                  return (
                    <li
                      key={recipe.id}
                      ref={(node) => {
                        if (node) rows.current.set(recipe.id, node);
                        else rows.current.delete(recipe.id);
                      }}
                      className={styles.row}
                      data-dragged={isDragged || undefined}
                      data-line-before={lineBefore || undefined}
                      data-line-after={lineAfter || undefined}
                      data-pinned={recipe.pinned || undefined}
                      // biome-ignore lint/a11y/noNoninteractiveTabindex: the row is the keyboard target for F2 and Alt+Arrow
                      tabIndex={0}
                      aria-label={recipe.name}
                      onKeyDown={(event) => onRowKey(event, recipe)}
                    >
                      <button
                        type="button"
                        className={styles.grip}
                        aria-label={`Reorder ${recipe.name}. Alt+Up or Alt+Down moves it.`}
                        onPointerDown={(event) => startDrag(event, recipe.id)}
                        onKeyDown={(event) => stepKey(event, recipe.id)}
                      >
                        <GripVertical aria-hidden="true" />
                      </button>
                      <div className={styles.main}>
                        {renaming === recipe.id ? (
                          <RenameField
                            value={recipe.name}
                            onCancel={() => setRenaming(null)}
                            onCommit={(name) => {
                              setRenaming(null);
                              if (name && name !== recipe.name) void run(() => library.save({ ...recipe, name }));
                            }}
                          />
                        ) : (
                          // biome-ignore lint/a11y/noStaticElementInteractions: double-click is a shortcut; F2 and the menu are the keyboard routes
                          <span
                            className={styles.name}
                            title="Double-click to rename"
                            onDoubleClick={() => setRenaming(recipe.id)}
                          >
                            {recipe.name}
                          </span>
                        )}
                        <span className={styles.meta}>
                          <span className={styles.chip}>
                            <Folder aria-hidden="true" />
                            {recipe.workspaceId ? (workspace?.name ?? "Missing project") : "Any project"}
                          </span>
                          <span className={styles.counts}>{describeCounts(partCounts(recipe))}</span>
                        </span>
                        {confirming === recipe.id ? (
                          <div className={styles.confirm} role="alert">
                            <span>Delete {recipe.name}?</span>
                            <Button
                              size="sm"
                              variant="danger"
                              onClick={() => {
                                setConfirming(null);
                                void run(() => library.remove(recipe.id));
                              }}
                            >
                              Delete
                            </Button>
                            <Button size="sm" variant="ghost" onClick={() => setConfirming(null)}>
                              Keep
                            </Button>
                          </div>
                        ) : null}
                      </div>
                      <div className={styles.actions}>
                        <IconButton
                          size="sm"
                          label={recipe.pinned ? `Unpin ${recipe.name}` : `Pin ${recipe.name}`}
                          aria-pressed={recipe.pinned}
                          icon={recipe.pinned ? <PinOff /> : <Pin />}
                          onClick={() => void run(() => library.togglePin(recipe.id))}
                        />
                        <Button
                          size="sm"
                          variant="primary"
                          icon={<Play />}
                          aria-label={`Launch ${recipe.name}`}
                          onClick={() => {
                            library.library.close();
                            void requestRecipe({ recipeId: recipe.id });
                          }}
                        >
                          Launch
                        </Button>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <IconButton size="sm" label={`More for ${recipe.name}`} icon={<MoreHorizontal />} />
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end" minWidth={11}>
                            <DropdownMenuItem icon={<Pencil />} onSelect={() => library.editor.open(recipe)}>
                              Edit
                            </DropdownMenuItem>
                            <DropdownMenuItem icon={<Pencil />} shortcut="F2" onSelect={() => setRenaming(recipe.id)}>
                              Rename
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              icon={<Copy />}
                              onSelect={() => void run(() => library.duplicate(recipe.id))}
                            >
                              Duplicate
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem tone="danger" icon={<Trash2 />} onSelect={() => setConfirming(recipe.id)}>
                              Delete
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
            <p className={styles.visuallyHidden} role="status" aria-live="polite">
              {announcement}
            </p>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function RenameField({ value, onCommit, onCancel }: { value: string; onCommit(name: string): void; onCancel(): void }) {
  const [draft, setDraft] = useState(value);
  const done = useRef(false);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  const finish = (commit: boolean) => {
    if (done.current) return;
    done.current = true;
    if (commit) onCommit(draft.trim());
    else onCancel();
  };
  return (
    <input
      ref={ref}
      className={styles.rename}
      value={draft}
      maxLength={120}
      aria-label="Recipe name"
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => finish(true)}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Enter") finish(true);
        else if (event.key === "Escape") finish(false);
      }}
    />
  );
}
