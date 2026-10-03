import { useCallback } from "react";
import { useWorkspaces } from "../../runtime/WorkspaceProvider.tsx";
import { useNavigation } from "../../shell/navigation.tsx";
import { dispatchPaneCommand } from "../../shell/panes/paneCommands.ts";

/**
 * "Launch an agent" from anywhere: opens Code and its + launcher for the active project. Without
 * one, it asks for the folder first and then opens the launcher there, so the person never has to
 * find New agent again. Agents are coding terminals, never Threads (AGENTS.md).
 */
export function useLaunchAgent(): () => void {
  const { navigate } = useNavigation();
  const { active, openFolder } = useWorkspaces();
  return useCallback(() => {
    navigate("code");
    if (active) {
      dispatchPaneCommand({ kind: "open-agent-launcher" }, { queue: true, scope: active.id });
      return;
    }
    void openFolder().then((opened) => {
      if (opened) dispatchPaneCommand({ kind: "open-agent-launcher" }, { queue: true, scope: opened.id });
    });
  }, [navigate, active, openFolder]);
}
