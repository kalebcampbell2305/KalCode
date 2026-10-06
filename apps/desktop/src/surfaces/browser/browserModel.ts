import type { PaneContent, PaneLayout, PaneNode } from "@kalcode/protocol";

export type BrowserPaneContent = Extract<PaneContent, { kind: "browser" }>;
export type ViewportPreset = "fluid" | "desktop" | "laptop" | "tablet" | "mobile" | "custom";

export const MAX_BROWSER_URL_CHARS = 2048;
export const MIN_CUSTOM_VIEWPORT = 320;
export const MAX_CUSTOM_VIEWPORT = 3840;

const PRESET_WIDTHS: Readonly<Partial<Record<ViewportPreset, number>>> = {
  desktop: 1440,
  laptop: 1280,
  tablet: 768,
  mobile: 390,
};

function containsAsciiControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

const HOST_PORT_ADDRESS = /^([^/:?#@\s]+):\d{1,5}(?:[/?#]|$)/u;
// `javascript:0` and friends stay schemes; everything else shaped like host:port is an address.
const PRIVILEGED_SCHEMES = new Set(["about", "blob", "data", "file", "javascript", "vbscript"]);

/** Loopback and private-network hosts serve plain-HTTP dev servers, so they open over http. */
function isLocalHost(host: string): boolean {
  const lower = host.toLowerCase();
  if (lower === "localhost" || lower.endsWith(".localhost")) return true;
  const parts = lower.split(".");
  if (parts.length !== 4 || !parts.every((part) => /^\d{1,3}$/u.test(part) && Number(part) <= 255)) return false;
  const [first, second] = parts.map(Number) as [number, number, number, number];
  return (
    first === 127 ||
    first === 10 ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    lower === "0.0.0.0"
  );
}

/**
 * Turns an address-bar value into a credential-free http(s) URL. Privileged schemes never
 * reach the native webview. Native applies the same policy again at the trust boundary.
 */
export function normalizeBrowserAddress(input: string): string {
  if (input.length > MAX_BROWSER_URL_CHARS || input.length === 0 || containsAsciiControlCharacter(input)) {
    throw new Error("Enter a valid web address.");
  }
  const value = input.trim();
  if (!value || value.length > MAX_BROWSER_URL_CHARS) throw new Error("Enter a valid web address.");

  const lower = value.toLowerCase();
  const hostPort = HOST_PORT_ADDRESS.exec(value)?.[1];
  let candidate: string;
  if (lower.startsWith("http://") || lower.startsWith("https://")) {
    candidate = value;
  } else if (hostPort !== undefined && !PRIVILEGED_SCHEMES.has(hostPort.toLowerCase())) {
    candidate = `${isLocalHost(hostPort) ? "http" : "https"}://${value}`;
  } else if (value.includes("://") || /^[a-z][a-z0-9+.-]*:/iu.test(value)) {
    // The localhost/IPv6 forms below are handled before treating a colon as a scheme.
    if (/^(localhost|127\.0\.0\.1)(?::\d+)?(?:[/]|$)/iu.test(value) || /^\[::1\](?::\d+)?(?:[/]|$)/iu.test(value)) {
      candidate = `http://${value}`;
    } else {
      throw new Error("Only HTTP and HTTPS addresses can open here.");
    }
  } else if (
    /^(localhost|127\.0\.0\.1)(?::\d+)?(?:[/]|$)/iu.test(value) ||
    /^\[::1\](?::\d+)?(?:[/]|$)/iu.test(value)
  ) {
    candidate = `http://${value}`;
  } else {
    candidate = `https://${value}`;
  }

  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new Error("Enter a valid web address.");
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || !url.hostname || url.username || url.password) {
    throw new Error("Only credential-free HTTP and HTTPS addresses can open here.");
  }
  const normalized = url.toString();
  if (normalized.length > MAX_BROWSER_URL_CHARS) throw new Error("That address is too long.");
  return normalized;
}

/** Stored workspace state intentionally omits query strings and fragments, which often carry secrets. */
export function persistableBrowserUrl(input: string): string {
  const url = new URL(normalizeBrowserAddress(input));
  url.search = "";
  url.hash = "";
  // WHATWG URLs keep a stray `%` verbatim, but persisted layouts accept only `%XX` escapes.
  url.pathname = url.pathname.replace(/%(?![0-9A-Fa-f]{2})/gu, "%25");
  return url.toString();
}

export function newBrowserId(): string {
  return crypto.randomUUID();
}

export function browserContent(browserId: string = newBrowserId(), url: string | null = null): BrowserPaneContent {
  return { kind: "browser", browserId, url };
}

function updateNode(node: PaneNode, browserId: string, url: string): [PaneNode, boolean] {
  if (node.kind === "leaf") {
    let changed = false;
    const tabs = node.tabs.map((content) => {
      if (content.kind !== "browser" || content.browserId !== browserId || content.url === url) return content;
      changed = true;
      return { ...content, url };
    });
    return changed ? [{ ...node, tabs }, true] : [node, false];
  }
  let changed = false;
  const children = node.children.map((child) => {
    const [next, childChanged] = updateNode(child, browserId, url);
    changed ||= childChanged;
    return next;
  });
  return changed ? [{ ...node, children }, true] : [node, false];
}

/** Persists only the non-sensitive URL portion while preserving the browser's stable identity. */
export function updateBrowserUrl(layout: PaneLayout, browserId: string, runtimeUrl: string): PaneLayout {
  const url = persistableBrowserUrl(runtimeUrl);
  const [root, rootChanged] = updateNode(layout.root, browserId, url);
  let dockChanged = false;
  const dock = layout.dock.map((content) => {
    if (content.kind !== "browser" || content.browserId !== browserId || content.url === url) return content;
    dockChanged = true;
    return { ...content, url };
  });
  return rootChanged || dockChanged ? { ...layout, root, dock } : layout;
}

export function clampCustomViewport(width: number): number {
  const finite = Number.isFinite(width) ? Math.round(width) : MIN_CUSTOM_VIEWPORT;
  return Math.max(MIN_CUSTOM_VIEWPORT, Math.min(MAX_CUSTOM_VIEWPORT, finite));
}

export function viewportWidth(preset: ViewportPreset, customWidth: number, availableWidth: number): number {
  const available = Math.max(1, Math.floor(availableWidth));
  if (preset === "fluid") return available;
  const requested = preset === "custom" ? clampCustomViewport(customWidth) : (PRESET_WIDTHS[preset] ?? available);
  return Math.min(requested, available);
}
