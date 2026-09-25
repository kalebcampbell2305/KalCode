import type { PaneContent } from "@kalcode/protocol";
import { useCallback } from "react";
import { useWorkspaces } from "../../runtime/WorkspaceProvider.tsx";
import { useNavigation } from "../navigation.tsx";
import { dispatchPaneCommand, type PaneCommandResult } from "./paneCommands.ts";

export interface OpenInPaneOptions {
  /** The workspace the content belongs to (activated first when it isn't the active one). */
  workspaceId?: string | null;
  /** A new pane beside the focused one instead of a tab in it. */
  placement?: "tab" | "split";
}

/**
 * Opens content in the Code canvas and focuses its pane (the Dashboard's "card → pane focus",
 * notifications, search results): switches to the content's workspace when needed, navigates to
 * Code, and runs once that workspace's canvas is on screen. A thread that isn't a provider pane
 * opens in Threads instead (the canvas decides).
 */
export function useOpenInPane(): (content: PaneContent, options?: OpenInPaneOptions) => Promise<PaneCommandResult> {
  const { navigate } = useNavigation();
  const { active, activate } = useWorkspaces();
  const activeId = active?.id ?? null;
  return useCallback(
    async (content, options = {}) => {
      const target = options.workspaceId ?? activeId;
      if (target && target !== activeId && !(await activate(target))) {
        return { handled: false, message: "KalCode couldn't open that workspace." };
      }
      navigate("code");
      return dispatchPaneCommand(
        { kind: "open", content, ...(options.placement ? { placement: options.placement } : {}) },
        { queue: true, scope: target },
      );
    },
    [activeId, activate, navigate],
  );
}
