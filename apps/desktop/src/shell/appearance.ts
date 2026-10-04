import type { Settings, TextSize } from "@kalcode/protocol";
import { useEffect, useState } from "react";
import type { KalCodeClient } from "../ipc/client.ts";

export type ResolvedTheme = "light" | "dark";

const DARK_QUERY = "(prefers-color-scheme: dark)";
const MORE_CONTRAST_QUERY = "(prefers-contrast: more)";

export function resolveTheme(preference: Settings["theme"], systemPrefersDark: boolean): ResolvedTheme {
  if (preference === "system") return systemPrefersDark ? "dark" : "light";
  return preference;
}

export function resolveContrast(
  preference: Settings["contrast"],
  systemPrefersMoreContrast: boolean,
): "standard" | "more" {
  const value = preference ?? "system";
  if (value === "system") return systemPrefersMoreContrast ? "more" : "standard";
  return value;
}

/**
 * Applies theme, motion, density, contrast and text size to <html> so tokens.css takes effect
 * everywhere. Theme and contrast are resolved against the OS here (never in CSS), so every
 * surface reads one answer; "default" text size leaves `data-text-size` unset.
 */
export function applyAppearance(
  root: HTMLElement,
  settings: Settings,
  systemPrefersDark: boolean,
  systemPrefersMoreContrast = false,
): ResolvedTheme {
  const theme = resolveTheme(settings.theme, systemPrefersDark);
  root.dataset.theme = theme;
  root.dataset.density = settings.density;
  if (settings.motion === "system") delete root.dataset.motion;
  else root.dataset.motion = settings.motion;
  root.dataset.contrast = resolveContrast(settings.contrast, systemPrefersMoreContrast);
  const textSize = settings.textSize ?? "default";
  if (textSize === "default") delete root.dataset.textSize;
  else root.dataset.textSize = textSize;
  return theme;
}

/** Text sizes in the order the palette cycles through them. */
export const TEXT_SIZES: readonly TextSize[] = ["default", "large", "larger"];

/** The text size after `current` (wrapping), for the palette's one-step command. */
export function nextTextSize(current: TextSize | undefined): TextSize {
  const index = TEXT_SIZES.indexOf(current ?? "default");
  return TEXT_SIZES[(index + 1) % TEXT_SIZES.length] ?? "default";
}

/** Palette wording for switching to a text size. */
export const TEXT_SIZE_COMMAND: Record<TextSize, string> = {
  default: "Use default text size",
  large: "Use large text",
  larger: "Use larger text",
};

/** How much each text size scales the interface (tokens.css sets the root font size to match). */
export const TEXT_SCALE: Record<TextSize, number> = { default: 1, large: 1.125, larger: 1.25 };

function systemPrefersDark(): boolean {
  return typeof matchMedia === "function" && matchMedia(DARK_QUERY).matches;
}

function systemPrefersMoreContrast(): boolean {
  return typeof matchMedia === "function" && matchMedia(MORE_CONTRAST_QUERY).matches;
}

/** Tracks a media query as state. */
function useMediaQuery(query: string, initial: () => boolean): boolean {
  const [matches, setMatches] = useState(initial);
  useEffect(() => {
    if (typeof matchMedia !== "function") return;
    const list = matchMedia(query);
    const onChange = (event: MediaQueryListEvent) => setMatches(event.matches);
    list.addEventListener("change", onChange);
    return () => list.removeEventListener("change", onChange);
  }, [query]);
  return matches;
}

/** Keeps the document and the native title bar in sync with settings and the OS theme. */
export function useAppearance(settings: Settings, client: KalCodeClient): ResolvedTheme {
  const systemDark = useMediaQuery(DARK_QUERY, systemPrefersDark);
  const systemMoreContrast = useMediaQuery(MORE_CONTRAST_QUERY, systemPrefersMoreContrast);

  const theme = resolveTheme(settings.theme, systemDark);

  useEffect(() => {
    applyAppearance(document.documentElement, settings, systemDark, systemMoreContrast);
  }, [settings, systemDark, systemMoreContrast]);

  useEffect(() => {
    void client.setNativeTheme(settings.theme === "system" ? null : settings.theme);
  }, [client, settings.theme]);

  return theme;
}

export { systemPrefersDark, systemPrefersMoreContrast };
