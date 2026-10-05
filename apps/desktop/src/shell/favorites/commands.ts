import { SURFACES, VIEWS } from "../navigation.tsx";

/** Stable command identities. Opening a saved command searches the palette; it never runs it. */
export const FAVORITE_COMMANDS: Readonly<Record<string, string>> = {
  ...Object.fromEntries(Object.entries(SURFACES).map(([id, meta]) => [`navigate:${id}`, meta.label])),
  ...Object.fromEntries(Object.entries(VIEWS).map(([id, meta]) => [`navigate:${id}`, meta.label])),
  "browser:open": "Browser",
  "agent:new": "New agent",
  "agent:new-options": "New agent with options…",
  "thread:new": "New thread",
  "thread:search": "Search threads",
  "terminal:new": "New terminal",
  "workspace:open": "Open folder…",
};
