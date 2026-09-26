import type { PaneContent, PaneLayout, PaneNode } from "@kalcode/protocol";
import { describe, expect, it } from "vitest";
import { arrangeContents } from "../../shell/panes/model.ts";
import { KalCodeClient } from "../client.ts";
import { createMemoryTransport } from "../memoryTransport.ts";

/** Pane layouts (Z7-W1) through the client, against the in-memory runtime (mirrors native). */

const leaf = (paneId: string, tabs: PaneContent[] = []): PaneNode => ({
  kind: "leaf",
  paneId,
  tabs,
  activeTab: 0,
  collapsed: false,
});

function twoPanes(): PaneLayout {
  return {
    schemaVersion: 1,
    root: {
      kind: "split",
      axis: "horizontal",
      ratios: [600, 400],
      children: [
        leaf("a", [{ kind: "terminal", terminalId: crypto.randomUUID() }]),
        leaf("b", [{ kind: "thread", threadId: crypto.randomUUID() }, { kind: "dashboard" }]),
      ],
    },
    maximizedPaneId: "b",
    dock: [{ kind: "browser", browserId: crypto.randomUUID(), url: "http://localhost:3000" }],
  };
}

async function setup() {
  const transport = createMemoryTransport("code", { detectDelayMs: 0 });
  const client = new KalCodeClient(transport);
  const [first, second] = await client.listWorkspaces();
  if (!first || !second) throw new Error("the code scenario has workspaces");
  return { transport, client, first: first.id, second: second.id };
}

