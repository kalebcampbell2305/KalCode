import type { HandoffPreview, HandoffRecord, PaneInfo, ThreadSummary } from "@kalcode/protocol";
import { describe, expect, it, vi } from "vitest";
import { createHandoffsMemory } from "./handoffs.ts";

function fixture() {
  let blocked = true;
  let instance = "instance-1";
  const deliver = vi.fn((_id: string, expected: string, _text: string) => {
    if (instance !== expected) throw { code: "provider_target_changed" };
    if (blocked) throw { code: "handoff_busy" };
  });
  const handlers = createHandoffsMemory({
    requireCore() {},
    thread: (id) =>
      ({
        id,
        name: id,
        runtimeKind: "interactive_pty",
        workspaceId: "project",
        workspaceName: "Project",
        branch: "main",
      }) as ThreadSummary,
    info: () => ({ running: true, instanceId: instance }) as PaneInfo,
    deliver,
  });
  const preview = () =>
    handlers.handoff_preview?.({
      sourceThreadId: "claude",
      targetThreadId: "codex",
      task: "review",
      instructions: "Review persistence",
    }) as HandoffPreview;
  const send = (p: HandoffPreview) =>
    handlers.handoff_send?.({ id: p.id, previewHash: p.previewHash }) as HandoffRecord;
  const list = () => handlers.handoff_list?.({}) as HandoffRecord[];
  return {
    handlers,
    preview,
    send,
    list,
    deliver,
    ready: () => {
      blocked = false;
    },
    restart: () => {
      instance = "instance-2";
    },
  };
}

describe("handoff UI fixture lifecycle", () => {
  it("queues while busy, delivers once when ready, and never invents completion", () => {
    const f = fixture();
    const p = f.preview();
    expect(f.send(p).status).toBe("queued");
    expect(f.list()[0]?.status).toBe("queued");
    f.ready();
    expect(f.list()[0]?.status).toBe("delivered");
    const count = f.deliver.mock.calls.length;
    expect(f.send(p).status).toBe("delivered");
    expect(f.list()[0]?.status).toBe("delivered");
    expect(f.deliver).toHaveBeenCalledTimes(count);
  });

  it("rejects a changed preview hash and cancels only undelivered work", () => {
    const f = fixture();
    const p = f.preview();
    expect(() => f.send({ ...p, previewHash: "changed" })).toThrow();
    expect(f.deliver).not.toHaveBeenCalled();
    f.send(p);
    f.handlers.handoff_cancel?.({ id: p.id });
    f.ready();
    expect(f.list()[0]?.status).toBe("cancelled");
    expect(f.deliver).toHaveBeenCalledOnce();
  });

  it("never sends a queued handoff into a replacement provider process", () => {
    const f = fixture();
    f.send(f.preview());
    f.restart();
    f.ready();
    expect(f.list()[0]?.status).toBe("interrupted");
    const count = f.deliver.mock.calls.length;
    f.list();
    expect(f.deliver).toHaveBeenCalledTimes(count);
  });

  it("requires explicit findings and previews the return without sending", () => {
    const f = fixture();
    f.ready();
    const row = f.send(f.preview());
    expect(() => f.handlers.handoff_return?.({ id: row.id })).toThrow();
    expect(() => f.handlers.handoff_complete?.({ id: row.id, outcome: "completed", result: "" })).toThrow();
    f.handlers.handoff_complete?.({ id: row.id, outcome: "completed", result: "Found a persistence bug." });
    const returned = f.handlers.handoff_return?.({ id: row.id }) as HandoffPreview;
    expect(returned.sourceThreadId).toBe("codex");
    expect(returned.targetThreadId).toBe("claude");
    expect(returned.text).toContain("Found a persistence bug.");
    expect(f.deliver).toHaveBeenCalledOnce();
    expect(f.list()).toHaveLength(1);
    const revised = f.handlers.handoff_preview?.({
      sourceThreadId: returned.sourceThreadId,
      targetThreadId: returned.targetThreadId,
      task: returned.task,
      instructions: "",
      editedText: "Updated findings: persistence passes; offline case fails.",
      priorPreviewId: returned.id,
    }) as HandoffPreview;
    expect(() => f.send(returned)).toThrow();
    expect(f.send(revised).returnOfId).toBe(row.id);
  });
});
