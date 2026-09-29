/**
 * What kind of problem a thread's `ThreadError` reports, derived from its stable code. The Rust
 * side is `ThreadErrorKind::of_code` in `crates/contracts/src/threads.rs`; a Rust test keeps the
 * table below identical to it, row for row. Codes persisted by older builds keep their meaning;
 * an unknown code is `other`.
 */
import type { ThreadErrorKind } from "./generated/index.ts";

export const THREAD_ERROR_KIND_OF_CODE = {
  waiting_for_resources: "waiting_for_resources",
  resources_unavailable: "resources_unavailable",
  provider_start_failed: "provider_start_failed",
  provider_exited: "provider_process_exited",
  process_exited: "provider_process_exited",
  provider_not_authenticated: "auth_required",
  provider_account_ineligible: "account_refused",
  provider_account_busy: "account_refused",
  provider_account_plan_unsupported: "account_refused",
  provider_account_plan_unverified: "account_refused",
  provider_account_check_failed: "account_refused",
  provider_version_unsupported: "unsupported_version",
  codex_approve_requires_git: "non_git_approve_guard",
  provider_not_installed: "provider_not_installed",
} as const satisfies Record<string, ThreadErrorKind>;

/** The kind of a stored thread error code. */
export function threadErrorKindOf(code: string): ThreadErrorKind {
  return Object.hasOwn(THREAD_ERROR_KIND_OF_CODE, code)
    ? THREAD_ERROR_KIND_OF_CODE[code as keyof typeof THREAD_ERROR_KIND_OF_CODE]
    : "other";
}
