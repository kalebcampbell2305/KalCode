/**
 * Permission UI (campaign Z4). The Dashboard (Z5) renders pending approvals with
 * `ApprovalPrompt` inside the shell's `PermissionsProvider`:
 *
 *   const { pending, decide } = usePermissions();
 *   pending.map((request) => <ApprovalPrompt key={request.id} request={request} onDecide={decide} />)
 *
 * The presentational primitive is `PermissionPrompt` in `@kalcode/ui/components`.
 */
export { ApprovalAnnouncer } from "./ApprovalAnnouncer.tsx";
export { ApprovalPrompt, type ApprovalPromptProps } from "./ApprovalPrompt.tsx";
export { ApprovalsPanel } from "./ApprovalsPanel.tsx";
export {
  actionDetail,
  DECISION_LABELS,
  MODE_DESCRIPTIONS,
  MODE_LABELS,
  SCOPE_LABELS,
  scopeTone,
  statusText,
} from "./labels.ts";
export { PermissionsProvider, type PermissionsValue, usePermissions } from "./PermissionsProvider.tsx";
export { PermissionsSettings } from "./PermissionsSettings.tsx";
