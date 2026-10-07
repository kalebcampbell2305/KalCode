import type { PaneContent, ProviderId } from "@kalcode/protocol";
import {
  IconButton,
  ObjectContextMenu,
  type ObjectMenuItem,
  openObjectContextMenu,
  ProviderGlyph,
  StatusChip,
  Tooltip,
} from "@kalcode/ui/components";
import {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronDown,
  ChevronRight,
  CircleCheck,
  CircleDashed,
  CircleDot,
  CirclePause,
  CircleStop,
  CircleX,
  Eye,
  FlaskConical,
  FolderInput,
  FolderPlus,
  GripVertical,
  Hand,
  Hourglass,
  Layers,
  ListTree,
  type LucideIcon,
  MoreHorizontal,
  PanelLeftClose,
  PenLine,
  Pin,
  PinOff,
  RotateCcw,
  Trash2,
  Zap,
} from "lucide-react";
import {
  type KeyboardEvent,
  memo,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { contentKey, leaves } from "../../../shell/panes/model.ts";
import type { PaneController } from "../../../shell/panes/usePaneController.ts";
import { moveGroup, moveItem, stepGroup, stepItem } from "./arrange.ts";
import {
  BADGES,
  groupIdOf,
  groupIdsInOrder,
  groupName,
  type OrgBadge,
  type OrgItem,
  organize,
  type StackGroup,
  stackShown,
} from "./model.ts";
import styles from "./Organization.module.css";
import { MAX_GROUP_NAME } from "./prefs.ts";
import type { Organization } from "./useOrganization.ts";
import { type DragSubject, type DropTarget, type StackDragState, useStackDrag } from "./useStackDrag.ts";

/** One glyph per badge, so status is tone + glyph + word. Done is the completion checkmark. */
export const BADGE_ICONS: Record<OrgBadge, LucideIcon> = {
  starting: CircleDashed,
  ready: CircleDot,
  working: Zap,
  testing: FlaskConical,
  needs_you: Hand,
  waiting: Hourglass,
  failed: CircleX,
  done: CircleCheck,
  stopped: CircleStop,
  idle: CirclePause,
};

export function OrgBadgeChip({ item }: { item: OrgItem }) {
  if (!item.status) return null;
  const meta = BADGES[item.status.badge];
  return (
    <StatusChip
      variant="inline"
      size="sm"
      tone={meta.tone}
      label={meta.label}
      icon={BADGE_ICONS[item.status.badge]}
      className={styles.badge}
    />
  );
}

/** The focused pane's active content key, so it never collapses into Finished. */
function focusedKeyOf(controller: PaneController): string | null {
  const leaf = leaves(controller.layout.root).find((l) => l.paneId === controller.focusedPaneId);
  const content = leaf?.tabs[leaf.activeTab];
  return content ? contentKey(content) : null;
}

/** Longest terminal or agent name the stack accepts (the rename dialog's limit). */
const MAX_ITEM_NAME = 80;
const NEW_GROUP_NAME = "New group";
/** A new name field keeps focus this long against a pane focusing itself after the first click. */
const FOCUS_GRACE_MS = 700;

type Editing = { kind: "item"; key: string } | { kind: "group"; id: string; fresh: boolean };

interface StackProps {
  organization: Organization;
  controller: PaneController;
  /**
   * Renames a terminal or coding agent through its canonical path (the same one as the pane's
   * Rename): a name the person sets is kept, and automatic task names never replace it.
   */
  rename?: (content: PaneContent, name: string) => Promise<void>;
}

/**
 * The Terminal Stack: the workspace's terminals and agents grouped by purpose (or as one stack).
 * The fast organization surface for live work: names edit in place (double-click, F2 or Rename),
 * items drag to reorder or move between groups, groups drag to reorder, and every arrangement
 * persists per workspace. Nothing here starts, stops, restarts or moves the session behind an
 * item; selecting an item shows its real pane.
 */
export const TerminalStack = memo(function TerminalStack({ organization, controller, rename }: StackProps) {
  const { items, prefs } = organization;
  const focusedKey = focusedKeyOf(controller);
  const groups = useMemo(() => organize(items, prefs.prefs, focusedKey), [items, prefs.prefs, focusedKey]);
  const grouped = prefs.prefs.grouping;
  const [openFinished, setOpenFinished] = useState<ReadonlySet<string>>(new Set());
  const [editing, setEditing] = useState<Editing | null>(null);
  /** Names saved but not yet reflected by the item's live title. */
  const [pendingNames, setPendingNames] = useState<ReadonlyMap<string, string>>(new Map());
  const working = items.filter((i) => i.status?.badge === "working" || i.status?.badge === "testing").length;
  const waiting = items.filter((i) => i.status?.badge === "needs_you").length;

  const shown = stackShown(prefs.prefs, items.length);
  // On a narrow canvas the stack doesn't take the panes' width: the rail opens it over the canvas.
  const [overlay, setOverlay] = useState(false);
  const railRef = useRef<HTMLButtonElement>(null);
  const stackRef = useRef<HTMLElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  // The opened overlay takes keyboard focus; closing it gives focus back to the rail.
  useEffect(() => {
    if (overlay) stackRef.current?.focus({ preventScroll: true });
  }, [overlay]);
  const closeOverlay = () => {
    setOverlay(false);
    railRef.current?.focus({ preventScroll: true });
  };

  // A saved name stays shown until the live title catches up with it.
  useEffect(() => {
    setPendingNames((current) => {
      if (current.size === 0) return current;
      const next = new Map([...current].filter(([key, name]) => items.find((i) => i.key === key)?.title !== name));
      return next.size === current.size ? current : next;
    });
  }, [items]);

  const focusNav = useCallback((nav: string) => {
    requestAnimationFrame(() =>
      bodyRef.current?.querySelector<HTMLElement>(`[data-nav="${CSS.escape(nav)}"]`)?.focus({ preventScroll: false }),
    );
  }, []);

  /** The rows a person sees in a group right now (Finished only while it is open). */
  const visibleOf = useCallback(
    (group: StackGroup) => (openFinished.has(group.id) ? [...group.active, ...group.finished] : group.active),
    [openFinished],
  );

  const applyMove = useCallback(
    (item: OrgItem, group: string, before: string | null) => {
      const from = groupIdOf(prefs.prefs, item);
      prefs.update((current) => moveItem(current, organize(items, current, focusedKey), item, group, before));
      if (from !== group) {
        if (prefs.prefs.collapsedGroups.includes(group)) prefs.setCollapsed(group, false);
        controller.announce(`${item.title} moved to ${groupName(prefs.prefs, group)}.`);
      } else controller.announce(`${item.title} moved.`);
    },
    [prefs, items, focusedKey, controller],
  );

  const createGroup = useCallback(
    (moveKey: string | null) => {
      const id = prefs.addGroup(NEW_GROUP_NAME);
      if (!id) return;
      if (moveKey) prefs.moveTo(moveKey, id);
      setEditing({ kind: "group", id, fresh: moveKey === null });
    },
    [prefs],
  );

  const onDrop = useCallback(
    (subject: DragSubject, target: DropTarget) => {
      if (subject.kind === "group") {
        if (target.kind !== "group") return;
        prefs.update((current) => moveGroup(current, subject.id, target.before));
        controller.announce(`${subject.label} group moved.`);
        return;
      }
      const item = items.find((i) => i.key === subject.key);
      if (!item) return;
      if (target.kind === "new-group") createGroup(item.key);
      else if (target.kind === "into") applyMove(item, target.group, null);
      else if (target.kind === "item") applyMove(item, target.group, target.before);
    },
    [items, prefs, controller, applyMove, createGroup],
  );
  const drag = useStackDrag(bodyRef, onDrop);

  if (!shown) {
    return (
      <StackRail
        railRef={railRef}
        shown={false}
        overlay={false}
        count={items.length}
        working={working}
        waiting={waiting}
        onOpen={() => prefs.setStackOpen(true)}
        onEscape={() => {}}
      />
    );
  }

  const show = (item: OrgItem) => {
    controller.show(item.content, { focus: true });
    setOverlay(false);
  };
  const toggleFinished = (group: string) =>
    setOpenFinished((current) => {
      const next = new Set(current);
      if (next.has(group)) next.delete(group);
      else next.add(group);
      return next;
    });

  const commitItemName = async (item: OrgItem, name: string) => {
    setEditing(null);
    focusNav(`item:${item.key}`);
    const clean = name.replace(/\s+/g, " ").trim();
    if (!clean || !rename) return;
    setPendingNames((current) => new Map(current).set(item.key, clean));
    try {
      await rename(item.content, clean);
      controller.announce(`Renamed to ${clean}.`);
    } catch {
      setPendingNames((current) => {
        const next = new Map(current);
        next.delete(item.key);
        return next;
      });
      controller.announce(`Couldn't rename ${item.title}. The name is unchanged.`);
    }
  };

  const commitGroupName = (group: StackGroup, name: string | null, fresh: boolean) => {
    setEditing(null);
    if (name === null) {
      // Escape on a group that was just added and is still empty takes it back.
      if (fresh && group.members.length === 0 && !group.auto) prefs.removeGroup(group.id);
      else focusNav(`group:${group.id}`);
      return;
    }
    prefs.renameGroup(group.id, name);
    focusNav(`group:${group.id}`);
  };

  const moveByKeyboard = (nav: string, step: -1 | 1) => {
    if (nav.startsWith("item:")) {
      const key = nav.slice(5);
      const item = items.find((i) => i.key === key);
      const to = item ? stepItem(groups, visibleOf, key, step) : null;
      if (!item || !to) return;
      applyMove(item, to.group, to.before);
      focusNav(nav);
    } else if (nav.startsWith("group:") && grouped) {
      const id = nav.slice(6);
      const before = stepGroup(groups, id, step);
      if (before === undefined) return;
      prefs.update((current) => moveGroup(current, id, before));
      controller.announce(`${groups.find((g) => g.id === id)?.name ?? "Group"} moved ${step < 0 ? "up" : "down"}.`);
      focusNav(nav);
    }
  };

  const onBodyKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    if (target.closest("input")) return;
    const nav = target.closest<HTMLElement>("[data-nav]")?.dataset.nav;
    if (!nav) return;
    if (event.key === "F2") {
      event.preventDefault();
      event.stopPropagation();
      if (nav.startsWith("item:") && rename) setEditing({ kind: "item", key: nav.slice(5) });
      else if (nav.startsWith("group:") && grouped) setEditing({ kind: "group", id: nav.slice(6), fresh: false });
      return;
    }
    if ((event.key === "ArrowUp" || event.key === "ArrowDown") && event.altKey) {
      event.preventDefault();
      moveByKeyboard(nav, event.key === "ArrowUp" ? -1 : 1);
      return;
    }
    if (["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key) && !event.altKey && !event.ctrlKey) {
      const all = [...(bodyRef.current?.querySelectorAll<HTMLElement>("[data-nav]") ?? [])];
      const at = all.findIndex((el) => el.dataset.nav === nav);
      const next =
        event.key === "Home"
          ? all[0]
          : event.key === "End"
            ? all[all.length - 1]
            : all[Math.max(0, Math.min(all.length - 1, at + (event.key === "ArrowUp" ? -1 : 1)))];
      if (next) {
        event.preventDefault();
        next.focus();
      }
    }
  };

  const dragging = drag.state;
  const groupMenu = (group: StackGroup, index: number): ObjectMenuItem[] => [
    {
      id: "rename",
      label: "Rename",
      icon: <PenLine />,
      onSelect: () => setEditing({ kind: "group", id: group.id, fresh: false }),
    },
    {
      id: "collapse",
      label: group.collapsed ? "Expand" : "Collapse",
      icon: group.collapsed ? <ChevronDown /> : <ChevronRight />,
      onSelect: () => prefs.toggleGroup(group.id),
    },
    { id: "sep", separator: true },
    ...(index > 0
      ? [
          {
            id: "up",
            label: "Move group up",
            icon: <ArrowUp />,
            onSelect: () => moveByKeyboard(`group:${group.id}`, -1),
          },
        ]
      : []),
    ...(index < groups.length - 1
      ? [
          {
            id: "down",
            label: "Move group down",
            icon: <ArrowDown />,
            onSelect: () => moveByKeyboard(`group:${group.id}`, 1),
          },
        ]
      : []),
    ...(group.auto === null
      ? [
          { id: "sep2", separator: true as const },
          {
            id: "remove",
            label: "Remove group",
            icon: <Trash2 />,
            tone: "danger" as const,
            onSelect: () => {
              prefs.removeGroup(group.id);
              controller.announce(
                group.members.length
                  ? `${group.name} removed. Its items went back to their own groups.`
                  : `${group.name} removed.`,
              );
            },
          },
        ]
      : group.name !== group.auto
        ? [
            { id: "sep2", separator: true as const },
            {
              id: "restore",
              label: `Restore name “${group.auto}”`,
              icon: <RotateCcw />,
              onSelect: () => prefs.renameGroup(group.id, group.auto ?? group.name),
            },
          ]
        : []),
  ];

  const itemMenu = (item: OrgItem, group: StackGroup): ObjectMenuItem[] => {
    const pinned = prefs.prefs.pinned.includes(item.key);
    const step = (direction: -1 | 1) => stepItem(groups, visibleOf, item.key, direction);
    return [
      { id: "show", label: "Show", icon: <Eye />, onSelect: () => show(item) },
      ...(rename
        ? [
            {
              id: "rename",
              label: "Rename",
              icon: <PenLine />,
              onSelect: () => setEditing({ kind: "item", key: item.key }),
            },
          ]
        : []),
      {
        id: "pin",
        label: pinned ? "Unpin" : "Pin (stays visible when finished)",
        icon: pinned ? <PinOff /> : <Pin />,
        onSelect: () => prefs.togglePin(item.key),
      },
      { id: "sep", separator: true },
      ...(step(-1)
        ? [{ id: "up", label: "Move up", icon: <ArrowUp />, onSelect: () => moveByKeyboard(`item:${item.key}`, -1) }]
        : []),
      ...(step(1)
        ? [
            {
              id: "down",
              label: "Move down",
              icon: <ArrowDown />,
              onSelect: () => moveByKeyboard(`item:${item.key}`, 1),
            },
          ]
        : []),
      ...(grouped
        ? [
            {
              id: "move",
              label: "Move to group",
              icon: <FolderInput />,
              children: [
                ...groupIdsInOrder(prefs.prefs)
                  .map((id) => ({ id, name: groupName(prefs.prefs, id) }))
                  .map((g) => ({
                    id: g.id,
                    label: g.name,
                    icon: g.id === group.id ? <Check /> : <span />,
                    onSelect: () => {
                      if (g.id !== group.id) applyMove(item, g.id, null);
                    },
                  })),
                { id: "sep", separator: true as const },
                { id: "new", label: "New group…", icon: <FolderPlus />, onSelect: () => createGroup(item.key) },
              ],
            },
          ]
        : []),
    ];
  };

  const editingGroup = editing?.kind === "group" ? editing : null;
  const editingItem = editing?.kind === "item" ? editing.key : null;

  return (
    <>
      <StackRail
        railRef={railRef}
        shown
        overlay={overlay}
        count={items.length}
        working={working}
        waiting={waiting}
        onOpen={() => setOverlay((open) => !open)}
        onEscape={() => setOverlay(false)}
      />
      <aside
        ref={stackRef}
        className={styles.stack}
        aria-label="Terminal stack"
        tabIndex={-1}
        data-overlay={overlay || undefined}
        data-dragging={dragging ? dragging.subject.kind : undefined}
        onKeyDown={(event) => {
          if (overlay && event.key === "Escape" && !editing) {
            event.preventDefault();
            closeOverlay();
          }
        }}
      >
        <div className={styles.stackHeader}>
          <Layers className={styles.stackIcon} aria-hidden="true" />
          <span className={styles.stackTitle}>Stack</span>
          <span className={styles.stackCounts}>
            {items.length} {items.length === 1 ? "item" : "items"}
          </span>
          <span className={styles.spacer} />
          <Tooltip content={grouped ? "Show one stack" : "Group by purpose"}>
            <IconButton
              size="sm"
              label={grouped ? "Show one stack" : "Group by purpose"}
              aria-pressed={grouped}
              icon={<ListTree />}
              onClick={() => prefs.setGrouping(!grouped)}
            />
          </Tooltip>
          <Tooltip content="Hide the stack">
            <IconButton
              size="sm"
              label="Hide the stack"
              icon={<PanelLeftClose />}
              onClick={() => (overlay ? closeOverlay() : prefs.setStackOpen(false))}
            />
          </Tooltip>
        </div>
        {/* biome-ignore lint/a11y/noStaticElementInteractions: arrow keys move between the list's own buttons */}
        <div className={styles.stackBody} ref={bodyRef} onKeyDown={onBodyKeyDown}>
          <p className="visually-hidden" id="stack-help">
            Drag to reorder or move between groups. Alt+Up or Alt+Down moves the focused item or group. F2 renames.
          </p>
          {items.length === 0 ? (
            <p className={styles.empty}>No terminals or agents yet. Start one with + Terminal or + Agent.</p>
          ) : null}
          {groups.map((group, index) => (
            <StackGroupView
              key={group.id}
              group={group}
              grouped={grouped}
              finishedOpen={openFinished.has(group.id)}
              focusedKey={focusedKey}
              pinned={prefs.prefs.pinned}
              drag={dragging}
              bindGroup={grouped ? drag.bind({ kind: "group", id: group.id, label: group.name }) : null}
              bindItem={(item) => drag.bind({ kind: "item", key: item.key, label: item.title })}
              editingName={editingGroup?.id === group.id}
              editingItem={editingItem}
              pendingNames={pendingNames}
              groupMenu={grouped ? groupMenu(group, index) : []}
              itemMenu={(item) => itemMenu(item, group)}
              onToggle={() => prefs.toggleGroup(group.id)}
              onToggleFinished={() => toggleFinished(group.id)}
              onShow={show}
              onRenameItem={rename ? (item) => setEditing({ kind: "item", key: item.key }) : null}
              onCommitItem={(item, name) => void commitItemName(item, name)}
              onCancelItem={(item) => {
                setEditing(null);
                focusNav(`item:${item.key}`);
              }}
              onRenameGroup={() => setEditing({ kind: "group", id: group.id, fresh: false })}
              onCommitGroup={(name) => commitGroupName(group, name, editingGroup?.fresh ?? false)}
            />
          ))}
          {grouped ? (
            <button
              type="button"
              className={styles.addGroup}
              data-drop-new-group=""
              data-nav="new-group"
              data-drop-active={dragging?.target?.kind === "new-group" || undefined}
              onClick={() => createGroup(null)}
            >
              <FolderPlus aria-hidden="true" />
              {dragging?.subject.kind === "item" ? "Drop for a new group" : "New group"}
            </button>
          ) : null}
        </div>
        {dragging ? (
          <div ref={drag.ghostRef} className={styles.dragGhost} data-kind={dragging.subject.kind} aria-hidden="true">
            {dragging.subject.kind === "group" ? <Layers /> : <GripVertical />}
            <span>{dragging.subject.label}</span>
          </div>
        ) : null}
      </aside>
    </>
  );
});

function StackRail({
  railRef,
  shown,
  overlay,
  count,
  working,
  waiting,
  onOpen,
  onEscape,
}: {
  railRef: RefObject<HTMLButtonElement | null>;
  shown: boolean;
  overlay: boolean;
  count: number;
  working: number;
  waiting: number;
  onOpen: () => void;
  onEscape: () => void;
}) {
  return (
    <div className={styles.stackRail} data-narrow-only={shown || undefined}>
      <Tooltip content="Show the terminal stack" side="right">
        <button
          ref={railRef}
          type="button"
          className={styles.railButton}
          aria-label={`Show the terminal stack: ${count} items, ${working} working, ${waiting} waiting`}
          aria-expanded={shown ? overlay : false}
          onClick={onOpen}
          onKeyDown={(event) => {
            if (overlay && event.key === "Escape") {
              event.preventDefault();
              onEscape();
            }
          }}
        >
          <Layers aria-hidden="true" />
          {working > 0 ? (
            <span className={styles.railCount} data-tone="working">
              {working}
            </span>
          ) : null}
          {waiting > 0 ? (
            <span className={styles.railCount} data-tone="waiting">
              {waiting}
            </span>
          ) : null}
        </button>
      </Tooltip>
    </div>
  );
}

type Bind = ReturnType<ReturnType<typeof useStackDrag>["bind"]>;

interface GroupViewProps {
  group: StackGroup;
  grouped: boolean;
  finishedOpen: boolean;
  focusedKey: string | null;
  pinned: readonly string[];
  drag: StackDragState | null;
  bindGroup: Bind | null;
  bindItem: (item: OrgItem) => Bind;
  editingName: boolean;
  editingItem: string | null;
  pendingNames: ReadonlyMap<string, string>;
  groupMenu: readonly ObjectMenuItem[];
  itemMenu: (item: OrgItem) => readonly ObjectMenuItem[];
  onToggle: () => void;
  onToggleFinished: () => void;
  onShow: (item: OrgItem) => void;
  onRenameItem: ((item: OrgItem) => void) | null;
  onCommitItem: (item: OrgItem, name: string) => void;
  onCancelItem: (item: OrgItem) => void;
  onRenameGroup: () => void;
  onCommitGroup: (name: string | null) => void;
}

function StackGroupView({
  group,
  grouped,
  finishedOpen,
  focusedKey,
  pinned,
  drag,
  bindGroup,
  bindItem,
  editingName,
  editingItem,
  pendingNames,
  groupMenu,
  itemMenu,
  onToggle,
  onToggleFinished,
  onShow,
  onRenameItem,
  onCommitItem,
  onCancelItem,
  onRenameGroup,
  onCommitGroup,
}: GroupViewProps) {
  const listId = useId();
  const total = group.members.length;
  const target = drag?.target ?? null;
  const itemDrag = drag?.subject.kind === "item" ? drag.subject : null;
  const peeking = drag?.peek === group.id;
  const collapsed = grouped && group.collapsed && !peeking;
  const into = target?.kind === "into" && target.group === group.id;
  const draggedHere = itemDrag ? group.members.some((m) => m.key === itemDrag.key) : false;
  const groupLine = target?.kind === "group" && target.line.group === group.id ? target.line.edge : undefined;
  const lineFor = (key: string) => (target?.kind === "item" && target.line.key === key ? target.line.edge : undefined);
  const row = (item: OrgItem) => (
    <StackItem
      key={item.key}
      item={item}
      groupId={group.id}
      groupName={grouped ? group.name : null}
      title={pendingNames.get(item.key) ?? item.title}
      focused={item.key === focusedKey}
      pinned={pinned.includes(item.key)}
      dragging={itemDrag?.key === item.key}
      dropEdge={lineFor(item.key)}
      editing={editingItem === item.key}
      bind={bindItem(item)}
      menu={itemMenu(item)}
      onShow={onShow}
      onRename={onRenameItem}
      onCommit={onCommitItem}
      onCancel={onCancelItem}
    />
  );
  // While an item drags, an empty group (or a collapsed one) offers one large target.
  const bigTarget = Boolean(itemDrag && grouped && !draggedHere && (total === 0 || collapsed));
  const header = grouped ? (
    editingName ? (
      <div className={styles.groupHeader} data-editing="">
        <ChevronDown aria-hidden="true" />
        <InlineName
          className={styles.groupNameInput}
          value={group.name}
          label={`Name of the ${group.name} group`}
          maxLength={MAX_GROUP_NAME}
          onCommit={(name) => onCommitGroup(name)}
          onCancel={() => onCommitGroup(null)}
        />
      </div>
    ) : (
      <ObjectContextMenu items={groupMenu} label={`${group.name} group`}>
        <button
          type="button"
          className={styles.groupHeader}
          aria-expanded={!collapsed}
          aria-controls={listId}
          aria-describedby="stack-help"
          data-nav={`group:${group.id}`}
          data-drop-header=""
          data-group={group.id}
          data-drop-active={(into && collapsed) || undefined}
          onClick={onToggle}
          onDoubleClick={(event) => {
            // By position: pointer capture makes the header itself the event target.
            const name = event.currentTarget.querySelector("[data-group-name]")?.getBoundingClientRect();
            if (name && event.clientX >= name.left - 4 && event.clientX <= name.right + 4) onRenameGroup();
          }}
          {...bindGroup}
        >
          {collapsed ? <ChevronRight aria-hidden="true" /> : <ChevronDown aria-hidden="true" />}
          <span className={styles.groupName} data-group-name="">
            {group.name}
          </span>
          <span className={styles.groupTotal}>{total}</span>
          <span className={styles.spacer} />
          <GroupCounts group={group} />
          <GripVertical className={styles.groupGrip} aria-hidden="true" />
        </button>
      </ObjectContextMenu>
    )
  ) : null;
  return (
    <section
      className={styles.group}
      aria-label={grouped ? `${group.name} group` : "All terminals and agents"}
      data-drop-group=""
      data-group={group.id}
      data-drop-into={(into && !bigTarget) || undefined}
      data-drop-edge={groupLine}
      data-drag-self={(drag?.subject.kind === "group" && drag.subject.id === group.id) || undefined}
    >
      {groupLine ? <span className={styles.dropLine} aria-hidden="true" /> : null}
      {header}
      {bigTarget ? (
        <div className={styles.dropZone} data-active={into || undefined}>
          <FolderInput aria-hidden="true" />
          Move to {group.name}
        </div>
      ) : null}
      {collapsed ? null : (
        <div id={listId}>
          {total === 0 && !bigTarget ? <p className={styles.groupEmpty}>Empty. Drag items here.</p> : null}
          <ul className={styles.items}>{group.active.map(row)}</ul>
          {group.finished.length > 0 ? (
            <>
              <button
                type="button"
                className={styles.finishedToggle}
                aria-expanded={finishedOpen}
                data-nav={`finished:${group.id}`}
                onClick={onToggleFinished}
              >
                {finishedOpen ? <ChevronDown aria-hidden="true" /> : <ChevronRight aria-hidden="true" />}
                <CircleCheck aria-hidden="true" className={styles.finishedIcon} />
                Finished · {group.finished.length}
              </button>
              {finishedOpen ? <ul className={styles.items}>{group.finished.map(row)}</ul> : null}
            </>
          ) : null}
        </div>
      )}
    </section>
  );
}

const COUNT_PARTS: readonly [keyof StackGroup["counts"], LucideIcon][] = [
  ["waiting", Hand],
  ["failed", CircleX],
  ["working", Zap],
  ["done", CircleCheck],
];

function GroupCounts({ group }: { group: StackGroup }) {
  return COUNT_PARTS.map(([key, Icon]) =>
    group.counts[key] > 0 ? (
      <span key={key} className={styles.groupCount} data-tone={key} title={`${group.counts[key]} ${key}`}>
        <Icon aria-hidden="true" />
        {group.counts[key]}
      </span>
    ) : null,
  );
}

interface ItemProps {
  item: OrgItem;
  groupId: string;
  /** The group's name for screen readers; null in the single stack. */
  groupName: string | null;
  title: string;
  focused: boolean;
  pinned: boolean;
  dragging: boolean;
  dropEdge: "before" | "after" | undefined;
  editing: boolean;
  bind: Bind;
  menu: readonly ObjectMenuItem[];
  onShow: (item: OrgItem) => void;
  onRename: ((item: OrgItem) => void) | null;
  onCommit: (item: OrgItem, name: string) => void;
  onCancel: (item: OrgItem) => void;
}

function StackItem({
  item,
  groupId,
  groupName,
  title,
  focused,
  pinned,
  dragging,
  dropEdge,
  editing,
  bind,
  menu,
  onShow,
  onRename,
  onCommit,
  onCancel,
}: ItemProps) {
  const detail = item.status ? `${BADGES[item.status.badge].label}: ${item.status.detail}` : "State unknown";
  const kind = item.kind === "agent" ? "coding agent" : "terminal";
  const edge = focused || item.status?.badge === "needs_you" || item.status?.badge === "waiting";
  const body: ReactNode = editing ? (
    <div className={styles.itemMain} data-editing="">
      <ProviderGlyph provider={item.glyph as ProviderId | "shell"} size="xs" />
      <InlineName
        className={styles.itemNameInput}
        value={title}
        label={`Name of ${title}`}
        maxLength={MAX_ITEM_NAME}
        onCommit={(name) => onCommit(item, name)}
        onCancel={() => onCancel(item)}
      />
    </div>
  ) : (
    <button
      type="button"
      className={styles.itemMain}
      title={`${title} — ${detail}`}
      aria-label={`${title}, ${kind}${groupName ? ` in ${groupName}` : ""}, ${detail}${pinned ? ", pinned" : ""}`}
      aria-describedby="stack-help"
      aria-current={focused || undefined}
      data-nav={`item:${item.key}`}
      onClick={() => onShow(item)}
      onDoubleClick={() => onRename?.(item)}
      {...bind}
    >
      <GripVertical className={styles.grip} aria-hidden="true" />
      <ProviderGlyph provider={item.glyph as ProviderId | "shell"} size="xs" />
      <span className={styles.itemTitle}>{title}</span>
      {pinned ? <Pin className={styles.pinMark} aria-hidden="true" /> : null}
      <OrgBadgeChip item={item} />
    </button>
  );
  return (
    <ObjectContextMenu items={menu} label={title}>
      <li
        className={styles.item}
        data-drop-row=""
        data-key={item.key}
        data-group={groupId}
        data-focused={focused || undefined}
        data-badge={item.status?.badge}
        data-dragging={dragging || undefined}
        data-drop-edge={dropEdge}
      >
        {/* The focus / needs-you edge on an inert element, not ::before (see Organization.module.css). */}
        {edge ? <span className={styles.itemEdge} aria-hidden="true" /> : null}
        {body}
        {dropEdge ? <span className={styles.dropLine} aria-hidden="true" /> : null}
        {editing ? null : (
          <IconButton
            size="sm"
            className={styles.itemMenu}
            label={`More for ${title}`}
            icon={<MoreHorizontal />}
            data-no-drag=""
            onClick={(event) => {
              const li = event.currentTarget.closest("li");
              if (li) openObjectContextMenu(li);
            }}
          />
        )}
      </li>
    </ObjectContextMenu>
  );
}

/**
 * An inline name field: Enter saves, Escape cancels, and clicking away saves a valid name. It
 * opens with the name selected, so typing replaces it.
 */
function InlineName({
  value,
  label,
  maxLength,
  className,
  onCommit,
  onCancel,
}: {
  value: string;
  label: string;
  maxLength: number;
  className: string | undefined;
  onCommit: (name: string) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(value);
  const done = useRef(false);
  const input = useRef<HTMLInputElement>(null);
  const openedAt = useRef(0);
  useEffect(() => {
    openedAt.current = performance.now();
    input.current?.focus({ preventScroll: true });
    input.current?.select();
  }, []);
  const finish = (save: boolean) => {
    if (done.current) return;
    done.current = true;
    if (save && draft.trim()) onCommit(draft);
    else onCancel();
  };
  return (
    <input
      ref={input}
      className={className}
      aria-label={label}
      value={draft}
      maxLength={maxLength}
      spellCheck={false}
      onChange={(event) => setDraft(event.target.value)}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Enter") {
          event.preventDefault();
          finish(true);
        } else if (event.key === "Escape") {
          event.preventDefault();
          finish(false);
        }
      }}
      onBlur={(event) => {
        // A double-click first shows the pane, whose terminal then takes focus: keep the field.
        if (performance.now() - openedAt.current < FOCUS_GRACE_MS) {
          const field = event.currentTarget;
          requestAnimationFrame(() => field.focus({ preventScroll: true }));
          return;
        }
        finish(true);
      }}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
    />
  );
}
