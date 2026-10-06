import type { ProviderId } from "@kalcode/protocol";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  IconButton,
  ProviderGlyph,
  StatusChip,
  TextInput,
  Tooltip,
} from "@kalcode/ui/components";
import {
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
  FolderPlus,
  Hand,
  Hourglass,
  Layers,
  ListTree,
  type LucideIcon,
  MoreHorizontal,
  PanelLeftClose,
  Pin,
  PinOff,
  Zap,
} from "lucide-react";
import { type FormEvent, memo, useEffect, useId, useMemo, useRef, useState } from "react";
import { contentKey, leaves } from "../../../shell/panes/model.ts";
import type { PaneController } from "../../../shell/panes/usePaneController.ts";
import { AUTO_GROUPS, BADGES, type OrgBadge, type OrgItem, organize, type StackGroup, stackShown } from "./model.ts";
import styles from "./Organization.module.css";
import type { Organization } from "./useOrganization.ts";

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

interface StackProps {
  organization: Organization;
  controller: PaneController;
}

/**
 * The Terminal Stack: the workspace's terminals and agents grouped by purpose (or as one stack),
 * active work first, waiting work marked, finished work collapsed per group unless it is pinned
 * or focused. Nothing here stops or closes anything; selecting an item shows it.
 */
export const TerminalStack = memo(function TerminalStack({ organization, controller }: StackProps) {
  const { items, prefs } = organization;
  const focusedKey = focusedKeyOf(controller);
  const groups = useMemo(() => organize(items, prefs.prefs, focusedKey), [items, prefs.prefs, focusedKey]);
  const groupNames = useMemo(
    () => [...AUTO_GROUPS, ...prefs.prefs.customGroups.filter((g) => !(AUTO_GROUPS as readonly string[]).includes(g))],
    [prefs.prefs.customGroups],
  );
  const [openFinished, setOpenFinished] = useState<ReadonlySet<string>>(new Set());
  const [adding, setAdding] = useState<{ moveKey: string | null } | null>(null);
  const working = items.filter((i) => i.status?.badge === "working" || i.status?.badge === "testing").length;
  const waiting = items.filter((i) => i.status?.badge === "needs_you").length;

  const shown = stackShown(prefs.prefs, items.length);
  // On a narrow canvas the stack doesn't take the panes' width: the rail opens it over the canvas.
  const [overlay, setOverlay] = useState(false);
  const railRef = useRef<HTMLButtonElement>(null);
  const stackRef = useRef<HTMLElement>(null);
  // The opened overlay takes keyboard focus; closing it gives focus back to the rail.
  useEffect(() => {
    if (overlay) stackRef.current?.focus({ preventScroll: true });
  }, [overlay]);
  const closeOverlay = () => {
    setOverlay(false);
    railRef.current?.focus({ preventScroll: true });
  };
  const rail = (
    <div className={styles.stackRail} data-narrow-only={shown || undefined}>
      <Tooltip content="Show the terminal stack" side="right">
        <button
          ref={railRef}
          type="button"
          className={styles.railButton}
          aria-label={`Show the terminal stack: ${items.length} items, ${working} working, ${waiting} waiting`}
          aria-expanded={shown ? overlay : false}
          onClick={() => (shown ? setOverlay((open) => !open) : prefs.setStackOpen(true))}
          onKeyDown={(event) => {
            if (overlay && event.key === "Escape") {
              event.preventDefault();
              setOverlay(false);
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
  if (!shown) return rail;

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

  return (
    <>
      {rail}
      <aside
        ref={stackRef}
        className={styles.stack}
        aria-label="Terminal stack"
        tabIndex={-1}
        data-overlay={overlay || undefined}
        onKeyDown={(event) => {
          if (overlay && event.key === "Escape") {
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
          <Tooltip content={prefs.prefs.grouping ? "Show one stack" : "Group by purpose"}>
            <IconButton
              size="sm"
              label={prefs.prefs.grouping ? "Show one stack" : "Group by purpose"}
              aria-pressed={prefs.prefs.grouping}
              icon={<ListTree />}
              onClick={() => prefs.setGrouping(!prefs.prefs.grouping)}
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
        <div className={styles.stackBody}>
          {items.length === 0 ? (
            <p className={styles.empty}>No terminals or agents yet. Start one with + Terminal or + Agent.</p>
          ) : null}
          {groups.map((group) => (
            <StackGroupView
              key={group.name}
              group={group}
              grouped={prefs.prefs.grouping}
              finishedOpen={openFinished.has(group.name)}
              focusedKey={focusedKey}
              pinned={prefs.prefs.pinned}
              groupNames={groupNames}
              overrides={prefs.prefs.groupOf}
              onToggle={() => prefs.toggleGroup(group.name)}
              onToggleFinished={() => toggleFinished(group.name)}
              onShow={show}
              onPin={(item) => prefs.togglePin(item.key)}
              onMove={(item, target) => prefs.moveTo(item.key, target)}
              onNewGroup={prefs.prefs.grouping ? (item) => setAdding({ moveKey: item.key }) : null}
            />
          ))}
          {prefs.prefs.grouping ? (
            adding ? (
              <NewGroupForm
                onCancel={() => setAdding(null)}
                onSubmit={(name) => {
                  const clean = prefs.addGroup(name);
                  if (clean && adding.moveKey) prefs.moveTo(adding.moveKey, clean);
                  setAdding(null);
                }}
              />
            ) : (
              <button type="button" className={styles.addGroup} onClick={() => setAdding({ moveKey: null })}>
                <FolderPlus aria-hidden="true" />
                New group
              </button>
            )
          ) : null}
        </div>
      </aside>
    </>
  );
});

interface GroupViewProps {
  group: StackGroup;
  grouped: boolean;
  finishedOpen: boolean;
  focusedKey: string | null;
  pinned: readonly string[];
  groupNames: readonly string[];
  overrides: Readonly<Record<string, string>>;
  onToggle: () => void;
  onToggleFinished: () => void;
  onShow: (item: OrgItem) => void;
  onPin: (item: OrgItem) => void;
  onMove: (item: OrgItem, group: string | null) => void;
  /** Null while grouping is off: a new group has nowhere to show. */
  onNewGroup: ((item: OrgItem) => void) | null;
}

function StackGroupView({
  group,
  grouped,
  finishedOpen,
  focusedKey,
  pinned,
  groupNames,
  overrides,
  onToggle,
  onToggleFinished,
  onShow,
  onPin,
  onMove,
  onNewGroup,
}: GroupViewProps) {
  const listId = useId();
  const total = group.active.length + group.finished.length;
  const collapsed = grouped && group.collapsed;
  const row = (item: OrgItem) => (
    <StackItem
      key={item.key}
      item={item}
      focused={item.key === focusedKey}
      pinned={pinned.includes(item.key)}
      groupNames={groupNames}
      currentGroup={overrides[item.key] ?? null}
      onShow={onShow}
      onPin={onPin}
      onMove={onMove}
      onNewGroup={onNewGroup}
    />
  );
  return (
    <section className={styles.group} aria-label={grouped ? `${group.name} group` : "All terminals and agents"}>
      {grouped ? (
        <button
          type="button"
          className={styles.groupHeader}
          aria-expanded={!collapsed}
          aria-controls={listId}
          onClick={onToggle}
        >
          {collapsed ? <ChevronRight aria-hidden="true" /> : <ChevronDown aria-hidden="true" />}
          <span className={styles.groupName}>{group.name}</span>
          <span className={styles.groupTotal}>{total}</span>
          <span className={styles.spacer} />
          {group.counts.waiting > 0 ? (
            <span className={styles.groupCount} data-tone="waiting" title={`${group.counts.waiting} waiting`}>
              <Hand aria-hidden="true" />
              {group.counts.waiting}
            </span>
          ) : null}
          {group.counts.failed > 0 ? (
            <span className={styles.groupCount} data-tone="failed" title={`${group.counts.failed} failed`}>
              <CircleX aria-hidden="true" />
              {group.counts.failed}
            </span>
          ) : null}
          {group.counts.working > 0 ? (
            <span className={styles.groupCount} data-tone="working" title={`${group.counts.working} working`}>
              <Zap aria-hidden="true" />
              {group.counts.working}
            </span>
          ) : null}
          {group.counts.done > 0 ? (
            <span className={styles.groupCount} data-tone="done" title={`${group.counts.done} done`}>
              <CircleCheck aria-hidden="true" />
              {group.counts.done}
            </span>
          ) : null}
        </button>
      ) : null}
      {collapsed ? null : (
        <div id={listId}>
          {total === 0 ? <p className={styles.groupEmpty}>Empty. Move items here from their menu.</p> : null}
          <ul className={styles.items}>{group.active.map(row)}</ul>
          {group.finished.length > 0 ? (
            <>
              <button
                type="button"
                className={styles.finishedToggle}
                aria-expanded={finishedOpen}
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

interface ItemProps {
  item: OrgItem;
  focused: boolean;
  pinned: boolean;
  groupNames: readonly string[];
  /** The group the person moved it to; null in its own purpose group. */
  currentGroup: string | null;
  onShow: (item: OrgItem) => void;
  onPin: (item: OrgItem) => void;
  onMove: (item: OrgItem, group: string | null) => void;
  onNewGroup: ((item: OrgItem) => void) | null;
}

function StackItem({ item, focused, pinned, groupNames, currentGroup, onShow, onPin, onMove, onNewGroup }: ItemProps) {
  const detail = item.status ? `${BADGES[item.status.badge].label}: ${item.status.detail}` : "State unknown";
  return (
    <li className={styles.item} data-focused={focused || undefined} data-badge={item.status?.badge}>
      <button
        type="button"
        className={styles.itemMain}
        title={`${item.title} — ${detail}`}
        aria-label={`${item.title}, ${detail}${pinned ? ", pinned" : ""}`}
        aria-current={focused || undefined}
        onClick={() => onShow(item)}
      >
        <ProviderGlyph provider={item.glyph as ProviderId | "shell"} size="xs" />
        <span className={styles.itemTitle}>{item.title}</span>
        {pinned ? <Pin className={styles.pinMark} aria-hidden="true" /> : null}
        <OrgBadgeChip item={item} />
      </button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <IconButton
            size="sm"
            className={styles.itemMenu}
            label={`More for ${item.title}`}
            icon={<MoreHorizontal />}
          />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" minWidth={14}>
          <DropdownMenuLabel>{item.title}</DropdownMenuLabel>
          <DropdownMenuItem icon={<Eye />} onSelect={() => onShow(item)}>
            Show
          </DropdownMenuItem>
          <DropdownMenuItem
            icon={pinned ? <PinOff /> : <Pin />}
            description={pinned ? undefined : "Stays visible when finished"}
            onSelect={() => onPin(item)}
          >
            {pinned ? "Unpin" : "Pin"}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuLabel>Move to group</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={currentGroup ?? ""}
            onValueChange={(value) => onMove(item, value === "" ? null : value)}
          >
            <DropdownMenuRadioItem value="">{`Automatic (${item.group})`}</DropdownMenuRadioItem>
            {groupNames.map((name) => (
              <DropdownMenuRadioItem key={name} value={name}>
                {name}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
          {onNewGroup ? (
            <DropdownMenuItem icon={<FolderPlus />} onSelect={() => onNewGroup(item)}>
              New group…
            </DropdownMenuItem>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
    </li>
  );
}

function NewGroupForm({ onSubmit, onCancel }: { onSubmit: (name: string) => void; onCancel: () => void }) {
  const [name, setName] = useState("");
  const id = useId();
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (name.trim()) onSubmit(name);
  };
  return (
    <form className={styles.newGroup} onSubmit={submit} aria-label="New group">
      <label className="visually-hidden" htmlFor={id}>
        Group name
      </label>
      <TextInput
        id={id}
        value={name}
        maxLength={40}
        placeholder="Group name"
        autoFocus
        onChange={(event) => setName(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            onCancel();
          }
        }}
      />
    </form>
  );
}
