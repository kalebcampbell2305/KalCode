import type { PaneContent, PaneNode } from "@kalcode/protocol";
import { ObjectContextMenu, type ObjectMenuItem } from "@kalcode/ui/components";
import {
  memo,
  type PointerEvent,
  type ReactNode,
  type RefObject,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { createPortal } from "react-dom";
import { useOptionalKalVoice } from "../../kalvoice/KalVoiceProvider.tsx";
import { describeBuiltin, renderBuiltin } from "./builtinContent.tsx";
import { type PaneRenderContext, registeredRenderer, subscribeRegistry, type TabInfo } from "./contentRegistry.ts";
import {
  allContents,
  CANVAS_GEOMETRY,
  canSplit as canSplitPane,
  computeGeometry,
  contentKey,
  DEFAULT_GEOMETRY,
  type Divider,
  type DropZone,
  findContent,
  findLeaf,
  type LeafNode,
  leaves,
  minSize,
  movePane,
  moveTab,
  type Rect,
} from "./model.ts";
import styles from "./PaneCanvas.module.css";
import { PaneDivider } from "./PaneDivider.tsx";
import { PaneDock } from "./PaneDock.tsx";
import { bodyDomId, PaneFrame, paneDomId, panelDomId, tabDomId } from "./PaneFrame.tsx";
import {
  listenForPaneCommands,
  type PaneCommand,
  type PaneCommandResult,
  resolvePaneTabQuery,
} from "./paneCommands.ts";
import { type PaneShortcut, paneShortcut } from "./paneShortcuts.ts";
import type { PaneController } from "./usePaneController.ts";

/** What the surface hosting the canvas provides. */
export interface PaneHost {
  /** Describes contents the host owns; return null to use the registry / built-in states. */
  describe(content: PaneContent): TabInfo | null;
  /** Renders contents the host owns; return null to use the registry / built-in states. */
  render(content: PaneContent, context: PaneRenderContext): ReactNode | null;
  /** The body of an empty pane (what can be opened there). */
  renderEmpty(paneId: string): ReactNode;
  /** Items of a pane's "Add" menu. */
  addMenu(paneId: string): ReactNode;
  /** Actions bound to the exact tab or body the user invoked. */
  contextMenu?(content: PaneContent, paneId: string): readonly ObjectMenuItem[];
  /** Commands the host handles itself (return null to let the canvas handle it). */
  onCommand?(command: PaneCommand): PaneCommandResult | null;
}

/** Header height of a pane: the tab strip. Also a collapsed pane's size. */
const HEADER_PX = DEFAULT_GEOMETRY.collapsedSize;
const DRAG_THRESHOLD = 6;

export { CANVAS_GEOMETRY } from "./model.ts";

/** Grow the scrollable work area instead of shrinking live content below usable dimensions. */
export function canvasExtent(layout: PaneController["layout"], width: number, height: number) {
  const dock = layout.dock.length ? DOCK_PX + DOCK_GAP : 0;
  return {
    width: Math.max(width - dock, layout.maximizedPaneId ? 320 : minSize(layout.root, "horizontal", CANVAS_GEOMETRY)),
    height: Math.max(height, layout.maximizedPaneId ? 220 : minSize(layout.root, "vertical", CANVAS_GEOMETRY)),
  };
}

interface DragSource {
  kind: "tab" | "pane";
  paneId: string;
  index: number;
  title: string;
}

interface DragState {
  source: DragSource;
  start: { x: number; y: number };
  active: boolean;
  target: { paneId: string; zone: DropZone } | null;
}

const ZONE_TEXT: Record<DropZone, string> = {
  center: "Add as a tab",
  left: "Split left",
  right: "Split right",
  top: "Split up",
  bottom: "Split down",
};

/** The pane and drop zone under a point (canvas coordinates). */
export function hitTest(
  panes: Map<string, Rect>,
  x: number,
  y: number,
  visible: Set<string>,
  previous: { paneId: string; zone: DropZone } | null = null,
): { paneId: string; zone: DropZone } | null {
  for (const [paneId, rect] of panes) {
    if (!visible.has(paneId)) continue;
    if (x < rect.x || x > rect.x + rect.width || y < rect.y || y > rect.y + rect.height) continue;
    if (y <= rect.y + HEADER_PX) return { paneId, zone: "center" };
    const rx = (x - rect.x) / Math.max(1, rect.width);
    const ry = (y - rect.y - HEADER_PX) / Math.max(1, rect.height - HEADER_PX);
    const edges: [DropZone, number][] = [
      ["left", rx],
      ["right", 1 - rx],
      ["top", ry],
      ["bottom", 1 - ry],
    ];
    // A small magnetic band prevents jitter around edge/centre and corner boundaries.
    if (previous?.paneId === paneId && previous.zone !== "center") {
      const held = edges.find(([zone]) => zone === previous.zone);
      const nearest = Math.min(...edges.map(([, distance]) => distance));
      if (held && held[1] < 0.34 && held[1] <= nearest + 0.07) return previous;
    }
    const [zone, distance] = edges.reduce((a, b) => (b[1] < a[1] ? b : a));
    return { paneId, zone: distance < 0.28 ? zone : "center" };
  }
  return null;
}

type Item = { type: "pane"; leaf: LeafNode; stripAxis: boolean } | { type: "divider"; divider: Divider };

/** Panes and dividers in reading order, so keyboard focus moves through them naturally. */
function orderedItems(root: PaneNode, dividers: Divider[]): Item[] {
  const items: Item[] = [];
  const visit = (node: PaneNode, path: number[], parentHorizontal: boolean) => {
    if (node.kind === "leaf") {
      items.push({ type: "pane", leaf: node, stripAxis: parentHorizontal });
      return;
    }
    node.children.forEach((child, i) => {
      visit(child, [...path, i], node.axis === "horizontal");
      const divider = dividers.find(
        (d) => d.index === i && d.path.length === path.length && d.path.every((v, k) => v === path[k]),
      );
      if (divider) items.push({ type: "divider", divider });
    });
  };
  visit(root, [], false);
  return items;
}

export interface PaneCanvasProps {
  controller: PaneController;
  host: PaneHost;
  /** Accessible name of the canvas. */
  label: string;
  /** What the canvas arranges (the workspace id): scoped commands wait for this canvas. */
  scope?: string;
  /** The surface hosting the canvas is shown. A hidden canvas ignores keyboard shortcuts. */
  active?: boolean;
}

/** Width of the side dock, when something is docked. */
const DOCK_PX = 184;
const DOCK_GAP = DEFAULT_GEOMETRY.gutter;

/**
 * The pane canvas: a split tree of panes filling its container (Z7-W1). Panes are positioned
 * absolutely from the layout's ratios, so rearranging never re-creates a pane that stays.
 * Dividers resize with the pointer or the keyboard; tabs and pane headers drag onto another
 * pane's centre (as a tab) or edge (a split); every action also has a keyboard path.
 */
/** Subscribes to KalVoice, but forwards only the session fields that can change pane treatment. */
export function PaneCanvas(props: PaneCanvasProps) {
  const kalVoice = useOptionalKalVoice();
  const phase = kalVoice?.state.phase;
  return (
    <StablePaneCanvas
      {...props}
      kalVoiceSessionId={kalVoice?.state.sessionId ?? null}
      kalVoiceCapturing={phase === "listening" || phase === "transcribing"}
      kalVoiceTarget={kalVoice?.dictationTarget ?? null}
    />
  );
}

interface PaneCanvasSurfaceProps extends PaneCanvasProps {
  kalVoiceSessionId: string | null;
  kalVoiceCapturing: boolean;
  kalVoiceTarget: { sessionId: string; paneId: string | null } | null;
}

function PaneCanvasSurface({
  controller,
  host,
  label,
  scope,
  active = true,
  kalVoiceSessionId,
  kalVoiceCapturing,
  kalVoiceTarget,
}: PaneCanvasSurfaceProps) {
  const { layout } = controller;
  const ref = useRef<HTMLDivElement>(null);
  const parking = useRef<HTMLDivElement>(null);
  const mountedContent = useRef(new Set<string>());
  const contentFocus = useRef(new Map<string, { n: number; key: string }>());
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [drag, setDrag] = useState<DragState | null>(null);
  // The ref owns the gesture from pointerdown, before it crosses the threshold and enters
  // render state. An unrelated render in that interval must not overwrite the live gesture.
  const dragRef = useRef<DragState | null>(null);
  const suppressClick = useRef(false);
  // Re-render when a surface registers pane contents (for example the Dashboard).
  const registryVersion = useSyncExternalStore(subscribeRegistry, registryTick, registryTick);

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => {
      const width = Math.floor(element.clientWidth);
      const height = Math.floor(element.clientHeight);
      // A hidden surface measures 0 × 0: keep the last real size for layout and commands.
      if (width === 0 && height === 0) return;
      controller.size.current = canvasExtent(latestController.current.layout, width, height);
      setSize((prev) => (prev.width === width && prev.height === height ? prev : { width, height }));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [controller.size]);

  const docked = layout.dock.length > 0;
  const extent = canvasExtent(layout, size.width || 1200, size.height || 800);
  const paneWidth = extent.width;
  controller.size.current = { width: paneWidth, height: extent.height };
  const geometry = useMemo(
    () => computeGeometry(layout, paneWidth, extent.height, CANVAS_GEOMETRY),
    [layout, paneWidth, extent.height],
  );
  const panes = useMemo(() => leaves(layout.root), [layout]);
  const items = useMemo(() => orderedItems(layout.root, geometry.dividers), [layout.root, geometry.dividers]);
  const maximized = layout.maximizedPaneId;
  const contents = allContents(layout);
  const currentKeys = new Set(contents.map(contentKey));
  for (const key of mountedContent.current) if (!currentKeys.has(key)) mountedContent.current.delete(key);

  // Delivery and visual focus read the same immutable native-session target. This remains pinned
  // if focus moves after push-to-talk starts and ignores stale session identities.
  const kalVoiceTargetPaneId =
    kalVoiceCapturing && kalVoiceTarget?.sessionId === kalVoiceSessionId ? kalVoiceTarget.paneId : null;

  // Plain functions: the canvas re-renders when the host or the registry (registryVersion) changes.
  void registryVersion;
  const describe = (content: PaneContent): TabInfo =>
    host.describe(content) ?? registeredRenderer(content)?.describe(content) ?? describeBuiltin(content);
  const renderContent = (content: PaneContent, context: PaneRenderContext) => {
    const own = host.render(content, context);
    if (own !== null && own !== undefined) return own;
    const registered = registeredRenderer(content);
    return registered ? registered.render(content, context) : renderBuiltin(content);
  };

  const titleOfPane = (paneId: string) => {
    const leaf = findLeaf(layout, paneId);
    const active = leaf?.tabs[leaf.activeTab];
    return active ? describe(active).title : "Empty pane";
  };

  // ---------- Commands from outside (palette, KalVoice, Dashboard) ----------
  const latestController = useRef(controller);
  latestController.current = controller;
  const latestHost = useRef(host);
  latestHost.current = host;
  const activeRef = useRef(active);
  activeRef.current = active;
  useEffect(() => {
    if (!active) return;
    return listenForPaneCommands((command) => {
      const handled = latestHost.current.onCommand?.(command);
      if (handled) return handled;
      return runCommand(latestController.current, command, (content) => {
        const owned = latestHost.current.describe(content);
        return owned ?? registeredRenderer(content)?.describe(content) ?? describeBuiltin(content);
      });
    }, scope ?? null);
  }, [scope, active]);

  // ---------- Keyboard shortcuts ----------
  // Anywhere on the surface hosting the canvas, including inside terminals (they let pane
  // shortcuts through); not while a dialog or menu has focus.
  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.defaultPrevented || !activeRef.current) return;
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest('[role="dialog"], [role="menu"], [role="listbox"]')) return;
      if (event.key === "Escape" && dragRef.current) {
        event.preventDefault();
        dragRef.current = null;
        setDrag(null);
        return;
      }
      const shortcut = paneShortcut(event);
      if (!shortcut) return;
      const current = latestController.current;
      const paneId = current.focusedPaneId;
      if (!paneId) return;
      event.preventDefault();
      runShortcut(current, paneId, shortcut);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // ---------- Drag and drop (tabs and whole panes) ----------
  const beginDrag = (event: PointerEvent<HTMLElement>, source: DragSource) => {
    if (event.button !== 0 || panes.length === 0) return;
    const start = { x: event.clientX, y: event.clientY };
    const state: DragState = { source, start, active: false, target: null };
    dragRef.current = state;
    const onMove = (e: globalThis.PointerEvent) => {
      const current = dragRef.current;
      const canvas = ref.current;
      if (!current || !canvas) return;
      if (!current.active && Math.hypot(e.clientX - start.x, e.clientY - start.y) < DRAG_THRESHOLD) return;
      // The window listener outlives the render that installed it. A ResizeObserver update or
      // layout command can land between pointerdown and the first move, so hit testing must use
      // one current controller/layout snapshot and the canvas' current dimensions.
      const currentController = latestController.current;
      const currentLayout = currentController.layout;
      const width = Math.floor(canvas.clientWidth);
      const height = Math.floor(canvas.clientHeight);
      const currentExtent = canvasExtent(currentLayout, width, height);
      currentController.size.current = currentExtent;
      setSize((previous) => (previous.width === width && previous.height === height ? previous : { width, height }));
      const currentGeometry = computeGeometry(
        currentLayout,
        currentExtent.width,
        currentExtent.height,
        CANVAS_GEOMETRY,
      );
      const currentPanes = leaves(currentLayout.root);
      const currentMaximized = currentLayout.maximizedPaneId;
      if (currentMaximized) currentGeometry.panes.set(currentMaximized, { x: 0, y: 0, ...currentExtent });
      const currentVisible = new Set(
        currentPanes
          .filter((pane) => !pane.collapsed && (!currentMaximized || pane.paneId === currentMaximized))
          .map((pane) => pane.paneId),
      );
      const currentSource = findLeaf(currentLayout, source.paneId);
      const bounds = canvas.getBoundingClientRect();
      const target = hitTest(
        currentGeometry.panes,
        e.clientX - bounds.left + canvas.scrollLeft,
        e.clientY - bounds.top + canvas.scrollTop,
        currentVisible,
        current.target,
      );
      const valid =
        currentSource &&
        (source.kind === "pane" || source.index < currentSource.tabs.length) &&
        target &&
        !(target.paneId === source.paneId && (source.kind === "pane" || target.zone === "center")) &&
        !(source.kind === "tab" && target.paneId === source.paneId && currentSource.tabs.length < 2);
      const nextTarget = valid ? target : null;
      // Pointer moves inside the same drop zone change nothing on screen: skip the render.
      if (current.active && current.target?.paneId === nextTarget?.paneId && current.target?.zone === nextTarget?.zone)
        return;
      const next = { ...current, active: true, target: nextTarget };
      dragRef.current = next;
      setDrag(next);
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      const current = dragRef.current;
      dragRef.current = null;
      setDrag(null);
      if (!current?.active) return;
      suppressClick.current = true;
      setTimeout(() => {
        suppressClick.current = false;
      }, 0);
      if (!current.target) return;
      const currentController = latestController.current;
      if (source.kind === "tab")
        currentController.moveTab(source.paneId, source.index, current.target.paneId, current.target.zone);
      else currentController.movePane(source.paneId, current.target.paneId, current.target.zone);
    };
    const onCancel = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      dragRef.current = null;
      setDrag(null);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
  };

  const overlay =
    drag?.active && drag.target
      ? (() => {
          const source = findLeaf(layout, drag.source.paneId);
          const selected = source?.tabs[drag.source.kind === "tab" ? drag.source.index : source.activeTab];
          const preview =
            drag.source.kind === "tab"
              ? moveTab(layout, drag.source.paneId, drag.source.index, drag.target.paneId, drag.target.zone)
              : movePane(layout, drag.source.paneId, drag.target.paneId, drag.target.zone);
          if (preview === layout) return null;
          const destination = selected ? findContent(preview, contentKey(selected))?.paneId : drag.source.paneId;
          const previewExtent = canvasExtent(preview, size.width || 1200, size.height || 800);
          const zone = destination
            ? computeGeometry(preview, previewExtent.width, previewExtent.height, CANVAS_GEOMETRY).panes.get(
                destination,
              )
            : null;
          if (!zone) return null;
          return (
            <div
              className={styles.dropZone}
              data-zone={drag.target.zone}
              aria-hidden="true"
              style={{ left: zone.x, top: zone.y, width: zone.width, height: zone.height }}
            >
              <span className={styles.dropLabel}>
                {ZONE_TEXT[drag.target.zone]} · {drag.source.title}
              </span>
            </div>
          );
        })()
      : null;

  const count = panes.length;
  const multiple = count > 1;
  const openPanes = panes.filter((p) => !p.collapsed).length;

  return (
    // biome-ignore lint/a11y/useSemanticElements: a group of panes, not a form; fieldset would imply form controls.
    <div
      ref={ref}
      className={styles.canvas}
      role="group"
      aria-label={label}
      aria-roledescription="pane canvas"
      data-pane-canvas
      data-dragging={drag?.active || undefined}
      data-maximized={maximized ? "true" : undefined}
      data-panes={count}
    >
      <p className="visually-hidden" role="status" aria-live="polite" aria-atomic="true">
        {controller.message.text}
      </p>
      <p className="visually-hidden" role="status" aria-live="polite" aria-atomic="true">
        {kalVoiceTargetPaneId ? `KalVoice is listening to ${titleOfPane(kalVoiceTargetPaneId)}.` : ""}
      </p>
      <div
        className={styles.stage}
        style={{ width: paneWidth + (docked ? DOCK_PX + DOCK_GAP : 0), height: extent.height }}
      >
        {items.map((item) => {
          if (item.type === "divider") {
            if (maximized) return null;
            const d = item.divider;
            const split = nodeAtPath(layout.root, d.path);
            const beforeNode = split?.kind === "split" ? split.children[d.index] : undefined;
            const afterNode = split?.kind === "split" ? split.children[d.index + 1] : undefined;
            const beforeLeaves = beforeNode ? leaves(beforeNode) : [];
            const afterLeaves = afterNode ? leaves(afterNode) : [];
            const name = (list: LeafNode[]) =>
              list.length === 1 && list[0] ? titleOfPane(list[0].paneId) : `${list.length} panes`;
            return (
              <PaneDivider
                key={`divider-${d.path.join(".")}-${d.index}`}
                divider={d}
                layout={layout}
                before={name(beforeLeaves)}
                after={name(afterLeaves)}
                controls={[...beforeLeaves, ...afterLeaves].map((l) => paneDomId(l.paneId)).join(" ")}
                onResize={(next) => controller.replace(next)}
                onEven={() => controller.evenDivider(d.path, d.index)}
                onFocus={() => undefined}
              />
            );
          }
          const leaf = item.leaf;
          const index = panes.indexOf(leaf);
          const rect =
            maximized === leaf.paneId
              ? { x: 0, y: 0, width: paneWidth, height: extent.height }
              : geometry.panes.get(leaf.paneId);
          if (!rect) return null;
          const hidden = maximized !== null && maximized !== leaf.paneId;
          const tabs = leaf.tabs.map(describe);
          return (
            <PaneFrame
              key={leaf.paneId}
              leaf={leaf}
              index={index}
              count={count}
              rect={rect}
              collapsedStrip={item.stripAxis}
              hidden={hidden}
              maximized={maximized === leaf.paneId}
              focused={controller.focusedPaneId === leaf.paneId}
              kalVoiceTarget={kalVoiceTargetPaneId === leaf.paneId}
              focusRequest={controller.focusRequest.paneId === leaf.paneId ? controller.focusRequest.n : 0}
              canSplit={
                canSplitPane(layout, leaf.paneId, "horizontal") || canSplitPane(layout, leaf.paneId, "vertical")
              }
              canCollapse={multiple && openPanes > 1}
              multiple={multiple}
              dropTarget={drag?.active === true && drag.target?.paneId === leaf.paneId}
              tabs={tabs}
              renderEmpty={host.renderEmpty}
              addMenu={host.addMenu}
              contextMenu={host.contextMenu}
              onFocus={(paneId) => {
                if (controller.focusedPaneId !== paneId) controller.focusPane(paneId, false);
              }}
              onActivate={(i, focusContent) => {
                controller.activate(leaf.paneId, i);
                controller.focusPane(leaf.paneId, focusContent);
              }}
              onCloseTab={(i) => {
                const info = tabs[i];
                if (info?.onClose) info.onClose();
                else controller.hideTab(leaf.paneId, i);
              }}
              onSplit={(axis) => controller.split(leaf.paneId, axis)}
              onMaximize={() => controller.toggleMaximize(leaf.paneId)}
              onCollapse={() => controller.toggleCollapse(leaf.paneId)}
              onClose={() => controller.close(leaf.paneId)}
              onDock={() => controller.dock(leaf.paneId)}
              onSwap={(direction) => controller.swapWith(leaf.paneId, direction)}
              onTabPointerDown={(event, i) =>
                beginDrag(event, { kind: "tab", paneId: leaf.paneId, index: i, title: tabs[i]?.title ?? "Tab" })
              }
              onHeaderPointerDown={(event) => {
                const target = event.target as HTMLElement;
                if (target.closest('[role="tab"], [data-no-drag], button')) return;
                beginDrag(event, { kind: "pane", paneId: leaf.paneId, index: -1, title: titleOfPane(leaf.paneId) });
              }}
              consumeClick={() => suppressClick.current}
            />
          );
        })}
        <div ref={parking} hidden aria-hidden="true" />
        {contents.map((content) => {
          const key = contentKey(content);
          const location = findContent(layout, key);
          const leaf = location ? findLeaf(layout, location.paneId) : null;
          const active = !!leaf && leaf.activeTab === location?.index;
          const visible = active && !leaf.collapsed && (!maximized || maximized === leaf.paneId);
          // Initialize on first visibility; thereafter layout changes only hide or move the host.
          if (visible) mountedContent.current.add(key);
          if (!mountedContent.current.has(key)) return null;
          const request = leaf && controller.focusRequest.paneId === leaf.paneId ? controller.focusRequest.n : 0;
          if (leaf && request !== contentFocus.current.get(leaf.paneId)?.n) {
            contentFocus.current.set(leaf.paneId, {
              n: request,
              key: contentKey(leaf.tabs[leaf.activeTab] ?? content),
            });
          }
          const focus = leaf ? contentFocus.current.get(leaf.paneId) : undefined;
          const context: PaneRenderContext = {
            paneId: leaf?.paneId ?? "",
            tabId: leaf && location ? tabDomId(leaf.paneId, location.index) : "",
            focused: visible && controller.focusedPaneId === leaf?.paneId,
            visible,
            focusRequest: visible && focus?.key === key ? focus.n : 0,
          };
          return (
            <PersistentContent
              key={key}
              content={content}
              context={context}
              active={active}
              parking={parking}
              renderContent={renderContent}
              contextMenu={host.contextMenu}
              title={describe(content).title}
              onFocus={() => {
                if (leaf && visible) controller.focusPane(leaf.paneId, false);
              }}
            />
          );
        })}
        {overlay}
        {docked ? (
          <PaneDock
            items={layout.dock.map((content) => ({ content, info: describe(content) }))}
            style={{ left: paneWidth + DOCK_GAP, top: 0, width: DOCK_PX, height: extent.height }}
            onOpen={(i) => controller.undock(i)}
            onRemove={(i) => controller.removeFromDock(i)}
          />
        ) : null}
      </div>
    </div>
  );
}

