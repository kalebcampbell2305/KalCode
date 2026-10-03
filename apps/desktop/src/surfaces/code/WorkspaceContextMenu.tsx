import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@kalcode/ui/components";
import { ChevronDown, Globe, LayoutPanelLeft, PanelsTopLeft } from "lucide-react";
import { useState } from "react";
import { useRuntime } from "../../runtime/RuntimeProvider.tsx";
import { viewVisible } from "../../shell/navigation.tsx";
import { registeredWidgets } from "../../shell/panes/contentRegistry.ts";
import type { PaneController } from "../../shell/panes/usePaneController.ts";
import { HOME_WIDGET, PROJECT_WIDGET, WORKSPACES_WIDGET } from "../../shell/rail/paneIds.ts";
import { browserContent } from "../browser/index.ts";
import styles from "./Code.module.css";
import {
  CODE_CONTEXT_OPERATIONS_WIDGET_ID,
  codeContextOperationsAvailable,
  codeContextOperationsContent,
} from "./CodeContextOperations.tsx";

/** Opens existing context beside the work; terminal sessions stay mounted. */
export function WorkspaceContextMenu({ controller }: { controller: PaneController }) {
  const { info } = useRuntime();
  const [open, setOpen] = useState(false);
  const widgets = registeredWidgets().filter(({ widgetId }) => {
    if (widgetId === CODE_CONTEXT_OPERATIONS_WIDGET_ID) return false;
    if (widgetId === HOME_WIDGET) return viewVisible("home", info.flags.features);
    if (widgetId === PROJECT_WIDGET || widgetId === WORKSPACES_WIDGET)
      return viewVisible("folder", info.flags.features);
    return true;
  });
  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" icon={<PanelsTopLeft />} aria-label="Context">
          <span className={styles.collapsibleLabel}>Context</span>
          <ChevronDown aria-hidden="true" className={styles.chevron} />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" minWidth={17}>
        <DropdownMenuLabel>Beside your code</DropdownMenuLabel>
        <DropdownMenuItem
          icon={<Globe />}
          onSelect={() => controller.show(browserContent(), { placement: "split", focus: true })}
        >
          Browser
        </DropdownMenuItem>
        {codeContextOperationsAvailable(info.flags) ? (
          <DropdownMenuItem
            icon={<PanelsTopLeft />}
            onSelect={() => controller.show(codeContextOperationsContent(), { placement: "split", focus: true })}
          >
            Runs, services &amp; tests
          </DropdownMenuItem>
        ) : null}
        {widgets.length > 0 ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>Widgets</DropdownMenuLabel>
            {widgets.map(({ widgetId, title }) => (
              <DropdownMenuItem
                key={widgetId}
                icon={<LayoutPanelLeft />}
                onSelect={() => controller.show({ kind: "widget", widgetId }, { placement: "split", focus: true })}
              >
                {title}
              </DropdownMenuItem>
            ))}
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
