/**
 * Permission helpers. The permission TYPES are shared contracts defined in Rust
 * (`crates/contracts/src/permissions.rs`) and generated into `./generated`; do not redefine them.
 */
import type { ApprovalRequest, PermissionScope } from "./generated/index.ts";

/**
 * The approval shape every surface shows. Z4 introduced `ApprovalView` as a superset of
 * `ApprovalRequest`; CA-1 adopted its extra fields into `ApprovalRequest`, so the view is now the
 * same type (Rust: `kalcode_permissions::ApprovalView = ApprovalRequest`).
 */
export type ApprovalView = ApprovalRequest;

/** Scopes whose consequences leave the machine. Never implied by Bypass. Mirrors Rust. */
export const REMOTE_CONSEQUENTIAL_SCOPES = [
  "git.push",
  "messaging.send",
  "deploy.production",
  "cloud.modify",
  "billing.spend",
] as const satisfies readonly PermissionScope[];

export function isRemoteConsequential(scope: PermissionScope): boolean {
  return (REMOTE_CONSEQUENTIAL_SCOPES as readonly PermissionScope[]).includes(scope);
}
