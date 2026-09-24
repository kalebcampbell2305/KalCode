import type { Settings } from "@kalcode/protocol";
import { useEffect, useState } from "react";
import type { KalCodeClient } from "../ipc/client.ts";

export type ResolvedTheme = "light" | "dark";

const DARK_QUERY = "(prefers-color-scheme: dark)";

export function resolveTheme(preference: Settings["theme"], systemPrefersDark: boolean): ResolvedTheme {
  if (preference === "system") return systemPrefersDark ? "dark" : "light";
  return preference;
}

/** Applies theme, motion and density to <html> so tokens.css takes effect everywhere. */
export function applyAppearance(root: HTMLElement, settings: Settings, systemPrefersDark: boolean): ResolvedTheme {
  const theme = resolveTheme(settings.theme, systemPrefersDark);
  root.dataset.theme = theme;
  root.dataset.density = settings.density;
  if (settings.motion === "system") delete root.dataset.motion;
  else root.dataset.motion = settings.motion;
  return theme;
}

function systemPrefersDark(): boolean {
  return typeof matchMedia === "function" && matchMedia(DARK_QUERY).matches;
}

/** Keeps the document and the native title bar in sync with settings and the OS theme. */
export function useAppearance(settings: Settings, client: KalCodeClient): ResolvedTheme {
  const [systemDark, setSystemDark] = useState(systemPrefersDark);

  useEffect(() => {
    if (typeof matchMedia !== "function") return;
    const query = matchMedia(DARK_QUERY);
    const onChange = (event: MediaQueryListEvent) => setSystemDark(event.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  const theme = resolveTheme(settings.theme, systemDark);

  useEffect(() => {
    applyAppearance(document.documentElement, settings, systemDark);
  }, [settings, systemDark]);

  useEffect(() => {
    void client.setNativeTheme(settings.theme === "system" ? null : settings.theme);
  }, [client, settings.theme]);

  return theme;
}

export { systemPrefersDark };
