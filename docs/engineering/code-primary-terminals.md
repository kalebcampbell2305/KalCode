# Code as the daily workspace

Code restores the active workspace at startup, while an explicit navigation action made during restore wins. New users without a workspace retain the existing Home/Dashboard entry. Code is first in primary navigation.

The existing provider-pane runtime remains authoritative. Every coding agent is an `interactive_pty` record with its own native PTY and provider session. Fleet and the agent rail focus that same Code pane. Threads remain separate. The launcher now uses the remembered provider when no provider is explicitly requested; its existing account/model/effort validation and workspace binding remain unchanged.

The Context menu opens Browser, registered widgets, and current-workspace Runs/Services/Tests beside terminals. Operations data, service actions, run evidence, feature flags, and history entitlements use the existing canonical clients and contracts. Opening context does not start work. Operations polling pauses when Code or its context pane is hidden; same-frame duplicate mutations are rejected before asynchronous work starts. Run details account for both collapsed and expanded agent rails. Compact details use a visible, named dialog portal so native Browser children cannot cover them; hiding the pane removes the global drawer while preserving selection.

## Evidence

- `CodeStartup.test.tsx`: restoration, absent workspace, failed restore, explicit navigation, and later refresh behavior.
- `code-daily.spec.ts`: returning-workspace startup, remembered exact launch selection, explicit provider override, four distinct panes, and Fleet focus without duplicate sessions.
- `provider-panes.spec.ts` (native): four independent processes/PTYS/session IDs, inherited workspace/account/model/effort, exact Fleet focus, and owned-child cleanup using the isolated fake provider.
- `CodeContextOperations.test.tsx`, `useOperations.test.tsx`, and `OperationsPage.test.tsx`: feature/entitlement filtering, truthful state, Strict Mode lifecycle, hidden polling, and duplicate mutation protection.
- `code-context.spec.ts`: canonical service actions, Logs/Tests evidence, narrow viewport layout, expanded-rail bounds, and accessibility.
- `adaptive-canvas.spec.ts`: fitting mixed-axis panes do not introduce scrollbars. Divider hit targets expand across their axis only, preventing a native scrollbar/resize feedback loop while retaining wide drag targets.
- Existing provider restart tests retain native account persistence coverage. This change adds no credential storage, schema migration, or authentication refresh behavior.
- The website's sample workspace mirrors Code-first navigation and the compact context pane. Its unit and browser tests cover pane reuse, truthful run state, desktop/phone navigation, and accessibility; the demo remains explicitly labeled sample data.

Browser UI tests use deterministic adapters. Native tests use isolated profiles and fake provider executables; they do not demonstrate a paid provider response. Signed Windows/macOS release and updater receipts are separate release evidence and must be verified before claiming delivery.

## Compatibility and rollback

No native API or persisted schema changes. Pane content uses the existing widget registry. Revert the feature commit to restore the prior startup, launcher default, and context UI. Saved provider accounts and terminal records need no migration or destructive cleanup. Remove an obsolete context widget through the existing pane controls if rolling back. Never reset shared history or close the owner's active app for rollback.
