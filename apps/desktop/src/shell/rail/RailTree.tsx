import type { WorkspaceGroup, WorkspaceRailEntry } from "@kalcode/protocol";
import { DISPLAY_STATUS_TONE, displayStatusOf } from "@kalcode/protocol";
import {
  DISPLAY_STATUS_GLYPH,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  ProviderGlyph,
  Tooltip,
} from "@kalcode/ui/components";
import {
  Archive,
  ArchiveRestore,
  ArrowDown,
  ArrowUp,
  ChevronRight,
  Code2,
  FolderInput,
  FolderMinus,
  FolderOpen,
  FolderPlus,
  MoreHorizontal,
  PanelRight,
  Pencil,
  Pin,
  PinOff,
  Trash2,
} from "lucide-react";
import { type HTMLAttributes, type KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import { useOpenInPane } from "../panes/useOpenInPane.ts";
import {
  badgeLabel,
  initials,
  isExpandable,
  isExpanded,
  parentIndex,
  positions,
  providerKey,
  type RailNode,
  relativeTime,
  statusWords,
  threadLabel,
  visibleNodes,
} from "./model.ts";
import { PROJECT_WIDGET } from "./paneIds.ts";
import styles from "./Rail.module.css";
import { useRail } from "./RailProvider.tsx";

/** What the rail asks its host to open (dialogs live in WorkspaceRail). */
export type RailDialog =
  | { kind: "rename"; entry: WorkspaceRailEntry }
  | { kind: "remove"; entry: WorkspaceRailEntry }
  | { kind: "new-group"; forWorkspace: WorkspaceRailEntry | null }
  | { kind: "rename-group"; group: WorkspaceGroup }
  | { kind: "delete-group"; group: WorkspaceGroup };

const REVEAL_LABEL =
  typeof navigator !== "undefined" && /Mac/.test(navigator.platform) ? "Reveal in Finder" : "Show in File Explorer";

/** `label` names the tree; the rail column's is "Workspaces" (a pane's copy says where it is). */
export function RailTree({
  onDialog,
  label = "Workspaces",
}: {
  onDialog: (dialog: RailDialog) => void;
  label?: string;
}) {
  const rail = useRail();
  const [collapsedProviders, setCollapsedProviders] = useState<ReadonlySet<string>>(new Set());
  const nodes = useMemo(
    () => (rail.rail ? visibleNodes(rail.rail, collapsedProviders) : []),
    [rail.rail, collapsedProviders],
  );
  const pos = useMemo(() => positions(nodes), [nodes]);
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const [menuFor, setMenuFor] = useState<string | null>(null);

  const rows = useRef(new Map<string, HTMLDivElement>());
  const [now, setNow] = useState(() => Date.now());

  // Relative times stay honest while the rail is open.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  // The focused row: the remembered one if still visible, else the active workspace, else the first.
  const activeKey = nodes.find((n) => n.kind === "workspace" && n.entry.active)?.key;
  const tabKey = nodes.some((n) => n.key === focusKey) ? focusKey : (activeKey ?? nodes[0]?.key ?? null);

  const focusRow = (key: string | undefined) => {
    if (!key) return;
    setFocusKey(key);
    requestAnimationFrame(() => rows.current.get(key)?.focus());
  };

  const toggle = (node: RailNode, expand?: boolean) => {
    const open = expand ?? !isExpanded(node);
    switch (node.kind) {
      case "section":
        void rail.setSection(node.section, !open);
        break;
      case "group":
        void rail.setGroupCollapsed(node.group.id, !open);
        break;
      case "workspace":
        if (node.hasChildren) void rail.update({ workspaceId: node.entry.workspaceId, collapsed: !open });
        break;
      case "provider": {
        const key = providerKey(node.workspaceId, node.row.providerId);
        setCollapsedProviders((current) => {
          const next = new Set(current);
          if (open) next.delete(key);
          else next.add(key);
          return next;
        });
        break;
      }
      default:
        break;
    }
  };

  const activate = (node: RailNode) => {
    if (node.kind === "workspace") void rail.openWorkspace(node.entry.workspaceId);
    else if (node.kind === "thread") rail.openThread(node.thread.id, node.workspaceId);
    else toggle(node);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>, index: number) => {
    const node = nodes[index];
    if (!node) return;
    const move = (to: number) => {
      event.preventDefault();
      focusRow(nodes[Math.max(0, Math.min(nodes.length - 1, to))]?.key);
    };
    switch (event.key) {
      case "ArrowDown":
        move(index + 1);
        break;
      case "ArrowUp":
        move(index - 1);
        break;
      case "Home":
        move(0);
        break;
      case "End":
        move(nodes.length - 1);
        break;
      case "ArrowRight":
        event.preventDefault();
        if (isExpandable(node) && !isExpanded(node)) toggle(node, true);
        else if (isExpandable(node) && isExpanded(node)) focusRow(nodes[index + 1]?.key);
        break;
      case "ArrowLeft": {
        event.preventDefault();
        if (isExpandable(node) && isExpanded(node)) toggle(node, false);
        else focusRow(nodes[parentIndex(nodes, index) ?? -1]?.key);
        break;
      }
      case "Enter":
      case " ":
        event.preventDefault();
        activate(node);
        break;
      case "F2":
        if (node.kind === "workspace") {
          event.preventDefault();
          onDialog({ kind: "rename", entry: node.entry });
        } else if (node.kind === "group") {
          event.preventDefault();
          onDialog({ kind: "rename-group", group: node.group });
        }
        break;
      case "Delete":
        if (node.kind === "workspace") {
          event.preventDefault();
          onDialog({ kind: "remove", entry: node.entry });
        }
        break;
      case "ContextMenu":
        if (node.kind === "workspace" || node.kind === "group") {
          event.preventDefault();
          setMenuFor(node.key);
        }
        break;
      case "F10":
        if (event.shiftKey && (node.kind === "workspace" || node.kind === "group")) {
          event.preventDefault();
          setMenuFor(node.key);
        }
        break;
      default:
        break;
    }
  };

  if (nodes.length === 0) return null;

  return (
    <div className={styles.tree} role="tree" aria-label={label}>
      {nodes.map((node, index) => {
        const expandable = isExpandable(node);
        const common = {
          rowRef: (el: HTMLDivElement | null) => {
            if (el) rows.current.set(node.key, el);
            else rows.current.delete(node.key);
          },
          level: node.level,
          posinset: pos[index]?.posinset,
          setsize: pos[index]?.setsize,
          expanded: expandable ? isExpanded(node) : undefined,
          tabIndex: node.key === tabKey ? 0 : -1,
          "data-level": node.level,
          "data-kind": node.kind,
          onKeyDown: (e: KeyboardEvent<HTMLDivElement>) => onKeyDown(e, index),
          onFocus: () => setFocusKey(node.key),
          onClick: () => {
            setFocusKey(node.key);
            activate(node);
          },
        } as const;
        const caret = expandable ? (
          <span className={styles.caret} data-open={isExpanded(node) || undefined} aria-hidden="true">
            <ChevronRight />
          </span>
        ) : (
          <span className={styles.caretSpacer} aria-hidden="true" />
        );

        if (node.kind === "section") {
          return (
            <TreeItem
              key={node.key}
              {...common}
              className={styles.sectionRow}
              aria-label={`${node.label}, ${node.count}`}
            >
              {caret}
              <span className={styles.sectionLabel}>{node.label}</span>
              <span className={styles.sectionCount}>{node.count}</span>
            </TreeItem>
          );
        }

        if (node.kind === "group") {
          return (
            <TreeItem
              key={node.key}
              {...common}
              className={styles.groupRow}
              aria-label={`Folder ${node.group.name}, ${node.count} ${node.count === 1 ? "workspace" : "workspaces"}`}
              onContextMenu={(e) => {
                e.preventDefault();
                setMenuFor(node.key);
              }}
            >
              {caret}
              <span className={styles.groupIcon} aria-hidden="true">
                {node.expanded ? <FolderOpen /> : <FolderInput />}
              </span>
              <span className={styles.name}>{node.group.name}</span>
              <span className={styles.sectionCount}>{node.count}</span>
              <GroupMenu
                group={node.group}
                open={menuFor === node.key}
                onOpenChange={(open) => setMenuFor(open ? node.key : null)}
                onDialog={onDialog}
              />
            </TreeItem>
          );
        }

        if (node.kind === "workspace") {
          const { entry } = node;
          const badges = badgeLabel(entry);
          return (
            <TreeItem
              key={node.key}
              {...common}
              className={styles.workspaceRow}
              selected={entry.active}
              data-active={entry.active || undefined}
              data-missing={!entry.available || undefined}
              aria-label={[
                entry.name,
                entry.active ? "active workspace" : null,
                entry.available ? null : "folder missing",
                badges || null,
              ]
                .filter(Boolean)
                .join(", ")}
              onContextMenu={(e) => {
                e.preventDefault();
                setMenuFor(node.key);
              }}
            >
              {caret}
              <span className={styles.tile} aria-hidden="true">
                {initials(entry.name)}
              </span>
              <span className={styles.name}>{entry.name}</span>
              {entry.available ? null : <span className={styles.missing}>Missing</span>}
              <span className={styles.badges} aria-hidden="true">
                {entry.needsYou > 0 ? (
                  <span className={styles.needsBadge} title={`${entry.needsYou} need you`}>
                    <span className={styles.bang}>!</span>
                    {entry.needsYou}
                  </span>
                ) : null}
                {entry.working > 0 ? (
                  <span className={styles.workingBadge} title={`${entry.working} working`}>
                    <span className={styles.workingDot} />
                    {entry.working}
                  </span>
                ) : null}
              </span>
              <WorkspaceMenu
                node={node}
                open={menuFor === node.key}
                onOpenChange={(open) => setMenuFor(open ? node.key : null)}
                onDialog={onDialog}
              />
            </TreeItem>
          );
        }

        if (node.kind === "provider") {
          const { row } = node;
          return (
            <TreeItem
              key={node.key}
              {...common}
              className={styles.providerRow}
              aria-label={`${row.providerName}, ${row.threads} ${row.threads === 1 ? "thread" : "threads"}${badgeLabel(row) && row.threads ? `, ${badgeLabel(row)}` : ""}`}
            >
              {caret}
              <ProviderGlyph provider={row.providerId} size="xs" />
              <span className={styles.providerName}>{row.providerName}</span>
              <span className={styles.badges} aria-hidden="true">
                {row.needsYou > 0 ? <span className={styles.needsMini}>!{row.needsYou}</span> : null}
                {row.working > 0 ? (
                  <span className={styles.workingMini}>
                    <span className={styles.workingDot} />
                    {row.working}
                  </span>
                ) : null}
                <span className={styles.providerCount}>{row.threads}</span>
              </span>
            </TreeItem>
          );
        }

        const info = displayStatusOf(node.thread.status);
        const Glyph = DISPLAY_STATUS_GLYPH[info.status];
        return (
          <TreeItem
            key={node.key}
            {...common}
            className={styles.threadRow}
            aria-label={threadLabel(node.thread, now)}
            title={`${node.thread.name} · ${statusWords(node.thread.status)}`}
          >
            <span className={styles.threadGlyph} data-tone={DISPLAY_STATUS_TONE[info.status]} aria-hidden="true">
              <Glyph />
            </span>
            <span className={styles.threadName}>{node.thread.name}</span>
            <span className={styles.age}>{relativeTime(node.thread.lastActivityAt, now)}</span>
          </TreeItem>
        );
      })}
    </div>
  );
}

interface TreeItemProps extends Omit<HTMLAttributes<HTMLDivElement>, "role" | "tabIndex"> {
  rowRef: (el: HTMLDivElement | null) => void;
  /** Roving focus: 0 for the one focusable row, -1 for the rest. */
  tabIndex: number;
  level: number;
  posinset?: number;
  setsize?: number;
  expanded?: boolean;
  selected?: boolean;
}

/** One row of the flat ARIA tree (level, position and expansion say where it sits). */
function TreeItem({
  rowRef,
  level,
  posinset,
  setsize,
  expanded,
  selected,
  tabIndex,
  children,
  ...rest
}: TreeItemProps) {
  return (
    <div
      ref={rowRef}
      role="treeitem"
      tabIndex={tabIndex}
      aria-level={level}
      aria-posinset={posinset}
      aria-setsize={setsize}
      aria-expanded={expanded}
      aria-selected={selected}
      {...rest}
    >
      {children}
    </div>
  );
}

/** The "⋯" actions of a workspace row (also opened with Shift+F10, the Menu key or a right click). */
function WorkspaceMenu({
  node,
  open,
  onOpenChange,
  onDialog,
}: {
  node: Extract<RailNode, { kind: "workspace" }>;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDialog: (dialog: RailDialog) => void;
}) {
  const rail = useRail();
  const openInPane = useOpenInPane();
  const { entry } = node;
  const groups = rail.rail?.groups.map((g) => g.group) ?? [];
  const canMove = node.siblings === "pinned" || node.siblings === "group";
  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={styles.more}
          tabIndex={-1}
          aria-label="More actions"
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
        >
          <MoreHorizontal />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="right" className={styles.menu} onClick={(e) => e.stopPropagation()}>
        <DropdownMenuLabel>{entry.name}</DropdownMenuLabel>
        <DropdownMenuItem icon={<FolderOpen />} onSelect={() => void rail.openWorkspace(entry.workspaceId, "project")}>
          Open project
        </DropdownMenuItem>
        <DropdownMenuItem icon={<Code2 />} onSelect={() => void rail.openWorkspace(entry.workspaceId, "code")}>
          Open in Code
        </DropdownMenuItem>
        <DropdownMenuItem
          icon={<PanelRight />}
          disabled={!entry.available}
          onSelect={() => {
            void openInPane(
              { kind: "widget", widgetId: PROJECT_WIDGET },
              { workspaceId: entry.workspaceId, placement: "split" },
            );
          }}
        >
          Open project in a pane
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {entry.archived ? null : (
          <DropdownMenuItem
            icon={entry.pinned ? <PinOff /> : <Pin />}
            onSelect={() => void rail.update({ workspaceId: entry.workspaceId, pinned: !entry.pinned })}
          >
            {entry.pinned ? "Unpin" : "Pin"}
          </DropdownMenuItem>
        )}
        {canMove && node.index > 0 ? (
          <DropdownMenuItem
            icon={<ArrowUp />}
            onSelect={() => void rail.update({ workspaceId: entry.workspaceId, position: node.index - 1 })}
          >
            Move up
          </DropdownMenuItem>
        ) : null}
        {canMove && node.index < node.siblingCount - 1 ? (
          <DropdownMenuItem
            icon={<ArrowDown />}
            onSelect={() => void rail.update({ workspaceId: entry.workspaceId, position: node.index + 1 })}
          >
            Move down
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuItem icon={<Pencil />} onSelect={() => onDialog({ kind: "rename", entry })}>
          Rename in rail…
        </DropdownMenuItem>
        {entry.pinned || entry.archived ? null : (
          <>
            {groups
              .filter((g) => g.id !== entry.groupId)
              .map((g) => (
                <DropdownMenuItem
                  key={g.id}
                  icon={<FolderInput />}
                  onSelect={() => void rail.update({ workspaceId: entry.workspaceId, groupId: g.id })}
                >
                  {`Move to ${g.name}`}
                </DropdownMenuItem>
              ))}
            {entry.groupId ? (
              <DropdownMenuItem
                icon={<FolderMinus />}
                onSelect={() => void rail.update({ workspaceId: entry.workspaceId, groupId: "" })}
              >
                Take out of folder
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuItem
              icon={<FolderPlus />}
              onSelect={() => onDialog({ kind: "new-group", forWorkspace: entry })}
            >
              New folder with this workspace…
            </DropdownMenuItem>
          </>
        )}
        <DropdownMenuItem
          icon={<FolderOpen />}
          disabled={!entry.available}
          onSelect={() => void rail.reveal(entry.workspaceId)}
        >
          {REVEAL_LABEL}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          icon={entry.archived ? <ArchiveRestore /> : <Archive />}
          onSelect={() => void rail.update({ workspaceId: entry.workspaceId, archived: !entry.archived })}
        >
          {entry.archived ? "Unarchive" : "Archive (hide from the rail)"}
        </DropdownMenuItem>
        <DropdownMenuItem icon={<Trash2 />} tone="danger" onSelect={() => onDialog({ kind: "remove", entry })}>
          Remove from KalCode…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function GroupMenu({
  group,
  open,
  onOpenChange,
  onDialog,
}: {
  group: WorkspaceGroup;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDialog: (dialog: RailDialog) => void;
}) {
  const rail = useRail();
  const ids = rail.rail?.groups.map((g) => g.group.id) ?? [];
  const at = ids.indexOf(group.id);
  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={styles.more}
          tabIndex={-1}
          aria-label="More actions"
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
        >
          <MoreHorizontal />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="right" className={styles.menu} onClick={(e) => e.stopPropagation()}>
        <DropdownMenuLabel>{group.name}</DropdownMenuLabel>
        <DropdownMenuItem icon={<Pencil />} onSelect={() => onDialog({ kind: "rename-group", group })}>
          Rename folder…
        </DropdownMenuItem>
        {at > 0 ? (
          <DropdownMenuItem icon={<ArrowUp />} onSelect={() => void rail.moveGroup(group.id, -1)}>
            Move up
          </DropdownMenuItem>
        ) : null}
        {at >= 0 && at < ids.length - 1 ? (
          <DropdownMenuItem icon={<ArrowDown />} onSelect={() => void rail.moveGroup(group.id, 1)}>
            Move down
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          icon={<FolderMinus />}
          tone="danger"
          onSelect={() => onDialog({ kind: "delete-group", group })}
        >
          Remove folder…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Small tile used by the collapsed rail strip. */
export function WorkspaceTile({ entry, onOpen }: { entry: WorkspaceRailEntry; onOpen: () => void }) {
  const badges = badgeLabel(entry);
  return (
    <Tooltip content={badges ? `${entry.name} · ${badges}` : entry.name} side="right">
      <button
        type="button"
        className={styles.stripTile}
        data-active={entry.active || undefined}
        aria-label={[entry.name, entry.active ? "active workspace" : null, badges || null].filter(Boolean).join(", ")}
        onClick={onOpen}
      >
        {initials(entry.name)}
        {entry.needsYou > 0 ? <span className={styles.stripNeeds} aria-hidden="true" /> : null}
        {entry.needsYou === 0 && entry.working > 0 ? <span className={styles.stripWorking} aria-hidden="true" /> : null}
      </button>
    </Tooltip>
  );
}
