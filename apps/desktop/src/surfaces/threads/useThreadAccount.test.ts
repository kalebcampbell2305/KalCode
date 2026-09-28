import { describe, expect, it } from "vitest";
import { KalCodeError } from "../../ipc/errors.ts";
import { describeSendError, THREAD_ACCOUNT_CHANGED_MESSAGE } from "./useThreadAccount.ts";

describe("describeSendError", () => {
  it("explains native thread_account_changed in KalCode's words", () => {
    const error = new KalCodeError({
      category: "validation",
      code: "thread_account_changed",
      message: "This thread was switched to another account while your message was being sent.",
      retryable: false,
    });
    expect(describeSendError(error)).toBe(
      "This thread's account changed before your message was sent. Nothing was sent — send it again.",
    );
    expect(THREAD_ACCOUNT_CHANGED_MESSAGE).toBe(describeSendError(error));
  });

  it("keeps native copy for every other refusal", () => {
    const error = {
      category: "validation",
      code: "thread_not_running",
      message: "This thread isn't running. Resume it to continue.",
      retryable: false,
    };
    expect(describeSendError(error)).toBe("This thread isn't running. Resume it to continue.");
  });
});
