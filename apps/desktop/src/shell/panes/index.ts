/**
 * The pane system (Z7-W1). Public entry points for other surfaces:
 *
 * - `registerPaneContent` / `registerPaneWidget`: make a surface's content showable in panes
 *   (Z7-W3 registers the live Dashboard and its widgets here).
 * - `dispatchPaneCommand`: ask the canvas on screen to open, focus, split, resize or close
 *   (the Dashboard's "card → pane focus", notifications, KalVoice, the command palette).
 * - `PaneCanvas` + `usePaneController`: host a canvas (the Code surface does).
 */
export {
  isRegistered,
  type PaneContentRenderer,
  type PaneRenderContext,
  registeredWidgets,
  registerPaneContent,
  registerPaneWidget,
  type TabInfo,
} from "./contentRegistry.ts";
export { afterLiveResize, isLiveResizing } from "./liveResize.ts";
export { OutputScheduler } from "./outputScheduler.ts";
export { type PaneCanvasProps, PaneCanvas, type PaneHost } from "./PaneCanvas.tsx";
export {
  dispatchPaneCommand,
  listenForPaneCommands,
  type PaneCommand,
  type PaneCommandResult,
  paneCanvasListening,
} from "./paneCommands.ts";
export { isPaneShortcut, PANE_SHORTCUT_LABELS, paneShortcut } from "./paneShortcuts.ts";
export { type PaneController, type PaneStore, usePaneController } from "./usePaneController.ts";
