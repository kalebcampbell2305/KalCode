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
}

export type BrowserAction = "back" | "forward" | "reload" | "stop";
export interface BrowserFocusEvent {
  browserId: string;
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
}

/** Native bridge for the trusted main webview. Remote browser children have no IPC capability. */
export function createBrowserBridge(): BrowserBridge {
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
  };
}
