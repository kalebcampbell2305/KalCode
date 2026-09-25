/**
 * Pane layouts (Z7-W1) for the in-memory runtime (unit tests and the `ui-test` build only).
 * Mirrors `apps/desktop/src-tauri/src/layout_commands.rs` and `crates/workspace-ui`: the same
 * commands, validation (structure, limits, content ids, 64 KiB) and error codes. Presets keep
 * only their shape. Saving a layout emits no events, like native.
 */
import type {
  IpcError,
  PaneContent,
  PaneLayout,
  PaneNode,
  SavedLayoutPreset,
  WorkspaceLayout,
} from "@kalcode/protocol";
import { validateLayout } from "../../shell/panes/model.ts";

type Handler = (args: Record<string, unknown>) => unknown;
export type LayoutCommand =
  | "layout_get"
  | "layout_save"
  | "layout_presets"
  | "layout_preset_save"
  | "layout_preset_delete";

/** Test hooks, exposed on `window.__kalcodeMemory.layouts` in ui-test builds. */
export interface LayoutControls {
  /** The layout stored for a workspace (what native would restore on relaunch). */
  stored(workspaceId: string): PaneLayout | null;
  /** How many layout saves succeeded so far. */
  saves(): number;
  /** The next `layout_save` fails (as a database error would). */
  failNextSave(): void;
  /** Stores a layout for a workspace without validation checks of the UI (a previous run). */
  seed(workspaceId: string, layout: PaneLayout): void;
}

