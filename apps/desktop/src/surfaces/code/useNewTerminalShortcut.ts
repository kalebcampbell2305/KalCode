import { useEffect, useRef } from "react";
import { useWorkspaces } from "../../runtime/WorkspaceProvider.tsx";
import { useNavigation } from "../../shell/navigation.tsx";
import { codeShortcut } from "./shortcuts.ts";

/**
 * Ctrl+Shift+` anywhere: go to Code and open a terminal in the active workspace (or ask for a
 * folder when there is none).
 */
export function useNewTerminalShortcut() {
  const { navigate } = useNavigation();
  const workspaces = useWorkspaces();
  const latest = useRef({ navigate, workspaces });
  latest.current = { navigate, workspaces };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || codeShortcut(event) !== "new-terminal") return;
      event.preventDefault();
      // Holding the keys opens one terminal, not one per key repeat.
      if (event.repeat) return;
      const { navigate: go, workspaces: state } = latest.current;
      go("code");
      if (state.active?.available) void state.createTerminal(null);
      else if (!state.active) void state.openFolder();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}
