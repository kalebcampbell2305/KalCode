import type { ContextPreview, FileHandle, ThreadSummary } from "@kalcode/protocol";

/** Content-free native warning. Detector identifiers and counts never include matched values. */
export interface PromptWarning {
  reviewId: string;
  detectors: Record<string, number>;
}

/** Read-only prompt inspection. Native remains the sole authority that can admit a prompt. */
export type PromptReview = { kind: "clean" } | { kind: "confirmation_required"; warning: PromptWarning };

/** Explicit user-selected inputs. File paths never cross the WebView boundary. */
export type ContextInput =
  | { kind: "file"; handle: FileHandle }
  | { kind: "text"; label: string; text: string }
  | { kind: "selection"; label: string; text: string }
  | { kind: "log_output"; label: string; text: string }
  | { kind: "url"; url: string };

export interface ContextFileChoice {
  handle: FileHandle;
  /** A sanitized filename only, never a path. */
  label: string;
}

export type ContextSendResult = { kind: "sent"; thread: ThreadSummary } | { kind: "stale"; preview: ContextPreview };
