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
import {
  Fragment,
  type KeyboardEvent,
  type PointerEvent,
  type ReactElement,
  type ReactNode,
  useEffect,
  useRef,
} from "react";
import type { PaneRenderContext, TabInfo } from "./contentRegistry.ts";
import { contentKey, type LeafNode, type Rect } from "./model.ts";
import styles from "./PaneCanvas.module.css";
import { PANE_SHORTCUT_LABELS } from "./paneShortcuts.ts";

export const paneDomId = (paneId: string) => `pane-${paneId}`;
export const tabDomId = (paneId: string, index: number) => `pane-${paneId}-tab-${index}`;
export const panelDomId = (paneId: string) => `pane-${paneId}-panel`;

export interface PaneFrameProps {
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
  renderContent: (content: PaneContent, context: PaneRenderContext) => ReactNode;
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

/**
 * One pane: a header with its tabs (WAI-ARIA tabs, automatic activation) and controls, and the
 * active tab's content. Terminal tabs (shells, provider TUIs) stay mounted once shown, hidden and
 * throttled while another tab is in front or the pane is collapsed or behind a maximized one, so
 * switching back never rebuilds xterm or replays scrollback. Other contents render only while in
 * front; whatever they run keeps running.
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
    renderContent,
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
  const frameRef = useRef<HTMLElement>(null);
  const active = leaf.tabs[leaf.activeTab] ?? null;
  const activeInfo = tabs[leaf.activeTab] ?? null;
  const title = activeInfo?.title ?? "Empty pane";
  const label = `Pane ${index + 1} of ${count}: ${title}`;
  const collapsed = leaf.collapsed;
  // A focus request belongs to the content that was in front when it was made: switching tabs
  // with the arrow keys must not pull focus into the newly shown terminal.
  const activeKey = active ? contentKey(active) : "";
  const seenRequest = useRef({ n: focusRequest, key: activeKey });
  if (focusRequest !== seenRequest.current.n) seenRequest.current = { n: focusRequest, key: activeKey };
  const contentFocusRequest = seenRequest.current.key === activeKey ? seenRequest.current.n : 0;

  // Terminal tabs that have been in front stay mounted (see above); closed tabs are let go.
  const shownBody = !hidden && !collapsed;
  const keptTerminals = useRef(new Set<string>());
  const tabKeys = new Set(leaf.tabs.map(contentKey));
  for (const key of keptTerminals.current) if (!tabKeys.has(key)) keptTerminals.current.delete(key);
  if (shownBody && active && activeInfo?.terminal) keptTerminals.current.add(activeKey);
  const panel = (content: PaneContent, i: number, front: boolean) =>
    menuFor(
      content,
      tabs[i]?.title ?? "Pane",
      <div
        id={front ? panelDomId(leaf.paneId) : undefined}
        role="tabpanel"
        aria-labelledby={tabDomId(leaf.paneId, i)}
        className={styles.panel}
        hidden={!front}
      >
        {renderContent(content, {
          paneId: leaf.paneId,
          tabId: tabDomId(leaf.paneId, i),
          focused: front && focused,
          focusRequest: front ? contentFocusRequest : 0,
        })}
      </div>,
    );
  function menuFor(content: PaneContent, title: string, child: ReactElement) {
    const items = contextMenu?.(content, leaf.paneId);
    return contextMenu ? (
      <ObjectContextMenu key={contentKey(content)} label={`${title} actions`} items={items ?? []}>
        {child}
      </ObjectContextMenu>
    ) : (
      child
    );
  }
  // Keyed so the same element survives collapsing and expanding the pane.
  const body = (
    <div key="body" className={styles.body} data-pane-body hidden={!shownBody}>
      {leaf.tabs.map((content, i) => {
        const key = contentKey(content);
        if (!keptTerminals.current.has(key)) return null;
        return <Fragment key={key}>{panel(content, i, shownBody && i === leaf.activeTab)}</Fragment>;
      })}
      {shownBody && active && !keptTerminals.current.has(activeKey) ? panel(active, leaf.activeTab, true) : null}
      {shownBody && !active ? renderEmpty(leaf.paneId) : null}
    </div>
  );

  // A focus request for this pane: terminal-like content focuses itself; otherwise the tab does.
  // biome-ignore lint/correctness/useExhaustiveDependencies: focus moves on request changes only.
  useEffect(() => {
    if (focusRequest === 0 || hidden) return;
    const frame = requestAnimationFrame(() => {
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
      data-kalvoice-target={kalVoiceTarget ? "listening" : undefined}
      data-maximized={maximized || undefined}
      data-drop-target={dropTarget || undefined}
      data-terminal={activeInfo?.terminal || undefined}
      hidden={hidden}
      aria-current={focused ? "true" : undefined}
      aria-label={label}
      style={style}
      onFocusCapture={() => onFocus(leaf.paneId)}
      onPointerDownCapture={() => onFocus(leaf.paneId)}
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
                tabIndex={selected ? 0 : -1}
                aria-selected={selected}
                aria-controls={selected ? panelDomId(leaf.paneId) : undefined}
                className={styles.tab}
                data-tone={info.tone}
                data-kind={content.kind}
                data-content-key={contentKey(content)}
                title={info.statusText ? `${info.title} — ${info.statusText}` : info.title}
                onPointerDown={(event) => onTabPointerDown(event, i)}
                onClick={() => {
                  if (consumeClick()) return;
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
                {info.stateLabel ? (
                  <span className={styles.tabState} data-tone={info.tone}>
                    {info.stateLabel}
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
