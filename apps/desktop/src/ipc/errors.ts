import type { ErrorCategory, IpcError } from "@kalcode/protocol";

const CATEGORIES: ReadonlySet<string> = new Set<ErrorCategory>([
  "database",
  "filesystem",
  "validation",
  "permission",
  "provider",
  "authentication",
  "terminal",
  "git",
  "network",
  "plugin",
  "mission",
  "verification",
  "billing",
  "update",
  "secure_store",
  "internal",
]);

/** An IPC failure with the native error's category, code and user-safe message. */
export class KalCodeError extends Error {
  readonly category: ErrorCategory;
  readonly code: string;
  readonly retryable: boolean;

  constructor(error: IpcError) {
    super(error.message);
    this.name = "KalCodeError";
    this.category = error.category;
    this.code = error.code;
    this.retryable = error.retryable;
  }

  toIpcError(): IpcError {
    return { category: this.category, code: this.code, message: this.message, retryable: this.retryable };
  }
}

function isIpcError(value: unknown): value is IpcError {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.category === "string" &&
    CATEGORIES.has(v.category) &&
    typeof v.code === "string" &&
    typeof v.message === "string" &&
    typeof v.retryable === "boolean"
  );
}

/**
 * Converts anything thrown across the IPC boundary into a KalCodeError. Native command errors
 * already have the right shape; anything else (e.g. Tauri rejecting malformed arguments) is
 * reported generically so internal details never reach the UI.
 */
export function toKalCodeError(error: unknown): KalCodeError {
  if (error instanceof KalCodeError) return error;
  if (isIpcError(error)) return new KalCodeError(error);
  if (import.meta.env.DEV) console.error("Unexpected IPC failure", error);
  return new KalCodeError({
    category: "internal",
    code: "ipc_rejected",
    message: "KalCode couldn't complete that request.",
    retryable: false,
  });
}