/** The portal target never changes. Only its DOM placement does: no React remount or PTY detach. */
function PersistentContent({
  content,
  context,
  active,
  parking,
  renderContent,
  contextMenu,
  title,
  onFocus,
}: {
  content: PaneContent;
  context: PaneRenderContext;
  active: boolean;
  parking: RefObject<HTMLDivElement | null>;
  renderContent: (content: PaneContent, context: PaneRenderContext) => ReactNode;
  contextMenu: PaneHost["contextMenu"];
  title: string;
  onFocus: () => void;
}) {
  const [container] = useState(() => document.createElement("div"));
  useLayoutEffect(() => {
    const destination = document.getElementById(bodyDomId(context.paneId)) ?? parking.current;
    if (!destination) return;
    const focused = container.contains(document.activeElement) ? (document.activeElement as HTMLElement) : null;
    if (container.parentElement !== destination) destination.appendChild(container);
    if (container.className !== styles.panel) container.className = styles.panel ?? "";
    if (container.hidden !== (context.visible === false)) container.hidden = context.visible === false;
    if (container.getAttribute("role") !== "tabpanel") container.setAttribute("role", "tabpanel");
    if (context.tabId && container.getAttribute("aria-labelledby") !== context.tabId)
      container.setAttribute("aria-labelledby", context.tabId);
    else if (!context.tabId && container.hasAttribute("aria-labelledby")) container.removeAttribute("aria-labelledby");
    const panelId = active && context.paneId ? panelDomId(context.paneId) : "";
    if (container.id !== panelId) container.id = panelId;
    if (context.visible && focused && document.activeElement !== focused) focused.focus({ preventScroll: true });
  });
  useLayoutEffect(() => () => container.remove(), [container]);
  const body = (
    <div className={styles.contentHost} onFocusCapture={onFocus} onPointerDownCapture={onFocus}>
      {renderContent(content, context)}
    </div>
  );
  return createPortal(
    contextMenu ? (
      <ObjectContextMenu label={`${title} actions`} items={contextMenu(content, context.paneId)}>
        {body}
      </ObjectContextMenu>
    ) : (
      body
    ),
    container,
  );
}

