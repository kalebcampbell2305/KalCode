import { DropdownMenu, DropdownMenuTrigger, Tooltip } from "@kalcode/ui/components";
import { ChevronsUpDown, FolderClosed } from "lucide-react";
import { forwardRef, useState } from "react";
import { useWorkspaces } from "../runtime/WorkspaceProvider.tsx";
import { WorkspaceMenuContent } from "../surfaces/code/WorkspaceMenu.tsx";
import { useNavigation } from "./navigation.tsx";
import { allEntries } from "./rail/model.ts";
import { RailDialogs } from "./rail/RailDialogs.tsx";
import { useRail } from "./rail/RailProvider.tsx";
import type { RailDialog } from "./rail/RailTree.tsx";
import { WorkspaceContextMenu } from "./rail/WorkspaceContextMenu.tsx";
import styles from "./WorkspaceSwitcher.module.css";

/** Sidebar control showing the active workspace; opens a menu to switch or open a folder. */
export function WorkspaceSwitcher({ collapsed }: { collapsed: boolean }) {
  const { active, state } = useWorkspaces();
  const { navigate } = useNavigation();
  const rail = useRail();
  const [dialog, setDialog] = useState<RailDialog | null>(null);
  const entry = rail.rail ? allEntries(rail.rail).find((workspace) => workspace.workspaceId === active?.id) : null;
  const name = active?.name ?? "No workspace";
  const button = (
    <SwitcherButton collapsed={collapsed} name={name} hasWorkspace={Boolean(active)} disabled={state === "loading"} />
  );
  const dropdownTrigger = <DropdownMenuTrigger asChild>{button}</DropdownMenuTrigger>;
  const trigger = entry ? (
    <WorkspaceContextMenu entry={entry} onDialog={setDialog}>
      {dropdownTrigger}
    </WorkspaceContextMenu>
  ) : (
    dropdownTrigger
  );
  return (
    <>
      <DropdownMenu>
        {collapsed ? (
          <Tooltip content={active ? `Workspace: ${active.name}` : "Open a workspace"} side="right">
            {trigger}
          </Tooltip>
        ) : (
          trigger
        )}
        <WorkspaceMenuContent side={collapsed ? "right" : "bottom"} onChosen={() => navigate("code")} />
      </DropdownMenu>
      <RailDialogs dialog={dialog} onClose={() => setDialog(null)} />
    </>
  );
}

interface SwitcherButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  collapsed: boolean;
  name: string;
  hasWorkspace: boolean;
}

const SwitcherButton = forwardRef<HTMLButtonElement, SwitcherButtonProps>(function SwitcherButton(
  { collapsed, name, hasWorkspace, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type="button"
      className={styles.switcher}
      data-collapsed={collapsed || undefined}
      aria-label={collapsed ? `Workspace: ${name}` : undefined}
      {...rest}
    >
      <span className={styles.icon} aria-hidden="true">
        <FolderClosed />
      </span>
      {collapsed ? null : (
        <>
          <span className={styles.text}>
            <span className={styles.caption}>Workspace</span>
            <span className={styles.name} data-empty={!hasWorkspace || undefined}>
              {name}
            </span>
          </span>
          <ChevronsUpDown className={styles.chevron} aria-hidden="true" />
        </>
      )}
    </button>
  );
});