export interface LayoutsMemory {
  handlers: Record<LayoutCommand, Handler>;
  controls: LayoutControls;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const WIDGET_ID = /^[a-z0-9][a-z0-9_.-]{0,63}$/;
const MAX_LAYOUT_BYTES = 65_536;
const MAX_URL_CHARS = 2048;
const MAX_PRESETS = 50;
const MAX_PRESET_NAME_CHARS = 60;
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it rejects.
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

function fail(error: IpcError): never {
  throw error;
}

function invalid(code: string, message: string): never {
  return fail({ category: "validation", code, message, retryable: false });
}

function checkId(value: unknown): string {
  if (typeof value !== "string" || !UUID.test(value)) invalid("invalid_id", "Invalid identifier.");
  return value;
}

function contentOk(content: PaneContent): boolean {
  switch (content.kind) {
    case "thread":
      return UUID.test(content.threadId);
    case "terminal":
      return UUID.test(content.terminalId);
    case "git":
      return UUID.test(content.workspaceId);
    case "dashboard":
      return true;
    case "widget":
      return WIDGET_ID.test(content.widgetId);
    case "browser":
      return (
        content.url === null ||
        ([...content.url].length <= MAX_URL_CHARS &&
          !CONTROL.test(content.url) &&
          (content.url.startsWith("http://") || content.url.startsWith("https://")))
      );
    default:
      return false;
  }
}

function contents(node: PaneNode): PaneContent[] {
  return node.kind === "leaf" ? node.tabs : node.children.flatMap(contents);
}

/** Native `validate_layout`: structure, content ids, size. */
function checkLayout(value: unknown): PaneLayout {
  const layout = value as PaneLayout;
  if (!layout || typeof layout !== "object" || !layout.root || !Array.isArray(layout.dock)) {
    // Native serde refuses a payload that isn't a PaneLayout before the command runs.
    fail({
      category: "internal",
      code: "ipc_rejected",
      message: "KalCode couldn't complete that request.",
      retryable: false,
    });
  }
  if (validateLayout(layout) !== null) {
    invalid("invalid_layout", "That layout isn't valid.");
  }
  if (![...contents(layout.root), ...layout.dock].every(contentOk)) {
    invalid("invalid_layout", "A pane in that layout refers to something KalCode can't open.");
  }
  if (new TextEncoder().encode(JSON.stringify(layout)).length > MAX_LAYOUT_BYTES) {
    invalid("invalid_layout", "That layout is too large to save.");
  }
  return layout;
}

function presetName(value: unknown): string {
  const name = typeof value === "string" ? value.trim() : "";
  const count = [...name].length;
  if (count === 0 || count > MAX_PRESET_NAME_CHARS || CONTROL.test(name)) {
    invalid("invalid_preset_name", "Layout names are 1 to 60 characters, without line breaks or control characters.");
  }
  return name;
}

/** The layout's shape only: every pane empty and expanded, nothing maximized, no dock. */
export function shapeOnly(layout: PaneLayout): PaneLayout {
  const strip = (node: PaneNode): PaneNode =>
    node.kind === "leaf"
      ? { kind: "leaf", paneId: node.paneId, tabs: [], activeTab: 0, collapsed: false }
      : { ...node, children: node.children.map(strip) };
  return { schemaVersion: layout.schemaVersion, root: strip(layout.root), maximizedPaneId: null, dock: [] };
}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

export function createLayoutsMemory(options: {
  requireCore: () => void;
  /** Ids of the workspaces the memory runtime knows. */
  workspaceIds: () => readonly string[];
}): LayoutsMemory {
  const { requireCore, workspaceIds } = options;
  const layouts = new Map<string, WorkspaceLayout>();
  const presets: SavedLayoutPreset[] = [];
  let saveCount = 0;
  let failNext = false;

  const handlers: Record<LayoutCommand, Handler> = {
    layout_get: (args) => {
      requireCore();
      const workspaceId = checkId(args.workspaceId);
      const stored = layouts.get(workspaceId);
      // Like native: a stored layout that no longer validates is ignored.
      if (!stored || validateLayout(stored.layout) !== null) return null;
      return clone(stored);
    },
    layout_save: (args) => {
      requireCore();
      const workspaceId = checkId(args.workspaceId);
      if (!workspaceIds().includes(workspaceId)) {
        invalid("workspace_not_found", "That workspace no longer exists.");
      }
      const layout = checkLayout(args.layout);
      if (failNext) {
        failNext = false;
        fail({
          category: "database",
          code: "database_busy",
          message: "KalCode's database is busy. Try again.",
          retryable: true,
        });
      }
      const saved: WorkspaceLayout = {
        workspaceId,
        schemaVersion: layout.schemaVersion,
        layout: clone(layout),
        updatedAt: new Date().toISOString(),
      };
      layouts.set(workspaceId, saved);
      saveCount++;
      return clone(saved);
    },
    layout_presets: () => {
      requireCore();
      return clone(presets);
    },
    layout_preset_save: (args) => {
      requireCore();
      const name = presetName(args.name);
      const layout = checkLayout(args.layout);
      if (presets.some((p) => p.name === name)) {
        invalid("preset_name_taken", "A layout with that name already exists.");
      }
      if (presets.length >= MAX_PRESETS) {
        invalid("too_many_presets", "You can save up to 50 layouts. Delete one to save another.");
      }
      const preset: SavedLayoutPreset = {
        id: crypto.randomUUID(),
        name,
        schemaVersion: 1,
        layout: shapeOnly(layout),
        createdAt: new Date().toISOString(),
      };
      presets.push(preset);
      return clone(preset);
    },
    layout_preset_delete: (args) => {
      requireCore();
      const id = checkId(args.presetId);
      const index = presets.findIndex((p) => p.id === id);
      if (index < 0) invalid("preset_not_found", "That layout no longer exists.");
      presets.splice(index, 1);
      return null;
    },
  };

  const controls: LayoutControls = {
    stored: (workspaceId) => {
      const stored = layouts.get(workspaceId);
      return stored ? clone(stored.layout) : null;
    },
    saves: () => saveCount,
    failNextSave: () => {
      failNext = true;
    },
    seed: (workspaceId, layout) => {
      layouts.set(workspaceId, {
        workspaceId,
        schemaVersion: layout.schemaVersion,
        layout: clone(layout),
        updatedAt: new Date().toISOString(),
      });
    },
  };

  return { handlers, controls };
}
