import type { PaneContent, PaneDirection } from "@kalcode/protocol";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  IconButton,
  ObjectContextMenu,
  type ObjectMenuItem,
  Tooltip,
} from "@kalcode/ui/components";
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ChevronDown,
  ChevronRight,
  Columns2,
  Maximize2,
  Minimize2,
  MoreHorizontal,
  PanelBottomClose,
  PanelRightClose,
  Plus,
  Rows2,
  Square,
  X,
} from "lucide-react";
import { type KeyboardEvent, type PointerEvent, type ReactElement, type ReactNode, useEffect, useRef } from "react";
import { useOptionalWorkspaces } from "../../runtime/WorkspaceProvider.tsx";
import { FavoriteButton, useFavoriteMenuItems } from "../favorites/FavoriteActions.tsx";
import type { FavoriteTarget } from "../favorites/model.ts";
import type { TabInfo } from "./contentRegistry.ts";
import { contentKey, type LeafNode, type Rect } from "./model.ts";
import styles from "./PaneCanvas.module.css";
import { PANE_SHORTCUT_LABELS } from "./paneShortcuts.ts";

export const paneDomId = (paneId: string) => `pane-${paneId}`;
export const tabDomId = (paneId: string, index: number) => `pane-${paneId}-tab-${index}`;
export const bodyDomId = (paneId: string) => `pane-${paneId}-body`;
export const panelDomId = (paneId: string) => `pane-${paneId}-panel`;

export interface PaneFrameProps {
  workspaceId?: string;
  leaf: LeafNode;
  index: number;
  count: number;
  rect: Rect;
  /** Set when the pane is collapsed inside a side-by-side split (a vertical strip). */
  collapsedStrip: boolean;
  hidden: boolean;
  maximized: boolean;
  focused: boolean;
  /** This pane owns the immutable destination for the current KalVoice capture. */
  kalVoiceTarget: boolean;
  focusRequest: number;
  canSplit: boolean;
  canCollapse: boolean;
  multiple: boolean;
  dropTarget: boolean;
  tabs: TabInfo[];
  renderEmpty: (paneId: string) => ReactNode;
  addMenu: (paneId: string) => ReactNode;
  contextMenu?: (content: PaneContent, paneId: string) => readonly ObjectMenuItem[];
  onFocus: (paneId: string) => void;
  onActivate: (index: number, focusContent: boolean) => void;
  onCloseTab: (index: number) => void;
  onSplit: (axis: "horizontal" | "vertical") => void;
  onMaximize: () => void;
  onCollapse: () => void;
  onClose: () => void;
  onDock: () => void;
  onSwap: (direction: PaneDirection) => void;
  onTabPointerDown: (event: PointerEvent<HTMLElement>, index: number) => void;
  onHeaderPointerDown: (event: PointerEvent<HTMLElement>) => void;
  /** True right after a drag, so the click that ends it doesn't activate a tab. */
  consumeClick: () => boolean;
}

const SWAP: { direction: PaneDirection; label: string; icon: ReactNode }[] = [
  { direction: "left", label: "Move pane left", icon: <ArrowLeft /> },
  { direction: "right", label: "Move pane right", icon: <ArrowRight /> },
  { direction: "up", label: "Move pane up", icon: <ArrowUp /> },
  { direction: "down", label: "Move pane down", icon: <ArrowDown /> },
];

function paneFavoriteTarget(content: PaneContent, workspaceId: string | null): FavoriteTarget | null {
  if (!workspaceId) return null;
  if (content.kind === "terminal") return { kind: "terminal", id: content.terminalId, workspaceId };
  if (content.kind === "agent") return { kind: "agent", id: content.agentId, workspaceId };
  if (content.kind === "thread") return { kind: "thread", id: content.threadId, workspaceId };
  return null;
}

function PaneObjectMenu({
  content,
  workspaceId,
  title,
  items,
  children,
}: {
  content: PaneContent;
  workspaceId: string | null;
  title: string;
  items: readonly ObjectMenuItem[];
  children: ReactElement;
}) {
  const favorites = useFavoriteMenuItems(paneFavoriteTarget(content, workspaceId), title);
  return (
    <ObjectContextMenu label={`${title} actions`} items={[...favorites, ...items]}>
      {children}
    </ObjectContextMenu>
  );
}

/**
 * Pane chrome and its content slot. Persistent content hosts belong to the canvas, so
 * moving, tabbing, minimizing and docking preserve the mounted view and session identity.
 */