const StablePaneCanvas = memo(PaneCanvasSurface);

let tick = 0;
subscribeRegistry(() => {
  tick++;
});
function registryTick() {
  return tick;
}

function nodeAtPath(root: PaneNode, path: readonly number[]): PaneNode | null {
  let current: PaneNode = root;
  for (const i of path) {
    if (current.kind !== "split") return null;
    const next = current.children[i];
    if (!next) return null;
    current = next;
  }
  return current;
}

function runShortcut(controller: PaneController, paneId: string, shortcut: PaneShortcut) {
  switch (shortcut.kind) {
    case "move":
      controller.swapWith(paneId, shortcut.direction);
      break;
    case "tidy":
      controller.tidy();
      break;
    case "undo-layout":
      controller.undoLayout();
      break;
    case "focus":
      controller.focusDirection(shortcut.direction);
      break;
    case "resize":
      controller.resize(paneId, shortcut.direction);
      break;
    case "split-right":
      controller.split(paneId, "horizontal");
      break;
    case "split-down":
      controller.split(paneId, "vertical");
      break;
    case "maximize":
      controller.toggleMaximize(paneId);
      break;
    case "close":
      controller.close(paneId);
      break;
    case "reopen":
      controller.reopen();
      break;
    case "collapse":
      controller.toggleCollapse(paneId);
      break;
    case "next-tab":
      controller.cycleTab(1);
      break;
    case "previous-tab":
      controller.cycleTab(-1);
      break;
    case "preset":
      controller.preset(shortcut.preset);
      break;
    case "even":
      controller.even();
      break;
  }
}

