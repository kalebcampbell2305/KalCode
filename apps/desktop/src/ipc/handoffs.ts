import type { HandoffCompletion, HandoffPreview, HandoffRecord, HandoffTask } from "@kalcode/protocol";
import { toKalCodeError } from "./errors.ts";

export type HandoffsCommandName =
  | "handoff_preview"
  | "handoff_send"
  | "handoff_list"
  | "handoff_cancel"
  | "handoff_complete"
  | "handoff_return";

export type HandoffsInvoker = <T>(command: HandoffsCommandName, args: Record<string, unknown>) => Promise<T>;

export interface HandoffDraft {
  sourceThreadId: string;
  targetThreadId: string;
  task: HandoffTask;
  instructions: string;
  editedText?: string | null;
  priorPreviewId?: string | null;
}

/** The native coordinator owns identity, readiness, delivery and durable outcomes. */
export class HandoffsClient {
  constructor(private readonly invoke: HandoffsInvoker) {}

  private async call<T>(command: HandoffsCommandName, args: Record<string, unknown>): Promise<T> {
    try {
      return await this.invoke<T>(command, args);
    } catch (error) {
      throw toKalCodeError(error, command);
    }
  }

  preview(draft: HandoffDraft): Promise<HandoffPreview> {
    return this.call("handoff_preview", {
      ...draft,
      editedText: draft.editedText ?? null,
      priorPreviewId: draft.priorPreviewId ?? null,
    });
  }

  send(id: string, previewHash: string): Promise<HandoffRecord> {
    return this.call("handoff_send", { id, previewHash });
  }

  list(threadId: string | null = null): Promise<HandoffRecord[]> {
    return this.call("handoff_list", { threadId });
  }

  cancel(id: string): Promise<HandoffRecord> {
    return this.call("handoff_cancel", { id });
  }

  complete(id: string, outcome: HandoffCompletion, result: string): Promise<HandoffRecord> {
    return this.call("handoff_complete", { id, outcome, result });
  }

  returnFindings(id: string): Promise<HandoffPreview> {
    return this.call("handoff_return", { id });
  }
}
