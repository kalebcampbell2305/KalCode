import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export interface BrowserBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BrowserState {
  browserId: string;
  workspaceId: string;
  url: string;
  title: string | null;
  loading: boolean;
  visible: boolean;
  bounds: BrowserBounds;
  /** The latest pop-up the page asked for. Pop-ups are always denied; the pane offers the URL. */
  blockedPopup?: string | null;
  /** Increments per denied pop-up, so the same URL asked for twice is offered again. */
  blockedPopupSeq?: number;
}

export type BrowserAction = "back" | "forward" | "reload" | "stop";
export interface BrowserFocusEvent {
  browserId: string;
}
/** Native says this pane's state moved (navigation, load, title, denied pop-up): read `info`. */
export interface BrowserStateEvent {
  browserId: string;
}

/** The element the person picked in the page (page-controlled text, bounded natively). */
export interface PickedElement {
  selector: string;
  tag: string;
  text: string;
  html: string;
}

/** Console/load errors and the latest pick, read from the page helper. */
export interface BrowserInspection {
  /** False when the page has no helper yet (a browser error page, or a load still committing). */
  available: boolean;
  errorCount: number;
  errors: string[];
  picking: boolean;
  picked: PickedElement | null;
}

export interface BrowserScreenshot {
  path: string;
  fileName: string;
}

let visibilitySequence = 0;

/** Process-wide ordering survives React pane unmount/remount and rejects stale native shows. */
export function nextBrowserVisibilityVersion(): number {
  visibilitySequence = visibilitySequence >= Number.MAX_SAFE_INTEGER ? 1 : visibilitySequence + 1;
  return visibilitySequence;
}

export interface BrowserBridge {
  attach(request: {
    browserId: string;
    workspaceId: string;
    url: string;
    bounds: BrowserBounds;
    visible: boolean;
    visibilityVersion: number;
  }): Promise<BrowserState>;
  setView(request: {
    browserId: string;
    bounds: BrowserBounds;
    visible: boolean;
    visibilityVersion: number;
  }): Promise<BrowserState>;
  navigate(browserId: string, url: string): Promise<BrowserState>;
  action(browserId: string, action: BrowserAction): Promise<BrowserState>;
  focus(browserId: string): Promise<boolean>;
  info(browserId: string): Promise<BrowserState>;
  close(browserId: string): Promise<boolean>;
  hideAll(): Promise<number>;
  openExternal(url: string): Promise<void>;
  subscribeFocus(listener: (event: BrowserFocusEvent) => void): Promise<UnlistenFn>;
  subscribeState(listener: (event: BrowserStateEvent) => void): Promise<UnlistenFn>;
  /** Console errors and the picked element. Never rejects for a page that simply has no helper. */
  inspect(browserId: string): Promise<BrowserInspection>;
  /** Starts or stops picking an element in the page; resolves whether picking is active. */
  pick(browserId: string, active: boolean): Promise<boolean>;
  /** Saves a PNG of the visible page (Pictures/KalCode) and says where. */
  screenshot(browserId: string): Promise<BrowserScreenshot>;
  /** Shows a screenshot KalCode saved in the system file manager. */
  revealScreenshot(path: string): Promise<void>;
}