export function PaneFrame(props: PaneFrameProps) {
  const {
    leaf,
    index,
    count,
    rect,
    collapsedStrip,
    hidden,
    maximized,
    focused,
    kalVoiceTarget,
    focusRequest,
    canSplit,
    canCollapse,
    multiple,
    dropTarget,
    tabs,
    renderEmpty,
    addMenu,
    contextMenu,
    onFocus,
    onActivate,
    onCloseTab,
    onSplit,
    onMaximize,
    onCollapse,
    onClose,
    onDock,
    onSwap,
    onTabPointerDown,
    onHeaderPointerDown,
    consumeClick,
  } = props;
  const listRef = useRef<HTMLDivElement>(null);
  const workspaces = useOptionalWorkspaces();
  const workspaceId = props.workspaceId ?? workspaces?.active?.id ?? null;
  const frameRef = useRef<HTMLElement>(null);
  const active = leaf.tabs[leaf.activeTab] ?? null;
  const activeInfo = tabs[leaf.activeTab] ?? null;
  const title = activeInfo?.title ?? "Empty pane";
  const label = `Pane ${index + 1} of ${count}: ${title}`;
  const collapsed = leaf.collapsed;
  const attentionInfo = tabs.find((tab) => tab.attention === "needs-you") ?? tabs.find((tab) => tab.attention);
  const attentionLabel = (info: TabInfo) => (info.attention === "needs-you" ? "Needs You" : "Done");
  function menuFor(content: PaneContent, title: string, child: ReactElement) {
    return (
      <PaneObjectMenu
        key={contentKey(content)}
        content={content}
        workspaceId={workspaceId}
        title={title}
        items={contextMenu?.(content, leaf.paneId) ?? []}
      >
        {child}
      </PaneObjectMenu>
    );
  }
  const body = (
    <div key="body" id={bodyDomId(leaf.paneId)} className={styles.body} data-pane-body hidden={hidden || collapsed}>
      {!active && !hidden && !collapsed ? renderEmpty(leaf.paneId) : null}
    </div>
  );

  // A focus request for this pane: terminal-like content focuses itself; otherwise the tab does.
  // biome-ignore lint/correctness/useExhaustiveDependencies: focus moves on request changes only.
  useEffect(() => {
    if (focusRequest === 0 || hidden) return;
    const frame = requestAnimationFrame(() => {
      frameRef.current?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
      if (collapsed) {
        frameRef.current?.querySelector<HTMLElement>("[data-expand]")?.focus();
        return;
      }
      if (activeInfo?.terminal) return;
      const tab = listRef.current?.querySelector<HTMLElement>('[aria-selected="true"]');
      (tab ?? frameRef.current?.querySelector<HTMLElement>("[data-pane-body] button, [data-pane-body]"))?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [focusRequest]);

  const onTabsKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const n = leaf.tabs.length;
    if (n === 0) return;
    const move = (next: number) => {
      event.preventDefault();
      const target = (next + n) % n;
      tabs[target]?.onAttentionSeen?.();
      onActivate(target, false);
      requestAnimationFrame(() => document.getElementById(tabDomId(leaf.paneId, target))?.focus());
    };
    switch (event.key) {
      case "ArrowRight":
        move(leaf.activeTab + 1);
        break;
      case "ArrowLeft":
        move(leaf.activeTab - 1);
        break;
      case "Home":
        move(0);
        break;
      case "End":
        move(n - 1);
        break;
      case "Enter":
      case " ":
        event.preventDefault();
        activeInfo?.onAttentionSeen?.();
        onActivate(leaf.activeTab, true);
        break;
      case "Delete":
        event.preventDefault();
        onCloseTab(leaf.activeTab);
        break;
    }
  };

  const style = { left: rect.x, top: rect.y, width: rect.width, height: rect.height };

  if (collapsed) {
    return (
      <section
        ref={frameRef}
        id={paneDomId(leaf.paneId)}
        className={styles.frame}
        data-pane-id={leaf.paneId}
        data-collapsed={collapsedStrip ? "strip" : "bar"}
        data-focused={focused || undefined}
        data-attention={attentionInfo?.attention}
        data-kalvoice-target={kalVoiceTarget ? "listening" : undefined}
        hidden={hidden}
        aria-current={focused ? "true" : undefined}
        aria-label={`${label} (collapsed)`}
        style={style}
        onFocusCapture={() => onFocus(leaf.paneId)}
      >
        <div className={styles.collapsedBar}>
          <Tooltip
            content={`Expand ${title} (${PANE_SHORTCUT_LABELS.collapse})`}
            side={collapsedStrip ? "right" : "top"}
          >
            <IconButton
              size="sm"
              data-expand
              label={`Expand ${title}`}
              aria-expanded={false}
              icon={collapsedStrip ? <ChevronRight /> : <ChevronDown />}
              onClick={onCollapse}
            />
          </Tooltip>
          <span className={styles.collapsedGlyph} aria-hidden="true">
            {activeInfo?.glyph}
          </span>
          <span className={styles.collapsedTitle}>{title}</span>
          {attentionInfo ? (
            <span
              className={styles.tabState}
              data-attention-badge
              title={`${attentionInfo.title}: ${attentionLabel(attentionInfo)}`}
            >
              {attentionLabel(attentionInfo)}
            </span>
          ) : null}
          {leaf.tabs.length > 1 ? <span className={styles.collapsedCount}>+{leaf.tabs.length - 1}</span> : null}
          {activeInfo?.tone ? <span className={styles.dot} data-tone={activeInfo.tone} aria-hidden="true" /> : null}
        </div>
        {body}
      </section>
    );
  }

  return (
    <section
      ref={frameRef}
      id={paneDomId(leaf.paneId)}
      className={styles.frame}
      data-pane-id={leaf.paneId}
      data-focused={focused || undefined}
      data-attention={attentionInfo?.attention}
      data-kalvoice-target={kalVoiceTarget ? "listening" : undefined}
      data-maximized={maximized || undefined}
      data-drop-target={dropTarget || undefined}
      data-terminal={activeInfo?.terminal || undefined}
      hidden={hidden}
      aria-current={focused ? "true" : undefined}
      aria-label={label}
      style={style}
      onFocusCapture={(event) => {
        onFocus(leaf.paneId);
        if ((event.target as HTMLElement).closest("[data-pane-body]")) activeInfo?.onAttentionSeen?.();
      }}
      onPointerDownCapture={(event) => {
        onFocus(leaf.paneId);
        if ((event.target as HTMLElement).closest("[data-pane-body]")) activeInfo?.onAttentionSeen?.();
      }}
    >
      {/* biome-ignore lint/a11y/noStaticElementInteractions: dragging the header moves the pane; the menu offers the same moves by keyboard. */}
      <header
        className={styles.header}
        onPointerDown={onHeaderPointerDown}
        onDoubleClick={multiple ? onMaximize : undefined}
      >
        <div
          ref={listRef}
          role="tablist"
          aria-label={`Tabs in pane ${index + 1}`}
          className={styles.tabs}
          onKeyDown={onTabsKeyDown}
        >
          {leaf.tabs.map((content, i) => {
            const info = tabs[i];
            if (!info) return null;
            const selected = i === leaf.activeTab;
            return menuFor(
              content,
              info.title,
              // biome-ignore lint/a11y/useKeyWithClickEvents: the tablist handles keys for every tab (roving focus).
              <div
                key={contentKey(content)}
                id={tabDomId(leaf.paneId, i)}
                role="tab"
                aria-label={info.attention ? `${info.title} ${attentionLabel(info)}` : undefined}
                tabIndex={selected ? 0 : -1}
                aria-selected={selected}
                aria-controls={selected ? panelDomId(leaf.paneId) : undefined}
                className={styles.tab}
                data-tone={info.tone}
                data-attention={info.attention}
                data-kind={content.kind}
                data-content-key={contentKey(content)}
                title={info.statusText ? `${info.title} — ${info.statusText}` : info.title}
                onPointerDown={(event) => onTabPointerDown(event, i)}
                onClick={() => {
                  if (consumeClick()) return;
                  info.onAttentionSeen?.();
                  onActivate(i, true);
                }}
                onMouseDown={(event) => {
                  if (event.button === 1) {
                    event.preventDefault();
                    onCloseTab(i);
                  }
                }}
              >
                <span className={styles.tabGlyph} aria-hidden="true">
                  {info.glyph}
                </span>
                <span className={styles.tabLabel}>{info.title}</span>
                {/* A state word carries its tone itself; otherwise the dot does. */}
                {info.attention || info.stateLabel ? (
                  <span
                    className={styles.tabState}
                    data-tone={info.tone}
                    data-attention-badge={info.attention ? "true" : undefined}
                  >
                    {info.attention ? attentionLabel(info) : info.stateLabel}
                  </span>
                ) : info.tone ? (
                  <span className={styles.dot} data-tone={info.tone} aria-hidden="true" />
                ) : null}
                {/* Mouse affordance; keyboard users close with Delete (or Ctrl+Shift+W in Code). */}
                <span
                  className={styles.tabClose}
                  data-tab-close
                  aria-hidden="true"
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={(event) => {
                    event.stopPropagation();
                    onCloseTab(i);
                  }}
                >
                  <X />
                </span>
              </div>,
            );
          })}
        </div>
        <div className={styles.addTab} data-no-drag>
          <DropdownMenu>
            <Tooltip content="Add to this pane" side="bottom">
              <DropdownMenuTrigger asChild>
                <IconButton size="sm" label={`Add to pane ${index + 1}`} icon={<Plus />} />
              </DropdownMenuTrigger>
            </Tooltip>
            {/* The add menu is long (shells, Browser, widgets): it uses the room the window has and
                scrolls only when that runs out, instead of the default 28rem cap. */}
            <DropdownMenuContent
              align="start"
              minWidth={16}
              style={{ maxHeight: "var(--radix-dropdown-menu-content-available-height)" }}
            >
              {addMenu(leaf.paneId)}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        <div className={styles.headerActions} data-no-drag>
          {active && paneFavoriteTarget(active, workspaceId)
            ? menuFor(
                active,
                title,
                <span>
                  <FavoriteButton target={paneFavoriteTarget(active, workspaceId) as FavoriteTarget} title={title} />
                </span>,
              )
            : null}
          {activeInfo?.actions}
          {maximized ? (
            <span className={styles.maxBadge}>
              Maximized · {count - 1} more {count - 1 === 1 ? "pane" : "panes"}
            </span>
          ) : null}
          {canSplit ? (
            <Tooltip content={`Split right (${PANE_SHORTCUT_LABELS.splitRight})`} side="bottom">
              <IconButton
                size="sm"
                className={styles.optional}
                label={`Split pane ${index + 1} right`}
                icon={<Columns2 />}
                onClick={() => onSplit("horizontal")}
              />
            </Tooltip>
          ) : null}
          {multiple ? (
            <Tooltip content={`${maximized ? "Restore" : "Maximize"} (${PANE_SHORTCUT_LABELS.maximize})`} side="bottom">
              <IconButton
                size="sm"
                className={styles.optional}
                label={maximized ? `Restore pane ${index + 1}` : `Maximize pane ${index + 1}`}
                aria-pressed={maximized}
                icon={maximized ? <Minimize2 /> : <Maximize2 />}
                onClick={onMaximize}
              />
            </Tooltip>
          ) : null}
          <DropdownMenu>
            <Tooltip content="Pane actions" side="bottom">
              <DropdownMenuTrigger asChild>
                <IconButton size="sm" label={`Actions for pane ${index + 1}`} icon={<MoreHorizontal />} />
              </DropdownMenuTrigger>
            </Tooltip>
            <DropdownMenuContent align="end" minWidth={17}>
              <DropdownMenuLabel>{title}</DropdownMenuLabel>
              {canSplit ? (
                <>
                  <DropdownMenuItem
                    icon={<Columns2 />}
                    shortcut={PANE_SHORTCUT_LABELS.splitRight}
                    onSelect={() => onSplit("horizontal")}
                  >
                    Split right
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    icon={<Rows2 />}
                    shortcut={PANE_SHORTCUT_LABELS.splitDown}
                    onSelect={() => onSplit("vertical")}
                  >
                    Split down
                  </DropdownMenuItem>
                </>
              ) : null}
              {multiple ? (
                <DropdownMenuItem
                  icon={maximized ? <Minimize2 /> : <Maximize2 />}
                  shortcut={PANE_SHORTCUT_LABELS.maximize}
                  onSelect={onMaximize}
                >
                  {maximized ? "Restore layout" : "Maximize"}
                </DropdownMenuItem>
              ) : null}
              {canCollapse ? (
                <DropdownMenuItem
                  icon={<PanelBottomClose />}
                  shortcut={PANE_SHORTCUT_LABELS.collapse}
                  onSelect={onCollapse}
                >
                  Collapse
                </DropdownMenuItem>
              ) : null}
              {multiple ? (
                <>
                  <DropdownMenuSeparator />
                  {SWAP.map((s) => (
                    <DropdownMenuItem key={s.direction} icon={s.icon} onSelect={() => onSwap(s.direction)}>
                      {s.label}
                    </DropdownMenuItem>
                  ))}
                </>
              ) : null}
              {leaf.tabs.length > 0 ? (
                <DropdownMenuItem icon={<PanelRightClose />} onSelect={onDock}>
                  Move to the dock
                </DropdownMenuItem>
              ) : null}
              {activeInfo?.stop ? (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem icon={<Square />} tone="danger" onSelect={activeInfo.stop.run}>
                    {activeInfo.stop.label}
                  </DropdownMenuItem>
                </>
              ) : null}
              <DropdownMenuSeparator />
              <DropdownMenuItem icon={<X />} shortcut={PANE_SHORTCUT_LABELS.close} onSelect={onClose}>
                Close pane
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Tooltip content={`Close pane (${PANE_SHORTCUT_LABELS.close})`} side="bottom">
            <IconButton
              size="sm"
              className={styles.closePane}
              label={`Close pane ${index + 1}`}
              icon={<X />}
              onClick={onClose}
            />
          </Tooltip>
        </div>
      </header>
      {body}
    </section>
  );
}
