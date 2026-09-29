import { describe, expect, it } from "vitest";
import type { ThreadErrorKind } from "./generated/index.ts";
import { THREAD_ERROR_KIND_OF_CODE, threadErrorKindOf } from "./thread-errors.ts";

describe("threadErrorKindOf", () => {
  it("tells waiting and resource outcomes apart from provider failures", () => {
    const kinds: Record<string, ThreadErrorKind> = {
      waiting_for_resources: "waiting_for_resources",
      resources_unavailable: "resources_unavailable",
      provider_start_failed: "provider_start_failed",
      provider_exited: "provider_process_exited",
      process_exited: "provider_process_exited",
      provider_not_authenticated: "auth_required",
      provider_version_unsupported: "unsupported_version",
      codex_approve_requires_git: "non_git_approve_guard",
      provider_account_ineligible: "account_refused",
      provider_account_busy: "account_refused",
    };
    for (const [code, kind] of Object.entries(kinds)) expect(threadErrorKindOf(code)).toBe(kind);
  });

  it("keeps older and unknown codes readable", () => {
    expect(threadErrorKindOf("turn_success")).toBe("other");
    expect(threadErrorKindOf("codex_item_error")).toBe("other");
    expect(threadErrorKindOf("")).toBe("other");
    // Inherited object keys are not codes.
    expect(threadErrorKindOf("toString")).toBe("other");
    expect(Object.keys(THREAD_ERROR_KIND_OF_CODE)).toHaveLength(14);
  });
});