describe("pane layouts in the memory runtime", () => {
  it("saves and restores a layout per workspace, without events", async () => {
    const { transport, client, first, second } = await setup();
    expect(await client.layoutGet(first)).toBeNull();
    const before = (await client.recentEvents(100)).length;
    const layout = twoPanes();
    const saved = await client.layoutSave(first, layout);
    expect(saved).toMatchObject({ workspaceId: first, schemaVersion: 1, layout });
    expect((await client.layoutGet(first))?.layout).toEqual(layout);
    expect(await client.layoutGet(second)).toBeNull();
    expect(transport.layouts.stored(first)).toEqual(layout);
    expect(transport.layouts.saves()).toBe(1);
    expect((await client.recentEvents(100)).length).toBe(before);
  });

  it("persists an exact provider-pane grid while retaining existing work", async () => {
    const { client, first } = await setup();
    const threadIds = Array.from({ length: 4 }, () => crypto.randomUUID());
    const arranged = arrangeContents(
      twoPanes(),
      threadIds.map((threadId) => ({ kind: "thread", threadId })),
    );
    if (!arranged) throw new Error("the layout has room for four provider panes");

    await client.layoutSave(first, arranged);
    expect((await client.layoutGet(first))?.layout).toEqual(arranged);
  });

  it("refuses invalid layouts, unknown workspaces and bad ids like native", async () => {
    const { client, first } = await setup();
    const code = (p: Promise<unknown>) =>
      p.then(
        () => "ok",
        (e: { code?: string }) => e.code,
      );
    const bad: PaneLayout[] = [
      { ...twoPanes(), schemaVersion: 2 },
      { ...twoPanes(), maximizedPaneId: "zzz" },
      {
        ...twoPanes(),
        root: { kind: "split", axis: "vertical", ratios: [700, 400], children: [leaf("a"), leaf("b")] },
      },
      {
        ...twoPanes(),
        root: { kind: "split", axis: "vertical", ratios: [500, 500], children: [leaf("a"), leaf("a")] },
      },
      { ...twoPanes(), root: leaf("a", [{ kind: "terminal", terminalId: "../etc" }]), maximizedPaneId: null },
      { ...twoPanes(), root: leaf("a", [{ kind: "widget", widgetId: "Bad Widget" }]), maximizedPaneId: null },
      { ...twoPanes(), dock: [{ kind: "browser", browserId: crypto.randomUUID(), url: "file:///C:/Windows/win.ini" }] },
      {
        ...twoPanes(),
        dock: [
          {
            kind: "browser",
            browserId: crypto.randomUUID(),
            url: "https://example.com/callback?code=secret#access-token",
          },
        ],
      },
      {
        ...twoPanes(),
        dock: [{ kind: "browser", browserId: crypto.randomUUID(), url: "https://user:password@example.com/" }],
      },
      {
        ...twoPanes(),
        dock: [{ kind: "browser", browserId: crypto.randomUUID(), url: "https://@example.com/" }],
      },
    ];
    const duplicateBrowserId = crypto.randomUUID();
    bad.push({
      ...twoPanes(),
      root: {
        kind: "split",
        axis: "horizontal",
        ratios: [500, 500],
        children: [
          leaf("a", [{ kind: "browser", browserId: duplicateBrowserId, url: "https://example.com/preview" }]),
          leaf("b", [{ kind: "browser", browserId: duplicateBrowserId, url: "https://example.com/preview" }]),
        ],
      },
      maximizedPaneId: null,
      dock: [],
    });
    bad.push({
      ...twoPanes(),
      root: leaf("a", [{ kind: "browser", browserId: duplicateBrowserId, url: "https://example.com/preview" }]),
      maximizedPaneId: null,
      dock: [{ kind: "browser", browserId: duplicateBrowserId, url: "https://example.com/preview" }],
    });
    for (const layout of bad) expect(await code(client.layoutSave(first, layout))).toBe("invalid_layout");
    expect(await code(client.layoutSave(crypto.randomUUID(), twoPanes()))).toBe("workspace_not_found");
    expect(await code(client.layoutSave("not-an-id", twoPanes()))).toBe("invalid_id");
    expect(await code(client.layoutGet("not-an-id"))).toBe("invalid_id");
    expect(await client.layoutGet(first)).toBeNull();
  });

  it("a failed save changes nothing", async () => {
    const { transport, client, first } = await setup();
    await client.layoutSave(first, twoPanes());
    transport.layouts.failNextSave();
    const next = { ...twoPanes(), maximizedPaneId: null };
    await expect(client.layoutSave(first, next)).rejects.toMatchObject({ code: "database_busy", retryable: true });
    expect(transport.layouts.stored(first)?.maximizedPaneId).toBe("b");
    await client.layoutSave(first, next);
    expect(transport.layouts.stored(first)?.maximizedPaneId).toBeNull();
  });

  it("ignores legacy stored browser state that contains secrets or duplicate identities", async () => {
    const { transport, client, first } = await setup();
    const secret = {
      ...twoPanes(),
      dock: [
        {
          kind: "browser" as const,
          browserId: crypto.randomUUID(),
          url: "https://example.com/callback?code=secret#access-token",
        },
      ],
    };
    transport.layouts.seed(first, secret);
    expect(await client.layoutGet(first)).toBeNull();

    const browserId = crypto.randomUUID();
    const duplicate: PaneLayout = {
      ...twoPanes(),
      root: {
        kind: "split",
        axis: "horizontal",
        ratios: [500, 500],
        children: [
          leaf("a", [{ kind: "browser", browserId, url: "https://example.com/preview" }]),
          leaf("b", [{ kind: "browser", browserId, url: "https://example.com/preview" }]),
        ],
      },
      maximizedPaneId: null,
      dock: [],
    };
    transport.layouts.seed(first, duplicate);
    expect(await client.layoutGet(first)).toBeNull();
  });

  it("presets keep only their shape, names are unique, and they can be deleted", async () => {
    const { client } = await setup();
    const preset = await client.layoutPresetSave("  Review  ", twoPanes());
    expect(preset.name).toBe("Review");
    expect(preset.layout.maximizedPaneId).toBeNull();
    expect(preset.layout.dock).toEqual([]);
    const root = preset.layout.root;
    expect(root.kind === "split" && root.ratios).toEqual([600, 400]);
    expect(root.kind === "split" && root.children.every((c) => c.kind === "leaf" && c.tabs.length === 0)).toBe(true);
    expect(await client.layoutPresets()).toEqual([preset]);
    await expect(client.layoutPresetSave("Review", twoPanes())).rejects.toMatchObject({ code: "preset_name_taken" });
    await expect(client.layoutPresetSave("a\nb", twoPanes())).rejects.toMatchObject({ code: "invalid_preset_name" });
    await client.layoutPresetDelete(preset.id);
    expect(await client.layoutPresets()).toEqual([]);
    await expect(client.layoutPresetDelete(preset.id)).rejects.toMatchObject({ code: "preset_not_found" });
  });

  it("the pane system feature is available", async () => {
    const { client } = await setup();
    const { info } = await client.boot();
    expect(info.flags.features?.find((f) => f.id === "pane_system")).toMatchObject({
      state: "available",
      visible: true,
    });
  });
});