/** Native bridge for the trusted main webview. Remote browser children have no IPC capability. */
export function createBrowserBridge(): BrowserBridge {
  // The ui-test build has no native runtime: it gets an in-memory Browser with the same contract.
  if (__KALCODE_MEMORY_TRANSPORT__ && typeof window !== "undefined" && !("__TAURI_INTERNALS__" in window)) {
    return createMemoryBrowserBridge();
  }
  // Capture at mount, even before the first browser pane: delayed old cleanup must never
  // bootstrap itself into the next account. A failed lease stays failed until a fresh mount.
  const pageLease = invoke<number>("browser_page_lease");
  // Some canvases never open Browser. Handle rejection now without changing the retained result.
  void pageLease.catch(() => undefined);
  const lease = () => pageLease;
  return {
    attach: async (request) =>
      invoke<BrowserState>("browser_attach", {
        request: { ...request, pageLease: await lease() },
      }),
    setView: async (request) =>
      invoke<BrowserState>("browser_set_view", {
        request: { ...request, pageLease: await lease() },
      }),
    navigate: async (browserId, url) =>
      invoke<BrowserState>("browser_navigate", {
        browserId,
        url,
        pageLease: await lease(),
      }),
    action: async (browserId, action) =>
      invoke<BrowserState>("browser_action", {
        browserId,
        action,
        pageLease: await lease(),
      }),
    focus: async (browserId) =>
      invoke<boolean>("browser_focus", {
        browserId,
        pageLease: await lease(),
      }),
    info: async (browserId) =>
      invoke<BrowserState>("browser_info", {
        browserId,
        pageLease: await lease(),
      }),
    close: async (browserId) =>
      invoke<boolean>("browser_close", {
        browserId,
        pageLease: await lease(),
      }),
    hideAll: async () => invoke<number>("browser_hide_all", { pageLease: await lease() }),
    openExternal: async (url) =>
      invoke<void>("browser_open_external", {
        url,
        pageLease: await lease(),
      }),
    subscribeFocus: (listener) =>
      listen<BrowserFocusEvent>("kalcode://browser-focus", (event) => listener(event.payload)),
    subscribeState: (listener) =>
      listen<BrowserStateEvent>("kalcode://browser-state", (event) => listener(event.payload)),
    inspect: async (browserId) =>
      invoke<BrowserInspection>("browser_inspect", {
        browserId,
        pageLease: await lease(),
      }),
    pick: async (browserId, active) =>
      invoke<boolean>("browser_pick", {
        browserId,
        active,
        pageLease: await lease(),
      }),
    screenshot: async (browserId) =>
      invoke<BrowserScreenshot>("browser_screenshot", {
        browserId,
        pageLease: await lease(),
      }),
    revealScreenshot: (path) => invoke<void>("browser_reveal_screenshot", { path }),
  };
}

/** Test hooks for the ui-test build, on `window.__kalcodeMemory.browser`. */
export interface MemoryBrowserHooks {
  /** Simulates console errors in a pane's page. */
  setErrors(browserId: string, errors: string[]): void;
  /** Simulates the person clicking an element while picking. */
  pickElement(browserId: string, element: PickedElement): void;
  /** Simulates the page asking for a pop-up (always denied). */
  blockPopup(browserId: string, url: string): void;
  lastUrl(browserId: string): string | null;
  /** URLs sent to the system browser. */
  opened(): string[];
}

/**
 * In-memory Browser for the ui-test build (no native child exists in a plain web page). Keeps the
 * native contract: URLs, titles, history, picking, errors and pop-ups behave like the real one.
 */
interface MemoryPage {
  state: BrowserState;
  history: string[];
  index: number;
  errors: string[];
  picking: boolean;
  picked: PickedElement | null;
}
// One in-memory Browser per page load, shared by every bridge (React may create several).
const memoryPages = new Map<string, MemoryPage>();
const memoryOpened: string[] = [];
const memoryStateListeners = new Set<(event: BrowserStateEvent) => void>();

