/** Handoff test adapter. Imported only by the excluded-from-production memory transport. */
import type { HandoffPreview, HandoffRecord, HandoffTask, PaneInfo, ThreadSummary } from "@kalcode/protocol";
import type { DashboardHandlers } from "./dashboard.ts";

interface Options {
  requireCore: () => void;
  thread: (id: string) => ThreadSummary;
  info: (id: string) => PaneInfo | null;
  deliver: (id: string, instanceId: string, text: string) => void;
}

function fail(code: string, message: string): never {
  throw { category: "validation", code, message, retryable: true };
}

const TASKS: readonly string[] = ["review", "test", "fix", "continue"];

export function createHandoffsMemory(options: Options): DashboardHandlers {
  const drafts = new Map<
    string,
    {
      preview: HandoffPreview;
      source: ThreadSummary;
      target: ThreadSummary;
      instance: string;
      returnOfId: string | null;
    }
  >();
  const records = new Map<string, HandoffRecord>();
  const pending = new Map<string, { text: string; instance: string }>();
  const now = () => new Date().toISOString();
  const get = (id: unknown) => {
    options.requireCore();
    const row = records.get(String(id));
    if (!row) fail("handoff_not_found", "This handoff is no longer available.");
    return row;
  };
  const draft = (args: Record<string, unknown>, returnOfId: string | null = null): HandoffPreview => {
    options.requireCore();
    const prior = args.priorPreviewId == null ? null : drafts.get(String(args.priorPreviewId));
    if (args.priorPreviewId != null) {
      if (!prior || records.has(prior.preview.id) || Date.parse(prior.preview.expiresAt) <= Date.now())
        fail("handoff_preview_stale", "Preview this handoff again before editing.");
      if (
        prior.preview.sourceThreadId !== args.sourceThreadId ||
        prior.preview.targetThreadId !== args.targetThreadId ||
        prior.preview.task !== args.task
      )
        fail("handoff_preview_mismatch", "The handoff recipient or task changed.");
      returnOfId = prior.returnOfId;
    }
    const source = options.thread(String(args.sourceThreadId));
    const target = options.thread(String(args.targetThreadId));
    if (source.id === target.id || source.runtimeKind !== "interactive_pty" || target.runtimeKind !== "interactive_pty")
      fail("handoff_agents_required", "Choose a different coding agent.");
    const info = options.info(target.id);
    if (!info?.running || !info.instanceId) fail("handoff_target_unavailable", "Open a running receiving agent first.");
    if (!TASKS.includes(String(args.task))) fail("handoff_task_invalid", "Choose a handoff task.");
    if (source.workspaceId !== target.workspaceId)
      fail("handoff_workspace_mismatch", "Choose an agent in this project.");
    const instructions = String(args.instructions ?? "");
    const text =
      args.editedText == null
        ? `Task: ${String(args.task)}\nSource: ${source.name}\nProject: ${source.workspaceName}\nSource branch: ${source.branch ?? "Not recorded"}\nOriginal request and test results: not observed; add relevant details.\n${instructions}`
        : String(args.editedText);
    if (!text.trim() || new TextEncoder().encode(text).length > 24000)
      fail("handoff_text_invalid", "Write a brief under 24 KB.");
    if ([...text].some((c) => c.charCodeAt(0) < 32 && c !== "\n" && c !== "\t"))
      fail("handoff_text_invalid", "Remove terminal control characters.");
    const preview: HandoffPreview = {
      id: crypto.randomUUID(),
      sourceThreadId: source.id,
      targetThreadId: target.id,
      task: args.task as HandoffTask,
      text,
      previewHash: crypto.randomUUID(),
      sourceCommit: null,
      sourceBranch: source.branch,
      sourceDirty: false,
      warnings: ["Fixture context only. No real Git scan or provider call."],
      expiresAt: new Date(Date.now() + 300000).toISOString(),
    };
    drafts.set(preview.id, { preview, source, target, instance: info.instanceId, returnOfId });
    if (prior) drafts.delete(prior.preview.id);
    return structuredClone(preview);
  };
  const tick = () => {
    for (const row of records.values()) {
      if (row.status !== "queued") continue;
      const dispatch = pending.get(row.id);
      if (!dispatch) continue;
      try {
        options.deliver(row.targetThreadId, dispatch.instance, dispatch.text);
        row.status = "delivered";
        row.blocker = null;
        pending.delete(row.id);
      } catch (error) {
        const code =
          typeof error === "object" && error !== null && "code" in error ? String(error.code) : "handoff_unavailable";
        if (code === "provider_target_changed" || code === "pane_not_running") {
          row.status = "interrupted";
          pending.delete(row.id);
        }
        row.blocker = "Waiting for the receiving agent's empty, ready input.";
      }
      row.updatedAt = now();
    }
  };
  return {
    handoff_preview: (args) => draft(args),
    handoff_send: (args) => {
      options.requireCore();
      const stored = drafts.get(String(args.id));
      if (
        !stored ||
        stored.preview.previewHash !== args.previewHash ||
        Date.parse(stored.preview.expiresAt) <= Date.now()
      )
        fail("handoff_preview_stale", "Preview this handoff again before sending.");
      const existing = records.get(stored.preview.id);
      if (existing) return structuredClone(existing);
      const { preview, source, target, instance, returnOfId } = stored;
      const row: HandoffRecord = {
        id: preview.id,
        sourceThreadId: source.id,
        targetThreadId: target.id,
        sourceWorkspaceId: source.workspaceId,
        targetWorkspaceId: target.workspaceId,
        sourceName: source.name,
        targetName: target.name,
        task: preview.task,
        status: "queued",
        createdAt: now(),
        updatedAt: now(),
        result: null,
        blocker: null,
        sourceCommit: preview.sourceCommit,
        sourceBranch: preview.sourceBranch,
        returnOfId,
      };
      records.set(row.id, row);
      pending.set(row.id, { text: preview.text, instance });
      tick();
      return structuredClone(row);
    },
    handoff_list: (args) => {
      options.requireCore();
      tick();
      return structuredClone(
        [...records.values()].filter(
          (row) => !args.threadId || row.sourceThreadId === args.threadId || row.targetThreadId === args.threadId,
        ),
      );
    },
    handoff_cancel: (args) => {
      const row = get(args.id);
      if (row.status !== "queued")
        fail("handoff_already_delivered", "Delivered work remains in the receiving terminal.");
      row.status = "cancelled";
      row.updatedAt = now();
      pending.delete(row.id);
      return structuredClone(row);
    },
    handoff_complete: (args) => {
      const row = get(args.id);
      if (!["delivered", "working", "needs_you"].includes(row.status))
        fail("handoff_not_delivered", "Only delivered handoffs can have a result.");
      if (!["completed", "failed"].includes(String(args.outcome)))
        fail("handoff_outcome_invalid", "Choose a result outcome.");
      const result = String(args.result ?? "").trim();
      if (!result || result.length > 8000)
        fail("handoff_result_invalid", "Describe the result in under 8,000 characters.");
      row.status = args.outcome as "completed" | "failed";
      row.result = result;
      row.updatedAt = now();
      return structuredClone(row);
    },
    handoff_return: (args) => {
      const row = get(args.id);
      if (!row.result) fail("handoff_result_required", "Record findings before returning them.");
      return draft(
        {
          sourceThreadId: row.targetThreadId,
          targetThreadId: row.sourceThreadId,
          task: "review",
          instructions: `Findings from ${row.targetName}:\n${row.result}`,
        },
        row.id,
      );
    },
  };
}
