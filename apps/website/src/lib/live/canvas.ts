/** Temporary sample-workspace layout state. Never mutates or recreates running work. */
import { type Frame, isAvailable, type State, toast } from "./model";

export const CANVAS_TASKS = ["build", "debug", "review", "ship", "focus"] as const;
export type CanvasTask = (typeof CANVAS_TASKS)[number];
interface Snapshot {
  frames: Frame[];
  focus: string;
  layout: State["layout"];
  maximized: boolean;
  minimized: string[];
  task: CanvasTask | "tidy" | null;
  share: number;
}
export interface CanvasState {
  minimized: Set<string>;
  task: CanvasTask | "tidy" | null;
  manual: boolean;
  share: number;
  undo: Snapshot | null;
}
const layouts = new WeakMap<State, CanvasState>();
export function canvasState(state: State): CanvasState {
  let canvas = layouts.get(state);
  if (!canvas) {
    canvas = { minimized: new Set(), task: null, manual: false, share: 50, undo: null };
    layouts.set(state, canvas);
  }
  return canvas;
}
const copyFrames = (frames: Frame[]) => frames.map((frame) => ({ ...frame, tabs: [...frame.tabs] }));
function saveUndo(state: State) {
  const canvas = canvasState(state);
  canvas.undo = {
    frames: copyFrames(state.frames),
    focus: state.focus,
    layout: state.layout,
    maximized: state.maximized,
    minimized: [...canvas.minimized],
    task: canvas.task,
    share: canvas.share,
  };
}
export function visibleCanvasFrames(state: State): Frame[] {
  const canvas = canvasState(state);
  return state.frames.filter(
    (frame) => !canvas.minimized.has(frame.id) && (!state.maximized || state.focus === frame.id),
  );
}
export function canvasSuggestion(state: State): CanvasTask {
  if (Object.values(state.tabs).some((tab) => tab.lines?.some((line) => line.k === "err"))) return "debug";
  if (Object.values(state.agents).some((agent) => agent.status === "reviewing" || agent.approval)) return "review";
  return Object.values(state.tabs).some((tab) => tab.kind === "browser") ? "build" : "focus";
}
function rank(state: State, frame: Frame, task: CanvasTask) {
  const preferred =
    task === "debug" || task === "ship"
      ? ["terminal", "browser", "agent", "widget"]
      : ["agent", "browser", "terminal", "widget"];
  return Math.min(...frame.tabs.map((id) => preferred.indexOf(state.tabs[id]?.kind ?? "widget")));
}
/** Only canvas-prefixed actions are claimed; existing app actions retain their authority. */
export function canvasAction(state: State, action: string): boolean {
  if (!action.startsWith("canvas:")) return false;
  const [, command, id, zone, target] = action.split(":");
  const canvas = canvasState(state);
  const frame = state.frames.find((item) => item.id === id);
  switch (command) {
    case "layout": {
      if (!id || !CANVAS_TASKS.includes(id as CanvasTask)) return true;
      saveUndo(state);
      canvas.task = id as CanvasTask;
      canvas.minimized.clear();
      canvas.share = id === "review" ? 60 : id === "debug" ? 40 : 50;
      state.layout = "2";
      state.maximized = id === "focus";
      if (!state.frames.some((item) => item.id === state.focus)) state.focus = state.frames[0]?.id ?? "";
      if (!state.maximized)
        state.frames = [...state.frames].sort(
          (a, b) => rank(state, a, id as CanvasTask) - rank(state, b, id as CanvasTask),
        );
      toast(state, `${label(id)} layout applied. All sessions keep running.`);
      break;
    }
    case "tidy":
      saveUndo(state);
      canvas.task = "tidy";
      canvas.minimized.clear();
      canvas.share = 50;
      state.layout = "2";
      state.maximized = false;
      toast(state, "Tidied the layout. All work is preserved; Undo restores your arrangement.");
      break;
    case "undo": {
      const previous = canvas.undo;
      if (!previous) return true;
      const placed = new Set<string>();
      const restore = (item: Frame): Frame | null => {
        const tabs = item.tabs.filter((tab) => state.tabs[tab] && !placed.has(tab));
        for (const tab of tabs) placed.add(tab);
        if (!tabs.length && item.tabs.length) return null;
        return { ...item, tabs, active: tabs.includes(item.active) ? item.active : (tabs[0] ?? "") };
      };
      const frames = previous.frames.map(restore).filter((item): item is Frame => item !== null);
      for (const current of state.frames) {
        const extra = restore(current);
        if (!extra?.tabs.length) continue;
        const existing = frames.find((item) => item.id === extra.id);
        if (existing) existing.tabs.push(...extra.tabs);
        else frames.push(extra);
      }
      state.frames = frames;
      state.focus = frames.some((item) => item.id === previous.focus) ? previous.focus : (frames[0]?.id ?? "");
      state.layout = previous.layout;
      state.maximized = previous.maximized;
      canvas.minimized = new Set(previous.minimized.filter((key) => frames.some((item) => item.id === key)));
      canvas.task = previous.task;
      canvas.share = previous.share;
      canvas.undo = null;
      toast(state, "Restored your arrangement. New work is preserved.");
      break;
    }
    case "minimize":
    case "dock":
      if (!frame) return true;
      canvas.minimized.add(frame.id);
      state.maximized = false;
      if (state.focus === frame.id) state.focus = visibleCanvasFrames(state)[0]?.id ?? "";
      break;
    case "restore":
      if (frame) {
        canvas.minimized.delete(frame.id);
        state.focus = frame.id;
      } else canvas.minimized.clear();
      state.maximized = false;
      break;
    case "maximize":
      if (!frame) return true;
      canvas.minimized.delete(frame.id);
      state.maximized = state.focus !== frame.id || !state.maximized;
      state.focus = frame.id;
      break;
    case "focus":
      if (frame) {
        canvas.minimized.delete(frame.id);
        state.focus = frame.id;
      }
      break;
    case "move": {
      const destination = state.frames.find((item) => item.id === target);
      if (!frame || !destination || frame === destination) return true;
      if (zone === "tabs") {
        destination.tabs.push(...frame.tabs);
        destination.active = frame.active;
        state.frames = state.frames.filter((item) => item !== frame);
        canvas.minimized.delete(frame.id);
        state.focus = destination.id;
      } else {
        const next = state.frames.filter((item) => item !== frame);
        next.splice(next.indexOf(destination) + (zone === "after" ? 1 : 0), 0, frame);
        state.frames = next;
        state.focus = frame.id;
      }
      canvas.task = null;
      break;
    }
    case "resize":
      canvas.share = Math.max(20, Math.min(80, Math.round((Number(id) || 50) / 10) * 10));
      canvas.task = null;
      break;
    case "split": {
      const source = frame ?? state.frames.find((item) => item.id === state.focus);
      if (!source || source.tabs.length < 2) {
        toast(state, "Open another tab in this pane to split it out.");
        return true;
      }
      const tab = source.active;
      source.tabs = source.tabs.filter((item) => item !== tab);
      source.active = source.tabs[0] ?? "";
      state.seq += 1;
      const next = { id: `canvas-${state.seq}`, tabs: [tab], active: tab };
      state.frames.splice(state.frames.indexOf(source) + 1, 0, next);
      state.focus = next.id;
      state.maximized = false;
      canvas.task = null;
      break;
    }
    default:
      return false;
  }
  if (command !== "focus") canvas.manual = true;
  state.menu = null;
  return true;
}
const escapeHtml = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;");
const label = (value: string) => value.charAt(0).toUpperCase() + value.slice(1);
export function renderCanvasTools(state: State): string {
  const canvas = canvasState(state);
  const suggestion = canvasSuggestion(state);
  return `<div class="lk-adaptive-tools" data-key="adaptive-tools" role="group" aria-label="Adaptive Canvas">
    <span class="lk-adaptive-name">Adaptive Canvas${isAvailable("adaptive-canvas") ? "" : '<span class="lk-soon">Coming soon</span>'}</span>
    <div class="lk-adaptive-presets">${CANVAS_TASKS.map((task) => `<button type="button" class="lk-btn" data-do="canvas:layout:${task}" aria-pressed="${canvas.task === task}">${label(task)}</button>`).join("")}</div>
    <button type="button" class="lk-btn" data-do="canvas:tidy">Tidy layout</button>
    <button type="button" class="lk-btn" data-do="canvas:undo"${canvas.undo ? "" : " disabled"}>Undo layout</button>
    <button type="button" class="lk-adaptive-suggestion" data-do="canvas:layout:${suggestion}" title="Only applied when you choose it">Try ${label(suggestion)} <span>for this work</span></button>
  </div>`;
}
/** The canonical renderer still draws every pane. Canvas only supplies chrome and placement. */
export function renderAdaptiveCanvas(
  state: State,
  renderFrame: (state: State, frame: Frame, index: number) => string,
): string {
  const canvas = canvasState(state);
  const visible = visibleCanvasFrames(state);
  const activeCount = visible.length;
  const focusOnly = state.maximized || state.mobile;
  const html = state.frames
    .map((frame, index) => {
      const hidden = canvas.minimized.has(frame.id) || (focusOnly && state.focus !== frame.id);
      const attrs = `data-canvas-frame="${escapeHtml(frame.id)}" data-canvas-hidden="${hidden}" data-keep="data-canvas-snap"${hidden ? " hidden" : ""} tabindex="-1"${state.mobile ? " data-swipe" : ""}`;
      let rendered = renderFrame(state, frame, index).replace("<section ", `<section ${attrs} `);
      const controls = `<button type="button" class="lk-icon-btn lk-canvas-grip" data-canvas-grip="${escapeHtml(frame.id)}" aria-label="Move pane ${index + 1}" title="Drag to move. Ctrl Alt Shift H/J/K/L moves with the keyboard."><svg class="lk-i" aria-hidden="true"><use href="#lk-layout"/></svg></button><button type="button" class="lk-icon-btn" data-do="canvas:minimize:${escapeHtml(frame.id)}" aria-label="Minimize pane ${index + 1}" title="Minimize; keep this session running">-</button>`;
      rendered = rendered.replace(/(<(?:span|div) class="lk-frame__end">)/, `$1${controls}`);
      return rendered;
    })
    .join("");
  const minimized = state.frames.filter((frame) => canvas.minimized.has(frame.id));
  return `<div class="lk-adaptive" data-key="adaptive-canvas" data-canvas-mobile="${state.mobile}" data-canvas-focus="${focusOnly}" data-canvas-share="${canvas.share}" data-canvas-columns="${state.layout === "3" ? 3 : 2}" data-canvas-task="${canvas.task ?? "manual"}">
    <div class="lk-adaptive-scroll" data-scroll-key="adaptive-canvas"><div class="lk-adaptive-stage" data-canvas-count="${activeCount}">${html}${activeCount === 0 ? `<p class="lk-empty">${canvas.minimized.size ? "Restore a pane below to continue your work." : "Open a terminal or coding agent to begin."}</p>` : ""}</div></div>
    ${!focusOnly && activeCount > 1 ? `<div class="lk-adaptive-resize"><label>Pane balance <input type="range" min="20" max="80" step="10" value="${canvas.share}" aria-label="Resize canvas columns" data-canvas-resize /></label><span>${canvas.share} / ${100 - canvas.share}</span></div>` : ""}
    ${minimized.length ? `<div class="lk-adaptive-dock" aria-label="Minimized panes"><span>Still running</span>${minimized.map((frame) => `<button type="button" class="lk-btn" data-do="canvas:restore:${escapeHtml(frame.id)}">Restore ${escapeHtml(state.tabs[frame.active]?.title ?? "pane")}</button>`).join("")}</div>` : ""}
    ${
      state.mobile
        ? `<div class="lk-adaptive-mobile lk-mstrip" role="group" aria-label="Panes">${state.frames
            .filter((frame) => !canvas.minimized.has(frame.id))
            .flatMap((frame) =>
              frame.tabs.map((id) => {
                const tab = state.tabs[id];
                const title = tab?.agent ? state.agents[tab.agent]?.name : tab?.title;
                return `<button type="button" class="lk-btn lk-mtab" data-do="tab:${escapeHtml(id)}" aria-pressed="${state.focus === frame.id && frame.active === id}">${escapeHtml(title ?? "Pane")}</button>`;
              }),
            )
            .join("")}</div>`
        : ""
    }
  </div>`;
}
