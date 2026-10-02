import type { LocatorResult } from "@kalcode/protocol";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  IconButton,
  Kbd,
  Skeleton,
  Tooltip,
} from "@kalcode/ui/components";
import {
  FolderGit2,
  FolderOpen,
  FolderPlus,
  FolderTree,
  MessagesSquare,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  RotateCw,
  Search,
  SquareTerminal,
  X,
} from "lucide-react";
import { type KeyboardEvent, useId, useRef, useState } from "react";
import { useWorkspaces } from "../../runtime/WorkspaceProvider.tsx";
import { allEntries } from "./model.ts";
import styles from "./Rail.module.css";
import { type RailDialogHost, RailDialogs } from "./RailDialogs.tsx";
import { useRail } from "./RailProvider.tsx";
import { RailTree, WorkspaceTile } from "./RailTree.tsx";
import { HighlightedTitle, KIND_ICON } from "./search/LocatorResults.tsx";
import { useOptionalSearchActions } from "./search/SearchProvider.tsx";
import { useLocatorSearch } from "./search/useLocatorSearch.ts";
import { useOpenLocated } from "./search/useOpenLocated.ts";

export const RAIL_SHORTCUT = "Ctrl Shift B";

/**
 * The workspace rail (Z7-W2): a column between the sidebar and the page with Pinned, Folders,
 * Recent and Archived workspaces, each a tree of provider rows and threads with live counts.
 * Collapses to a narrow strip of workspace tiles (Ctrl+Shift+B), and remembers that. The same
 * list is also a pane widget (`kalcode.workspaces`, see `WorkspacesPane`).
 */
export function WorkspaceRail() {
  const rail = useRail();
  const [dialog, setDialog] = useState<RailDialogHost | null>(null);
  if (!rail.enabled) return null;
  return (
    <>
      {rail.hidden ? <RailStrip /> : <RailColumn onDialog={setDialog} />}
      <RailDialogs dialog={dialog} onClose={() => setDialog(null)} />
    </>
  );
}

/** The workspace list as pane content: the rail's search, tree and actions, filling the pane. */
export function WorkspacesPane() {
  const rail = useRail();
  const [dialog, setDialog] = useState<RailDialogHost | null>(null);
  if (!rail.enabled) {
    return <p className={styles.paneNote}>The workspace rail isn't part of this build.</p>;
  }
  return (
    <>
      <RailColumn onDialog={setDialog} inPane />
      <RailDialogs dialog={dialog} onClose={() => setDialog(null)} />
    </>
  );
}

function RailColumn({ onDialog, inPane = false }: { onDialog: (dialog: RailDialogHost) => void; inPane?: boolean }) {
  const rail = useRail();
  const workspaces = useWorkspaces();
  const [query, setQuery] = useState("");
  const headingId = useId();
  const count = rail.rail ? allEntries(rail.rail).filter((e) => !e.archived).length : 0;
  const Frame = inPane ? "div" : "aside";
  return (
    <Frame
      className={inPane ? styles.railPane : styles.rail}
      aria-label={inPane ? undefined : "Workspace rail"}
      data-workspace-rail={inPane ? undefined : true}
      data-rail-surface
      data-persistent={rail.rail?.persistent ?? true}
    >
      <div className={styles.header}>
        <h2 className={styles.heading} id={headingId}>
          Workspaces
          {count > 0 ? <span className={styles.headingCount}>{count}</span> : null}
        </h2>
        <DropdownMenu>
          <Tooltip content="Add a workspace">
            <DropdownMenuTrigger asChild>
              <IconButton size="sm" label="Add a workspace" icon={<Plus />} />
            </DropdownMenuTrigger>
          </Tooltip>
          <DropdownMenuContent align="end">
            <DropdownMenuItem icon={<FolderPlus />} onSelect={() => onDialog({ kind: "new-workspace" })}>
              New workspace…
            </DropdownMenuItem>
            <DropdownMenuItem
              icon={<FolderOpen />}
              onSelect={async () => {
                const opened = await workspaces.openFolder();
                if (opened) await rail.openWorkspace(opened.id);
              }}
            >
              Open folder…
            </DropdownMenuItem>
            <DropdownMenuItem icon={<FolderGit2 />} onSelect={() => onDialog({ kind: "add-repository" })}>
              Add repository…
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              icon={<FolderTree />}
              onSelect={() => onDialog({ kind: "new-group", forWorkspace: null })}
            >
              New rail folder…
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        {inPane ? null : (
          <Tooltip content={`Hide the rail (${RAIL_SHORTCUT})`}>
            <IconButton
              size="sm"
              label="Hide the workspace rail"
              icon={<PanelLeftClose />}
              onClick={rail.toggleHidden}
            />
          </Tooltip>
        )}
      </div>

      <RailSearch query={query} onQuery={setQuery} />

      <div className={styles.body}>
        {query.trim() ? (
          <RailResults query={query} onClear={() => setQuery("")} />
        ) : rail.state === "loading" && !rail.rail ? (
          <div className={styles.loading} aria-busy="true">
            <Skeleton width="70%" />
            <Skeleton width="55%" />
            <Skeleton width="62%" />
          </div>
        ) : rail.state === "error" && !rail.rail ? (
          <div className={styles.problem} role="alert">
            <p>{rail.error?.message ?? "The rail couldn't load."}</p>
            <Button size="sm" variant="secondary" icon={<RotateCw />} onClick={() => void rail.refresh()}>
              Try again
            </Button>
          </div>
        ) : rail.rail && count + rail.rail.archived.length === 0 ? (
          <RailEmpty onDialog={onDialog} />
        ) : (
          <RailTree onDialog={onDialog} label={inPane ? "Workspaces in this pane" : "Workspaces"} />
        )}
      </div>

      {rail.rail && !rail.rail.persistent ? (
        <p className={styles.sessionNote}>Rail changes last for this session in this build.</p>
      ) : null}
    </Frame>
  );
}

