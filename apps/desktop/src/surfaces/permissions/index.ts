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
  DEFAULT_MODE_CHOICES,
  MODE_DESCRIPTIONS,
  MODE_LABELS,
  SCOPE_LABELS,
  START_MODES,
  scopeTone,
  startModeFor,
  statusText,
} from "./labels.ts";
export { PermissionsProvider, type PermissionsValue, usePermissions } from "./PermissionsProvider.tsx";
export { PermissionsSettings } from "./PermissionsSettings.tsx";
