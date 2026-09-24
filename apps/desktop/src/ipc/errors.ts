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

/** Code of the error raised when a command is not part of this build (not registered natively). */
export const COMMAND_UNAVAILABLE = "command_unavailable";

/**
 * True when Tauri refused `command` because this build does not register it. Tauri rejects such
 * calls with a plain string before any native code runs: "Command <name> not allowed by ACL"
 * (release builds) or "<name> not allowed. Command not found" (debug builds), or
 * "Command <name> not found" when no app manifest is present.
 */
function isUnregisteredCommand(error: unknown, command: string): boolean {
  if (typeof error !== "string") return false;
  if (!error.includes(command)) return false;
  return /not allowed|not found/i.test(error);
}

export function isCommandUnavailable(error: unknown): boolean {
  return error instanceof KalCodeError && error.code === COMMAND_UNAVAILABLE;
}

/**
 * Converts anything thrown across the IPC boundary into a KalCodeError. Native command errors
 * already have the right shape; anything else (e.g. Tauri rejecting malformed arguments) is
 * reported generically so internal details never reach the UI. When `command` is given, a
 * rejection because that command is not in this build becomes a typed `command_unavailable`.
 */
export function toKalCodeError(error: unknown, command?: string): KalCodeError {
  if (error instanceof KalCodeError) return error;
  if (isIpcError(error)) return new KalCodeError(error);
  if (command && isUnregisteredCommand(error, command)) {
    return new KalCodeError({
      category: "internal",
      code: COMMAND_UNAVAILABLE,
      message: "This build of KalCode doesn't include that yet.",
      retryable: false,
    });
  }
  if (import.meta.env.DEV) console.error("Unexpected IPC failure", error);
  return new KalCodeError({
    category: "internal",
    code: "ipc_rejected",
    message: "KalCode couldn't complete that request.",
    retryable: false,
  });
}
