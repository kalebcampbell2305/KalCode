import type { PaneContent } from "@kalcode/protocol";
import type { Destination } from "./navigation.tsx";

export type NavigationTarget =
  | { kind: "pane"; content: PaneContent }
  | { kind: "thread"; threadId: string }
  | { kind: "provider"; tab: "setup" | "accounts" | "health"; sectionId?: string }
  | {
      kind: "operations";
      tab: "runs" | "queue" | "services" | "environments" | "activity";
      runId?: string;
      filterWorkspaceId?: string;
    }
  | { kind: "section"; sectionId: string };

export interface NavigationLocation {
  destination: Destination;
  workspaceId?: string;
  label?: string;
  target?: NavigationTarget;
}

export interface NavigationEntry extends NavigationLocation {
  id: number;
}

export interface NavigationHistory {
  entries: readonly NavigationEntry[];
  index: number;
  nextId: number;
}

function targetKey(target: NavigationTarget | undefined): string {
  if (!target) return "";
  if (target.kind === "section") return `section:${target.sectionId}`;
  if (target.kind === "thread") return `thread:${target.threadId}`;
  if (target.kind === "provider" || target.kind === "operations") return JSON.stringify(target);
  const content = target.content;
  // Browser URL updates are session state, not application navigation.
  if (content.kind === "browser") return `browser:${content.browserId}`;
  return JSON.stringify(content);
}

export function sameLocation(a: NavigationLocation, b: NavigationLocation): boolean {
  return (
    a.destination === b.destination && a.workspaceId === b.workspaceId && targetKey(a.target) === targetKey(b.target)
  );
}

export function initialHistory(destination: Destination): NavigationHistory {
  return { entries: [{ id: 0, destination }], index: 0, nextId: 1 };
}

/** Bounded, chronological history. A new visit after Back discards the forward branch. */
export function visitLocation(state: NavigationHistory, location: NavigationLocation): NavigationHistory {
  const current = state.entries[state.index];
  if (current && sameLocation(current, location)) return state;
  // A surface initially opens before its focused pane/section has rendered. Enrich that
  // visit rather than forcing the user through a duplicate, empty surface on Back.
  if (
    current &&
    current.destination === location.destination &&
    !current.target &&
    (!current.workspaceId || current.workspaceId === location.workspaceId)
  ) {
    const entries = [...state.entries];
    entries[state.index] = { ...location, id: current.id };
    return { ...state, entries };
  }
  const entries = [...state.entries.slice(0, state.index + 1), { ...location, id: state.nextId }].slice(-200);
  return { entries, index: entries.length - 1, nextId: state.nextId + 1 };
}
