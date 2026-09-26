export type DesktopPlatform = "macos" | "windows" | "linux" | "unknown";

export interface PlatformNavigator {
  platform: string;
  userAgent: string;
  userAgentData?: { platform?: string };
}

type ModifierState = Pick<KeyboardEvent, "ctrlKey" | "metaKey">;

/** Detects the desktop family from browser signals without making tests mutate global navigator. */
export function detectDesktopPlatform(source?: PlatformNavigator): DesktopPlatform {
  if (!source) return "unknown";
  const structured = source.userAgentData?.platform?.trim();
  const legacy = source.platform.trim();
  const candidate = structured || legacy || source.userAgent;
  if (/mac|iphone|ipad/i.test(candidate)) return "macos";
  if (/win/i.test(candidate)) return "windows";
  if (/linux|x11/i.test(candidate)) return "linux";
  return "unknown";
}

function runtimeNavigator(): PlatformNavigator | undefined {
  if (typeof navigator === "undefined") return undefined;
  const userAgentData = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData;
  return { platform: navigator.platform, userAgent: navigator.userAgent, userAgentData };
}

export const DESKTOP_PLATFORM = detectDesktopPlatform(runtimeNavigator());
export const IS_MAC = DESKTOP_PLATFORM === "macos";

/** True only for the platform's primary modifier; mixed Control+Command chords are rejected. */
export function hasPrimaryModifier(event: ModifierState, platform = DESKTOP_PLATFORM): boolean {
  return platform === "macos" ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
}

const MAC_TOKEN_LABELS: Readonly<Record<string, string>> = {
  Mod: "⌘",
  Control: "⌃",
  Alt: "⌥",
  Shift: "⇧",
  ArrowLeft: "←",
  ArrowRight: "→",
  ArrowUp: "↑",
  ArrowDown: "↓",
};

const OTHER_TOKEN_LABELS: Readonly<Record<string, string>> = {
  Mod: "Ctrl",
  Control: "Ctrl",
  Alt: "Alt",
  Shift: "Shift",
  ArrowLeft: "←",
  ArrowRight: "→",
  ArrowUp: "↑",
  ArrowDown: "↓",
};

/** Formats shortcuts for menus and hints using the conventions users see on their keyboard. */
export function formatShortcut(tokens: readonly string[], platform = DESKTOP_PLATFORM): string {
  const labels = platform === "macos" ? MAC_TOKEN_LABELS : OTHER_TOKEN_LABELS;
  return tokens.map((token) => labels[token] ?? token).join(" ");
}
