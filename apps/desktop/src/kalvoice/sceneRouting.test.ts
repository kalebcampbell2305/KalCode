import { expect, it } from "vitest";
import { sceneReference } from "./sceneRouting.ts";

it.each([
  [
    "Find Codex terminal working on the updater",
    { kind: "named", query: "Codex terminal working on the updater", kinds: ["terminal", "agent"] },
  ],
  ["Go to my Release terminal", { kind: "named", query: "Release terminal", kinds: ["terminal", "agent"] }],
  ["Open it.", { kind: "last_target" }],
  ["Show me this agent", { kind: "current", agents: true }],
  ["Open the same agent", { kind: "last_target", agents: true }],
  ["Open the terminal beside this", { kind: "beside_current" }],
  ["Open the other Codex session", { kind: "other", query: "Codex session", kinds: ["thread", "agent"] }],
  // "Agent" means a coding agent (a Code terminal pane); "thing" or "thread" means anything.
  ["Open the agent that just finished", { kind: "latest_completed", agents: true }],
  ["Open the thing that just finished", { kind: "latest_completed" }],
  ["Show the last failed agent", { kind: "latest_failed", agents: true }],
  ["Show the last failed task", { kind: "latest_failed" }],
])("recognizes read-only scene reference %s", (text, expected) => {
  expect(sceneReference(text as string)).toEqual(expected);
});

it.each([
  "Open Dashboard",
  "Open Home",
  "Open Overview",
  "Open Missions",
  "Open Voice",
  "Open Editor",
  "Open Automations",
  "Open Skills",
  "Open Plugins",
  "Open Integrations",
  "Open Memories",
  "Open six Claude agents",
  "Tell Claude to finish",
  "Type open it",
  "Don't open Release",
  "Open Release and stop it",
  "Refactor navigation and test it",
])("leaves %s to its canonical router", (text) => {
  expect(sceneReference(text)).toBeNull();
});

it("uses spoken object nouns to prevent collisions with another surface kind", () => {
  expect(sceneReference("Open the terminal working on Browser")).toEqual({
    kind: "named",
    query: "terminal working on Browser",
    kinds: ["terminal", "agent"],
  });
  expect(sceneReference("Open the Website workspace")).toEqual({
    kind: "named",
    query: "Website workspace",
    kinds: ["workspace", "remote_workspace"],
  });
});
