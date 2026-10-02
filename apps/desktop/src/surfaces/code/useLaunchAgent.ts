import { useCallback } from "react";
import { useWorkspaces } from "../../runtime/WorkspaceProvider.tsx";
import { useNavigation } from "../../shell/navigation.tsx";
import { dispatchPaneCommand } from "../../shell/panes/paneCommands.ts";

/**
 * "Launch an agent" from anywhere: opens Code and its + launcher for the active project (without
 * one, Code asks for a folder first). Agents are coding terminals, never Threads (AGENTS.md).
 */
export function useLaunchAgent(): () => void {
  const { navigate } = useNavigation();
  const { active } = useWorkspaces();
  return useCallback(() => {
    navigate("code");
    if (active) dispatchPaneCommand({ kind: "open-agent-launcher" }, { queue: true, scope: active.id });
  }, [navigate, active]);
}
