import {
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
} from "@kalcode/ui/components";
import { FolderOpen } from "lucide-react";
import { useRef } from "react";
import { useWorkspaces } from "../../runtime/WorkspaceProvider.tsx";

interface WorkspaceMenuContentProps {
  /** Runs after a workspace is chosen or opened (e.g. navigate to Code). */
  onChosen?: () => void;
  align?: "start" | "end";
  side?: "bottom" | "right";
}

/** Menu body listing workspaces (most recent first) with the active one checked. */
export function WorkspaceMenuContent({ onChosen, align = "start", side = "bottom" }: WorkspaceMenuContentProps) {
  const { workspaces, active, activate, openFolder } = useWorkspaces();
  const chosen = useRef(false);
  return (
    <DropdownMenuContent
      align={align}
      side={side}
      minWidth={17}
      // After a choice, focus belongs to the workspace that opened, not the menu's trigger.
      onCloseAutoFocus={(event) => {
        if (chosen.current) event.preventDefault();
        chosen.current = false;
      }}
    >
      {workspaces.length > 0 ? (
        <>
          <DropdownMenuLabel>Workspaces</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={active?.id ?? ""}
            onValueChange={(id) => {
              chosen.current = true;
              void activate(id).then((ok) => {
                if (ok) onChosen?.();
              });
            }}
          >
            {workspaces.map((workspace) => (
              <DropdownMenuRadioItem
                key={workspace.id}
                value={workspace.id}
                description={workspace.available ? workspace.displayPath : "Folder not found"}
              >
                {workspace.name}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
          <DropdownMenuSeparator />
        </>
      ) : null}
      <DropdownMenuItem
        icon={<FolderOpen />}
        onSelect={() => {
          chosen.current = true;
          void openFolder().then((workspace) => {
            if (workspace) onChosen?.();
          });
        }}
      >
        Open folder…
      </DropdownMenuItem>
    </DropdownMenuContent>
  );
}
