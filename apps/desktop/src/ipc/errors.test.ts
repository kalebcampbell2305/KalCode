import type { IpcError } from "@kalcode/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { COMMAND_UNAVAILABLE, isCommandUnavailable, KalCodeError, toKalCodeError } from "./errors.ts";

describe("IPC error classification", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    "Command settings_update not allowed by ACL",
    "settings_update not allowed. Command not found",
    "Command settings_update not found",
  ])("recognizes the complete native rejection: %s", (raw) => {
    const error = toKalCodeError(raw, "settings_update");
    expect(error.code).toBe(COMMAND_UNAVAILABLE);
    expect(isCommandUnavailable(error)).toBe(true);
  });

  it.each([
    "invalid args `patch` for command `settings_update`: unknown variant `not found`, expected one of `system`, `light`, `dark`",
    "invalid args `patch` for command `settings_update`: unknown variant `not allowed`",
    "Command settings_update_all not allowed by ACL",
    "settings_update_all not allowed. Command not found",
    "Command settings_update_all not found",
    "invalid args `patch` for command `settings_update`: Command settings_update not found",
    "Command settings_update not found: invalid argument",
    "Command settings_update not found\nadditional diagnostic",
  ])("keeps unrelated or embedded diagnostics generic: %s", (raw) => {
    const error = toKalCodeError(raw, "settings_update");
    expect(error.toIpcError()).toEqual({
      category: "internal",
      code: "ipc_rejected",
      message: "KalCode couldn't complete that request.",
      retryable: false,
    });
    expect(isCommandUnavailable(error)).toBe(false);
  });

  it("requires the command identity before recognizing an unavailable command", () => {
    expect(toKalCodeError("Command settings_update not found").code).toBe("ipc_rejected");
    expect(toKalCodeError("Command settings_update not found", "thread_list").code).toBe("ipc_rejected");
  });

  it("preserves native typed errors and existing KalCodeError instances", () => {
    const native: IpcError = {
      category: "database",
      code: "database_busy",
      message: "Try again shortly.",
      retryable: true,
    };
    const error = toKalCodeError(native, "settings_update");
    expect(error).toBeInstanceOf(KalCodeError);
    expect(error.toIpcError()).toEqual(native);
    expect(toKalCodeError(error, "settings_update")).toBe(error);
  });
});