/** The canvas's own handling of commands (after the host had its chance). */
export function runCommand(
  controller: PaneController,
  command: PaneCommand,
  describe: (content: PaneContent) => TabInfo,
): PaneCommandResult {
  const paneId = controller.focusedPaneId;
  switch (command.kind) {
    case "split": {
      if (!paneId) return { handled: false, message: "There's no pane to split." };
      const created = controller.split(paneId, command.axis, command.content);
      return created ? { handled: true } : { handled: false, message: "There's no room for another pane here." };
    }
    case "resize":
      if (!paneId) return { handled: false, message: "There's no pane to resize." };
      controller.resize(paneId, command.direction, command.steps);
      return { handled: true };
    case "focus-direction":
      controller.focusDirection(command.direction);
      return { handled: true };
    case "open":
      controller.show(command.content, { focus: true, placement: command.placement });
      return { handled: true };
    case "close": {
      if (!command.content && command.query === undefined) {
        if (!paneId) return { handled: false, message: "There's no pane to close." };
        controller.close(paneId);
        return { handled: true };
      }
      const direct = command.content
        ? leaves(controller.layout.root).flatMap((leaf) =>
            leaf.tabs.flatMap((content, tabIndex) =>
              contentKey(content) === contentKey(command.content as PaneContent)
                ? [{ kind: "found" as const, paneId: leaf.paneId, tabIndex }]
                : [],
            ),
          )[0]
        : null;
      const resolved =
        direct ??
        resolvePaneTabQuery(
          command.query ?? "",
          leaves(controller.layout.root).flatMap((leaf) =>
            leaf.tabs.map((content, tabIndex) => ({
              paneId: leaf.paneId,
              tabIndex,
              names: [describe(content).title],
            })),
          ),
        );
      if (resolved?.kind !== "found")
        return {
          handled: false,
          message:
            resolved?.kind === "ambiguous"
              ? `More than one tab matches “${command.query}”. Which one?`
              : command.query
                ? `No tab matches “${command.query}”.`
                : "That tab is no longer open.",
        };
      const content = findLeaf(controller.layout, resolved.paneId)?.tabs[resolved.tabIndex];
      if (!content) return { handled: false, message: "That tab is no longer open." };
      const info = describe(content);
      if (info.onClose) info.onClose();
      else controller.hideTab(resolved.paneId, resolved.tabIndex);
      return { handled: true };
    }
    case "maximize":
      if (!paneId) return { handled: false, message: "There's no pane to maximize." };
      if (controller.layout.maximizedPaneId !== paneId) controller.toggleMaximize(paneId);
      return { handled: true };
    case "restore":
      controller.restore();
      return { handled: true };
    case "collapse":
      if (paneId) controller.toggleCollapse(paneId);
      return { handled: true };
    case "reopen":
      controller.reopen();
      return { handled: true };
    case "preset":
      controller.preset(command.preset);
      return { handled: true };
    case "even":
      controller.even();
      return { handled: true };
    case "arrange-providers":
    case "open-provider-panes":
    case "open-agent-launcher":
    case "agent-browser-beside":
    case "control-pane":
      return { handled: false, message: "Provider panes aren't available here." };
    case "browser-control":
      return { handled: false, message: "The browser pane isn't available here." };
    case "open-live-browser":
      return { handled: false, message: "Live Browser isn't available here." };
  }
}
