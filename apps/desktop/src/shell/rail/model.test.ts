import type { ProviderRow, RailState, WorkspaceRailEntry } from "@kalcode/protocol";
import { describe, expect, it } from "vitest";
import {
  badgeLabel,
  initials,
  parentIndex,
  positions,
  providerKey,
  relativeTime,
  threadLabel,
  visibleNodes,
} from "./model.ts";

const row = (providerId: string, threads: number, working = 0, needsYou = 0): ProviderRow => ({
  providerId,
  providerName: providerId === "codex" ? "Codex" : "Claude Code",
  threads,
  working,
  needsYou,
  items: Array.from({ length: threads }, (_, i) => ({
    id: `${providerId}-${i}`,
    name: `Thread ${i}`,
    status: "idle" as const,
    lastActivityAt: "2026-09-25T10:00:00.000Z",
    pendingApprovals: 0,
  })),
});

const entry = (
  id: string,
  providers: ProviderRow[] = [],
  extra: Partial<WorkspaceRailEntry> = {},
): WorkspaceRailEntry => ({
  workspaceId: id,
  name: id,
  folderName: id,
  displayPath: `~\\Projects\\${id}`,
  location: "local",
  available: true,
  active: false,
  pinned: false,
  archived: false,
  groupId: null,
  collapsed: false,
  indexMessages: false,
  providers,
  threads: providers.reduce((n, p) => n + p.threads, 0),
  working: providers.reduce((n, p) => n + p.working, 0),
  needsYou: providers.reduce((n, p) => n + p.needsYou, 0),
  lastOpenedAt: "2026-09-25T09:00:00.000Z",
  lastActivityAt: "2026-09-25T09:00:00.000Z",
  ...extra,
});

const rail = (extra: Partial<RailState> = {}): RailState => ({
  pinned: [entry("alpha", [row("claude-code", 2, 1)], { pinned: true })],
  recent: [entry("beta"), entry("gamma", [row("codex", 1, 0, 1)], { collapsed: true })],
  groups: [
    {
      group: { id: "g1", name: "Client work", position: 0, collapsed: false },
      workspaces: [entry("delta", [], { groupId: "g1" })],
    },
  ],
  archived: [entry("old", [], { archived: true })],
  collapsedSections: ["archived"],
  persistent: true,
  ...extra,
});

describe("visibleNodes", () => {
  it("lists sections, folders, workspaces, provider rows and threads in order", () => {
    const keys = visibleNodes(rail()).map((n) => n.key);
    expect(keys).toEqual([
      "sec:pinned",
      "ws:pinned:alpha",
      "pv:alpha:claude-code",
      "th:claude-code-0",
      "th:claude-code-1",
      "sec:folders",
      "grp:g1",
      "ws:group:delta",
      "sec:recent",
      "ws:recent:beta",
      "ws:recent:gamma",
      "sec:archived",
    ]);
  });

  it("hides the children of collapsed sections, folders, workspaces and provider rows", () => {
    const state = rail({
      collapsedSections: ["recent", "archived"],
      groups: [
        {
          group: { id: "g1", name: "Client work", position: 0, collapsed: true },
          workspaces: [entry("delta", [], { groupId: "g1" })],
        },
      ],
    });
    const keys = visibleNodes(state, new Set([providerKey("alpha", "claude-code")])).map((n) => n.key);
    expect(keys).toEqual([
      "sec:pinned",
      "ws:pinned:alpha",
      "pv:alpha:claude-code",
      "sec:folders",
      "grp:g1",
      "sec:recent",
      "sec:archived",
    ]);
  });

  it("keeps an empty Recent section (the place new workspaces appear) but drops other empty ones", () => {
    const keys = visibleNodes({ ...rail(), pinned: [], groups: [], recent: [], archived: [] }).map((n) => n.key);
    expect(keys).toEqual(["sec:recent"]);
  });

  it("gives every row an ARIA level and finds parents", () => {
    const nodes = visibleNodes(rail());
    const thread = nodes.findIndex((n) => n.key === "th:claude-code-1");
    expect(nodes[thread]?.level).toBe(4);
    const provider = parentIndex(nodes, thread) ?? -1;
    expect(nodes[provider]?.key).toBe("pv:alpha:claude-code");
    expect(nodes[parentIndex(nodes, provider) ?? -1]?.key).toBe("ws:pinned:alpha");
    const delta = nodes.findIndex((n) => n.key === "ws:group:delta");
    expect(nodes[delta]?.level).toBe(3);
    expect(nodes[parentIndex(nodes, delta) ?? -1]?.key).toBe("grp:g1");
    expect(parentIndex(nodes, 0)).toBeNull();
  });
});

describe("labels", () => {
  it("says badges in words, never by colour", () => {
    expect(badgeLabel({ working: 2, needsYou: 1, threads: 5 })).toBe("1 needs you, 2 working");
    expect(badgeLabel({ working: 0, needsYou: 0, threads: 1 })).toBe("1 thread");
    expect(badgeLabel({ working: 0, needsYou: 0, threads: 0 })).toBe("");
  });

  it("formats relative time compactly", () => {
    const now = Date.parse("2026-09-25T12:00:00.000Z");
    expect(relativeTime("2026-09-25T11:59:40.000Z", now)).toBe("now");
    expect(relativeTime("2026-09-25T11:55:00.000Z", now)).toBe("5m");
    expect(relativeTime("2026-09-25T09:00:00.000Z", now)).toBe("3h");
    expect(relativeTime("2026-09-23T12:00:00.000Z", now)).toBe("2d");
    expect(relativeTime("not a date", now)).toBe("");
  });

  it("names a thread row with its status words", () => {
    const now = Date.parse("2026-09-25T12:00:00.000Z");
    expect(
      threadLabel(
        {
          id: "t",
          name: "Fix login",
          status: "waiting_for_permission",
          lastActivityAt: "2026-09-25T11:00:00.000Z",
          pendingApprovals: 1,
        },
        now,
      ),
    ).toBe("Fix login, permission required, 1h");
    expect(
      threadLabel(
        {
          id: "t",
          name: "Old",
          status: "interrupted",
          lastActivityAt: "2026-09-25T11:58:00.000Z",
          pendingApprovals: 0,
        },
        now,
      ),
    ).toBe("Old, idle (stopped, resumable), 2m");
  });

  it("makes initials from names", () => {
    expect(initials("atlas-api")).toBe("AA");
    expect(initials("kalcode")).toBe("KA");
    expect(initials("My Project")).toBe("MP");
  });
});

describe("positions", () => {
  it("numbers siblings within their parent", () => {
    const nodes = visibleNodes(rail());
    const pos = positions(nodes);
    const at = (key: string) => pos[nodes.findIndex((n) => n.key === key)];
    expect(at("sec:pinned")).toEqual({ posinset: 1, setsize: 4 });
    expect(at("sec:archived")).toEqual({ posinset: 4, setsize: 4 });
    expect(at("ws:recent:gamma")).toEqual({ posinset: 2, setsize: 2 });
    expect(at("th:claude-code-1")).toEqual({ posinset: 2, setsize: 2 });
  });
});
