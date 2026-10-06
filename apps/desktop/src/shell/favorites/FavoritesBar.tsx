import { ObjectContextMenu, type ObjectMenuItem } from "@kalcode/ui/components";
import {
  ArrowLeft,
  ArrowRight,
  Bot,
  FileText,
  Folder,
  Globe,
  MessageSquare,
  Pin,
  Play,
  Search,
  Server,
  SquareTerminal,
  Star,
  TriangleAlert,
  UserRound,
  X,
} from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useWorkspaces } from "../../runtime/WorkspaceProvider.tsx";
import { useThreadSummaries } from "../../surfaces/dashboard/data/DashboardData.tsx";
import { FilePreview } from "../context/FilePreview.tsx";
import { useOptionalSearchActions } from "../rail/search/SearchProvider.tsx";
import { KEYBOARD_REORDER_ATTRIBUTE } from "../shortcuts.ts";
import styles from "./Favorites.module.css";
import { type FavoriteEntry, favoriteTargetKey } from "./model.ts";
import { visibleFavorites } from "./selection.ts";
import { useFavorites } from "./store.ts";
import { useFavoriteResolver } from "./useOpenFavorite.ts";

const icons = {
  workspace: Folder,
  thread: MessageSquare,
  agent: Bot,
  terminal: SquareTerminal,
  file: FileText,
  browser: Globe,
  account: UserRound,
  command: SquareTerminal,
  run: Play,
  service: Server,
};

