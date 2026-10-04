import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  IconButton,
  Tooltip,
  useToast,
} from "@kalcode/ui/components";
import { FlaskConical, Focus, Globe, Hand, LayoutPanelLeft, Minimize2, PanelsTopLeft, Zap } from "lucide-react";
import { useMemo, useState } from "react";
import { toKalCodeError } from "../../../ipc/errors.ts";
import { OperationsClient } from "../../../ipc/operations.ts";
import { useRuntime } from "../../../runtime/RuntimeProvider.tsx";
import { viewVisible } from "../../../shell/navigation.tsx";
import { registeredWidgets } from "../../../shell/panes/contentRegistry.ts";
import type { PaneController } from "../../../shell/panes/usePaneController.ts";
import { HOME_WIDGET, PROJECT_WIDGET, WORKSPACES_WIDGET } from "../../../shell/rail/paneIds.ts";
import { useOptionalPermissions } from "../../permissions/PermissionsProvider.tsx";
import {
  CODE_CONTEXT_OPERATIONS_WIDGET_ID,
  codeContextOperationsAvailable,
  codeContextOperationsContent,
} from "../CodeContextOperations.tsx";
import { openBrowser, repeatableTestRun, runTests, showBeside, showFirst } from "./actions.ts";
import styles from "./Organization.module.css";
import type { Organization } from "./useOrganization.ts";

/** Opens the Browser beside the work. Icon-only: the quick bar stays compact. */
export function BrowserButton({ controller }: { controller: PaneController }) {
  return (
    <Tooltip content="Browser: open it beside your code">
      <IconButton
        size="sm"
        className={styles.quickExtra}
        label="Browser"
        icon={<Globe />}
        onClick={() => openBrowser(controller)}
      />
    </Tooltip>
  );
}

/** Widgets and Runs & services, opened beside the work; opening never starts anything. */
export function WidgetsMenu({ controller }: { controller: PaneController }) {
  const { info } = useRuntime();
  const widgets = registeredWidgets().filter(({ widgetId }) => {
    if (widgetId === CODE_CONTEXT_OPERATIONS_WIDGET_ID) return false;
    if (widgetId === HOME_WIDGET) return viewVisible("home", info.flags.features);
    if (widgetId === PROJECT_WIDGET || widgetId === WORKSPACES_WIDGET)
      return viewVisible("folder", info.flags.features);
    return true;
  });
  const operations = codeContextOperationsAvailable(info.flags);
  return (
    <DropdownMenu>
      {/* No tooltip on a menu trigger: it would reopen over the work when the menu returns focus. */}
      <DropdownMenuTrigger asChild>
        <IconButton size="sm" label="Widgets" title="Widgets: open one beside your code" icon={<PanelsTopLeft />} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" minWidth={17}>
        <DropdownMenuLabel>Beside your code</DropdownMenuLabel>
        {operations ? (
          <DropdownMenuItem
            icon={<PanelsTopLeft />}
            onSelect={() => showBeside(controller, codeContextOperationsContent())}
          >
            Runs, services &amp; tests
          </DropdownMenuItem>
        ) : null}
        {operations && widgets.length > 0 ? <DropdownMenuSeparator /> : null}
        {widgets.map(({ widgetId, title }) => (
          <DropdownMenuItem
            key={widgetId}
            icon={<LayoutPanelLeft />}
            onSelect={() => showBeside(controller, { kind: "widget", widgetId })}
          >
            {title}
          </DropdownMenuItem>
        ))}
        {!operations && widgets.length === 0 ? (
          <DropdownMenuItem disabled icon={<LayoutPanelLeft />}>
            No widgets available
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * Runs the workspace's tests again through Operations (which asks first), or opens Tests when
 * there is no test task yet. Unavailable while Operations is off in this build.
 */
export function RunTestsButton({
  controller,
  organization,
}: {
  controller: PaneController;
  organization: Organization;
}) {
  const { client, info } = useRuntime();
  const toast = useToast();
  const operationsClient = useMemo(
    () => new OperationsClient((command, args) => client.transport.invoke(command, args)),
    [client],
  );
  const [busy, setBusy] = useState(false);
  if (!codeContextOperationsAvailable(info.flags)) return null;
  const run = repeatableTestRun(organization.operations);
  const tooltip = run ? `Run “${run.spec.name}” again (asks first)` : "Open Tests: no test task in this workspace yet";
  return (
    <Tooltip content={tooltip}>
      <IconButton
        size="sm"
        className={styles.quickExtra}
        label="Run Tests"
        icon={<FlaskConical />}
        busy={busy}
        onClick={async () => {
          setBusy(true);
          try {
            await runTests(controller, organization.operations, operationsClient);
          } catch (cause) {
            toast.show({ tone: "danger", title: "Tests didn't start", description: toKalCodeError(cause).message });
          } finally {
            setBusy(false);
          }
        }}
      />
    </Tooltip>
  );
}

/** Focus maximizes the focused pane without discarding the layout; again restores it. */
export function FocusButton({ controller, onFocus }: { controller: PaneController; onFocus: () => void }) {
  const focused = controller.layout.maximizedPaneId !== null;
  return (
    <Tooltip
      content={focused ? "Exit focus: restore the layout" : "Focus: maximize the focused pane (the layout is kept)"}
    >
      <IconButton
        size="sm"
        className={styles.quickExtra}
        label="Focus"
        aria-pressed={focused}
        icon={focused ? <Minimize2 /> : <Focus />}
        onClick={() => (focused ? controller.restore() : onFocus())}
      />
    </Tooltip>
  );
}

/** Tiny counters for working agents and what needs you; each shows the first one. Hidden at zero. */
export function AgentCounters({
  controller,
  organization,
}: {
  controller: PaneController;
  organization: Organization;
}) {
  const { items, needsYou } = organization;
  const working = items.filter(
    (i) => i.kind === "agent" && (i.status?.badge === "working" || i.status?.badge === "testing"),
  ).length;
  // With no waiting agent in this workspace, what needs you is an approval: open the approvals panel.
  const openApprovals = useOptionalPermissions()?.setPanelOpen ?? null;
  if (working === 0 && needsYou.count === 0) return null;
  return (
    <>
      {working > 0 ? (
        <Tooltip content="Show the first working agent">
          <button
            type="button"
            className={styles.counter}
            data-tone="working"
            aria-label={`${working} ${working === 1 ? "agent" : "agents"} working`}
            onClick={() => showFirst(controller, items, ["working", "testing"], "agent")}
          >
            <Zap aria-hidden="true" />
            {working}
          </button>
        </Tooltip>
      ) : null}
      {needsYou.count > 0 ? (
        <Tooltip content="Show what needs you">
          <button
            type="button"
            className={styles.counter}
            data-tone="waiting"
            aria-label={`${needsYou.count} needs you`}
            onClick={() => {
              if (!showFirst(controller, items, ["waiting"], "agent")) openApprovals?.(true);
            }}
          >
            <Hand aria-hidden="true" />
            {needsYou.count}
          </button>
        </Tooltip>
      ) : null}
    </>
  );
}