function RailEmpty({ onDialog }: { onDialog: (dialog: RailDialogHost) => void }) {
  const workspaces = useWorkspaces();
  const rail = useRail();
  return (
    <div className={styles.empty}>
      <span className={styles.emptyArt} aria-hidden="true">
        <FolderTree />
      </span>
      <p className={styles.emptyTitle}>No workspaces yet</p>
      <p className={styles.emptyText}>A workspace is a project folder. Its threads and terminals gather here.</p>
      <div className={styles.emptyActions}>
        <Button
          size="sm"
          variant="primary"
          icon={<FolderOpen />}
          onClick={async () => {
            const opened = await workspaces.openFolder();
            if (opened) await rail.openWorkspace(opened.id);
          }}
        >
          Open folder
        </Button>
        <Button size="sm" variant="secondary" icon={<FolderPlus />} onClick={() => onDialog({ kind: "new-workspace" })}>
          New workspace
        </Button>
      </div>
    </div>
  );
}

function RailSearch({ query, onQuery }: { query: string; onQuery: (q: string) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape" && query) {
      event.preventDefault();
      onQuery("");
    } else if (event.key === "ArrowDown") {
      // Into the results (or the tree).
      const next = input.current
        ?.closest("[data-rail-surface]")
        ?.querySelector<HTMLElement>('[role="treeitem"][tabindex="0"], [data-rail-result]');
      if (next) {
        event.preventDefault();
        next.focus();
      }
    }
  };
  return (
    <div className={styles.search}>
      <Search className={styles.searchIcon} aria-hidden="true" />
      <input
        ref={input}
        type="search"
        className={styles.searchInput}
        placeholder="Find a workspace or thread"
        aria-label="Find a workspace or thread"
        value={query}
        maxLength={256}
        onChange={(e) => onQuery(e.target.value)}
        onKeyDown={onKeyDown}
      />
      {query ? (
        <button type="button" className={styles.searchClear} aria-label="Clear search" onClick={() => onQuery("")}>
          <X />
        </button>
      ) : null}
    </div>
  );
}

/** Rail search runs on the Session Locator, limited to workspaces and threads. */
function RailResults({ query, onClear }: { query: string; onClear: () => void }) {
  const { response, loading, error } = useLocatorSearch(query, { kinds: ["workspace", "thread"], limit: 12 });
  const open = useOpenLocated();
  const search = useOptionalSearchActions();
  const items = response?.results.items ?? [];
  const onKey = (event: KeyboardEvent<HTMLButtonElement>) => {
    const list = [
      ...(event.currentTarget.parentElement?.parentElement?.querySelectorAll<HTMLButtonElement>("[data-rail-result]") ??
        []),
    ];
    const at = list.indexOf(event.currentTarget);
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      list[Math.max(0, Math.min(list.length - 1, at + (event.key === "ArrowDown" ? 1 : -1)))]?.focus();
    }
  };
  return (
    <div className={styles.results} aria-busy={loading || undefined}>
      <p className={styles.resultsMeta} role="status">
        {error
          ? error.message
          : loading && !response
            ? "Searching…"
            : `${response?.results.totalEstimate ?? items.length} ${items.length === 1 ? "match" : "matches"}`}
      </p>
      <ul className={styles.resultList} aria-label="Search results">
        {items.map((item: LocatorResult) => {
          const Icon = KIND_ICON[item.kind] ?? (item.kind === "thread" ? MessagesSquare : SquareTerminal);
          return (
            <li key={`${item.kind}:${item.entityId}`}>
              <button
                type="button"
                className={styles.result}
                data-rail-result
                onKeyDown={onKey}
                onClick={async () => {
                  if (await open(item.kind, item.entityId, "rail")) onClear();
                }}
              >
                <Icon className={styles.resultIcon} aria-hidden="true" />
                <span className={styles.resultText}>
                  <span className={styles.resultTitle}>
                    <HighlightedTitle title={item.title} highlights={item.highlights} />
                  </span>
                  {item.subtitle ? <span className={styles.resultSub}>{item.subtitle}</span> : null}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      {search ? (
        <button type="button" className={styles.moreResults} onClick={() => search.openWith(query)}>
          Search everything for “{query.trim()}” <Kbd>Ctrl K</Kbd>
        </button>
      ) : null}
    </div>
  );
}

/** The collapsed rail: a narrow strip of workspace tiles. */
function RailStrip() {
  const rail = useRail();
  const entries = rail.rail
    ? [...rail.rail.pinned, ...rail.rail.groups.flatMap((g) => g.workspaces), ...rail.rail.recent]
    : [];
  return (
    <nav className={styles.strip} aria-label="Workspaces (collapsed rail)" data-workspace-rail>
      <Tooltip content={`Show the rail (${RAIL_SHORTCUT})`} side="right">
        <IconButton size="sm" label="Show the workspace rail" icon={<PanelLeftOpen />} onClick={rail.toggleHidden} />
      </Tooltip>
      <div className={styles.stripList}>
        {entries.slice(0, 12).map((entry) => (
          <WorkspaceTile
            key={entry.workspaceId}
            entry={entry}
            onOpen={() => void rail.openWorkspace(entry.workspaceId)}
          />
        ))}
      </div>
    </nav>
  );
}