/** A quiet, single-row fast-access strip. Empty collections consume no shell space. */
export function FavoritesBar() {
  const { active } = useWorkspaces();
  const favorites = useFavorites();
  const resolver = useFavoriteResolver();
  const search = useOptionalSearchActions();
  const { state: threadState } = useThreadSummaries();
  const [unavailable, setUnavailable] = useState<Record<string, string | null>>({});
  // Reuse the shell's canonical event-refreshed cache. Labels follow automatic
  // and manual renames; persisted favorites retain their stable identity/fallback.
  const threadNames = useMemo(
    () => new Map(threadState.status === "ready" ? threadState.data.map((thread) => [thread.id, thread.name]) : []),
    [threadState],
  );
  const entries = visibleFavorites(favorites.entries, active?.id ?? null).map((entry) => {
    if (unavailable[entry.key] || (entry.target.kind !== "agent" && entry.target.kind !== "thread")) return entry;
    const title = threadNames.get(entry.target.id);
    return title?.trim() && title !== entry.title ? { ...entry, title } : entry;
  });
  const [notice, setNotice] = useState<{ entry: FavoriteEntry; reason: string } | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [opening, setOpening] = useState<string | null>(null);
  const dragged = useRef<string | null>(null);
  const openGeneration = useRef(0);
  const returnFocus = useRef<HTMLElement | null>(null);
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const live = useRef({ resolver, entries });
  live.current = { resolver, entries };
  const instructionId = useId();
  const identity = `${active?.id ?? ""}:${active?.available ?? false}|${entries.map((entry) => `${entry.key}:${favoriteTargetKey(entry.target)}`).join("|")}`;
  // biome-ignore lint/correctness/useExhaustiveDependencies: refresh availability only when saved target identities or scope change.
  useEffect(() => {
    let cancelled = false;
    // Only metadata reads; a saved terminal or command never starts in the background.
    const check = async () => {
      for (const entry of live.current.entries) {
        if (cancelled) return;
        const reason = await live.current.resolver
          .check(entry.target)
          .catch(() => "Can't check this target right now. Try again.");
        if (!cancelled) setUnavailable((current) => ({ ...current, [entry.key]: reason }));
      }
    };
    void check();
    window.addEventListener("focus", check);
    return () => {
      cancelled = true;
      window.removeEventListener("focus", check);
    };
  }, [identity]);

  const open = async (entry: FavoriteEntry) => {
    const generation = ++openGeneration.current;
    returnFocus.current = buttons.current.get(entry.key) ?? null;
    setOpening(entry.key);
    const result = await resolver
      .open(entry)
      .catch(() => ({ opened: false, reason: "Couldn't open this target. Try again." }));
    if (generation !== openGeneration.current) return;
    setOpening((current) => (current === entry.key ? null : current));
    const reason = result.opened ? null : result.reason || "This target isn't available. Try again or find it by name.";
    setUnavailable((current) => ({ ...current, [entry.key]: reason }));
    setNotice(reason ? { entry, reason } : null);
  };
  const reorder = (entry: FavoriteEntry, delta: number) => {
    const siblings = entries.filter((item) => item.scopeId === entry.scopeId);
    const index = siblings.findIndex((item) => item.key === entry.key);
    const next = index + delta;
    if (next < 0 || next >= siblings.length) return;
    favorites.move(entry.key, delta < 0 ? (siblings[next]?.key ?? null) : (siblings[next + 1]?.key ?? null));
    setAnnouncement(
      `${entry.title} moved ${delta < 0 ? "left" : "right"}. Position ${next + 1} of ${siblings.length}.`,
    );
    requestAnimationFrame(() => buttons.current.get(entry.key)?.focus());
  };
  if (!entries.length && !favorites.error && !resolver.preview && !notice) return null;
  return (
    <div className={styles.bar} data-favorites-bar>
      {resolver.preview ? (
        <FilePreview file={resolver.preview} onClose={resolver.closePreview} returnFocus={returnFocus.current} />
      ) : null}
      <span id={instructionId} className={styles.srOnly}>
        Reorder with Alt and Left or Right arrow, or use the context menu.
      </span>
      <span className={styles.srOnly} aria-live="polite">
        {announcement}
      </span>
      <div className={styles.collections}>
        {(
          [null, active?.id].filter((scope, index, all) => scope !== undefined && all.indexOf(scope) === index) as (
            | string
            | null
          )[]
        ).map((scope) => {
          const list = entries.filter((entry) => entry.scopeId === scope);
          if (!list.length) return null;
          return (
            <div key={scope ?? "global"} className={styles.collection}>
              <span
                className={styles.collectionLabel}
                title={scope === null ? "Global pins" : `${active?.name ?? "Workspace"} favorites`}
              >
                {scope === null ? <Pin aria-hidden="true" /> : <Star aria-hidden="true" />}
                <span>{scope === null ? "Pins" : "Favorites"}</span>
              </span>
              <ul className={styles.items} aria-label={scope === null ? "Global pins" : "Workspace favorites"}>
                {list.map((entry) => {
                  const Icon = icons[entry.target.kind];
                  const reason = unavailable[entry.key];
                  const menu: ObjectMenuItem[] = [
                    {
                      id: "open",
                      label: reason ? "Try opening again" : "Open",
                      icon: <Icon />,
                      onSelect: () => void open(entry),
                    },
                    { id: "move-left", label: "Move left", icon: <ArrowLeft />, onSelect: () => reorder(entry, -1) },
                    { id: "move-right", label: "Move right", icon: <ArrowRight />, onSelect: () => reorder(entry, 1) },
                    {
                      id: "find",
                      label: "Find target…",
                      icon: <Search />,
                      onSelect: () => search?.openWith(entry.title),
                    },
                    {
                      id: "remove",
                      label: scope === null ? "Unpin globally" : "Remove Favorite",
                      icon: <X />,
                      onSelect: () => favorites.remove(entry.key),
                    },
                  ];
                  return (
                    <li key={entry.key} className={styles.savedItem}>
                      <ObjectContextMenu label={`${entry.title} favorite actions`} items={menu}>
                        <button
                          type="button"
                          ref={(element) => {
                            if (element) buttons.current.set(entry.key, element);
                            else buttons.current.delete(entry.key);
                          }}
                          className={styles.target}
                          data-unavailable={Boolean(reason) || undefined}
                          aria-label={`${entry.title}${reason ? ": Unavailable" : ""}`}
                          aria-describedby={instructionId}
                          {...{ [KEYBOARD_REORDER_ATTRIBUTE]: "" }}
                          aria-busy={opening === entry.key || undefined}
                          title={`${entry.title} · ${entry.target.kind}${reason ? ` — ${reason}` : ""}`}
                          draggable
                          onDragStart={(event) => {
                            dragged.current = entry.key;
                            event.dataTransfer.effectAllowed = "move";
                            event.dataTransfer.setData("application/x-kalcode-favorite", entry.key);
                          }}
                          onDragEnd={() => {
                            dragged.current = null;
                          }}
                          onDragOver={(event) => {
                            const source = entries.find((item) => item.key === dragged.current);
                            if (source?.scopeId === scope) event.preventDefault();
                          }}
                          onDrop={(event) => {
                            event.preventDefault();
                            const source = entries.find((item) => item.key === dragged.current);
                            if (source && source.scopeId === scope && source.key !== entry.key) {
                              const siblings = entries.filter((item) => item.scopeId === scope);
                              const sourceIndex = siblings.findIndex((item) => item.key === source.key);
                              const targetIndex = siblings.findIndex((item) => item.key === entry.key);
                              const after = sourceIndex < targetIndex;
                              favorites.move(source.key, after ? (siblings[targetIndex + 1]?.key ?? null) : entry.key);
                              setAnnouncement(`${source.title} moved ${after ? "after" : "before"} ${entry.title}.`);
                            }
                            dragged.current = null;
                          }}
                          onKeyDown={(event) => {
                            if (
                              event.altKey &&
                              ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)
                            ) {
                              event.preventDefault();
                              event.stopPropagation();
                              reorder(entry, event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 1);
                            }
                          }}
                          onClick={() => void open(entry)}
                        >
                          <Icon aria-hidden="true" />
                          <span className={styles.title}>{entry.title}</span>
                          {reason ? <TriangleAlert className={styles.warning} aria-hidden="true" /> : null}
                        </button>
                      </ObjectContextMenu>
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })}
      </div>
      {favorites.error ? (
        <p className={styles.notice} role="alert">
          {favorites.error}
        </p>
      ) : null}
      {notice ? (
        <div className={styles.notice} role="status">
          <TriangleAlert aria-hidden="true" />
          <span>
            <strong>{notice.entry.title}</strong>: {notice.reason} Your favorite is still saved.
          </span>
          <button type="button" onClick={() => void open(notice.entry)}>
            Retry
          </button>
          <button type="button" onClick={() => search?.openWith(notice.entry.title)}>
            Find target
          </button>
          <button type="button" aria-label="Dismiss favorite message" onClick={() => setNotice(null)}>
            <X aria-hidden="true" />
          </button>
        </div>
      ) : null}
    </div>
  );
}