export function createMemoryBrowserBridge(): BrowserBridge {
  type Page = MemoryPage;
  const pages = memoryPages;
  const opened = memoryOpened;
  const titleOf = (url: string) => {
    try {
      const parsed = new URL(url);
      return parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1"
        ? `Acme Studio · ${parsed.port ? `:${parsed.port}` : "local"}`
        : parsed.hostname.replace(/^www\./u, "");
    } catch {
      return null;
    }
  };
  const page = (browserId: string): Page => {
    const found = pages.get(browserId);
    if (!found) throw { code: "browser_not_found", message: "That browser pane is not open." };
    return found;
  };
  const go = (entry: Page, url: string) => {
    entry.history = [...entry.history.slice(0, entry.index + 1), url];
    entry.index = entry.history.length - 1;
    entry.state = { ...entry.state, url, title: titleOf(url), loading: false };
    entry.errors = [];
  };
  const hooks: MemoryBrowserHooks = {
    setErrors: (browserId, errors) => {
      const entry = pages.get(browserId);
      if (entry) entry.errors = [...errors];
    },
    pickElement: (browserId, element) => {
      const entry = pages.get(browserId);
      if (entry?.picking) {
        entry.picked = element;
        entry.picking = false;
      }
    },
    blockPopup: (browserId, url) => {
      const entry = pages.get(browserId);
      if (entry) {
        entry.state = {
          ...entry.state,
          blockedPopup: url,
          blockedPopupSeq: (entry.state.blockedPopupSeq ?? 0) + 1,
        };
        // Like native's denied-pop-up handler, announce the move.
        for (const listener of [...memoryStateListeners]) listener({ browserId });
      }
    },
    lastUrl: (browserId) => pages.get(browserId)?.state.url ?? null,
    opened: () => [...opened],
  };
  if (typeof window !== "undefined") {
    const target = window as unknown as { __kalcodeMemory?: Record<string, unknown> };
    target.__kalcodeMemory ??= {};
    target.__kalcodeMemory.browser = hooks;
  }
  return {
    attach: async (request) => {
      const existing = pages.get(request.browserId);
      if (existing) {
        existing.state = { ...existing.state, bounds: request.bounds, visible: request.visible };
        return existing.state;
      }
      const entry: Page = {
        state: {
          browserId: request.browserId,
          workspaceId: request.workspaceId,
          url: request.url,
          title: titleOf(request.url),
          loading: false,
          visible: request.visible,
          bounds: request.bounds,
          blockedPopup: null,
          blockedPopupSeq: 0,
        },
        history: [request.url],
        index: 0,
        errors: [],
        picking: false,
        picked: null,
      };
      pages.set(request.browserId, entry);
      return entry.state;
    },
    setView: async (request) => {
      const entry = page(request.browserId);
      entry.state = { ...entry.state, bounds: request.bounds, visible: request.visible };
      return entry.state;
    },
    navigate: async (browserId, url) => {
      const entry = page(browserId);
      go(entry, url);
      return entry.state;
    },
    action: async (browserId, action) => {
      const entry = page(browserId);
      if (action === "back" && entry.index > 0) entry.index -= 1;
      if (action === "forward" && entry.index < entry.history.length - 1) entry.index += 1;
      const url = entry.history[entry.index] ?? entry.state.url;
      entry.state = { ...entry.state, url, title: titleOf(url), loading: false };
      return entry.state;
    },
    focus: async () => true,
    info: async (browserId) => page(browserId).state,
    close: async (browserId) => pages.delete(browserId),
    hideAll: async () => pages.size,
    openExternal: async (url) => {
      opened.push(url);
    },
    subscribeFocus: async () => () => undefined,
    subscribeState: async (listener) => {
      memoryStateListeners.add(listener);
      return () => {
        memoryStateListeners.delete(listener);
      };
    },
    inspect: async (browserId) => {
      const entry = page(browserId);
      const picked = entry.picked;
      entry.picked = null;
      return {
        available: true,
        errorCount: entry.errors.length,
        errors: [...entry.errors],
        picking: entry.picking,
        picked,
      };
    },
    pick: async (browserId, active) => {
      const entry = page(browserId);
      entry.picking = active;
      return active;
    },
    screenshot: async (browserId) => {
      const host = new URL(page(browserId).state.url).hostname;
      const fileName = `Live Browser ${host} 2026-10-03 at 14.05.09.png`;
      return { path: `C:\\Users\\you\\Pictures\\KalCode\\${fileName}`, fileName };
    },
    revealScreenshot: async () => undefined,
  };
}
