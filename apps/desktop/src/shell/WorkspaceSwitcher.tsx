import { DropdownMenu, DropdownMenuTrigger, Tooltip } from "@kalcode/ui/components";
import { ChevronsUpDown, FolderClosed } from "lucide-react";
import { forwardRef } from "react";
import { useWorkspaces } from "../runtime/WorkspaceProvider.tsx";
import { WorkspaceMenuContent } from "../surfaces/code/WorkspaceMenu.tsx";
import { useNavigation } from "./navigation.tsx";
import styles from "./WorkspaceSwitcher.module.css";

/** Sidebar control showing the active workspace; opens a menu to switch or open a folder. */
export function WorkspaceSwitcher({ collapsed }: { collapsed: boolean }) {
  const { active, state } = useWorkspaces();
  const { navigate } = useNavigation();
  const name = active?.name ?? "No workspace";
  const trigger = (
    <DropdownMenuTrigger asChild>
      <SwitcherButton collapsed={collapsed} name={name} hasWorkspace={Boolean(active)} disabled={state === "loading"} />
    </DropdownMenuTrigger>
  );
  return (
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
