import type { PaneContent } from "@kalcode/protocol";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { useRuntime } from "../../runtime/RuntimeProvider.tsx";
import { useWorkspaces } from "../../runtime/WorkspaceProvider.tsx";
import { useNavigation } from "../navigation.tsx";
import { dispatchPaneCommand, type PaneCommandResult } from "./paneCommands.ts";

export interface OpenInPaneOptions {
  /** The workspace the content belongs to (activation is confirmed before opening). */
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
  const { client } = useRuntime();
  const { navigate } = useNavigation();
  const { active, activate } = useWorkspaces();
  const activeId = active?.id ?? null;
  const lifetime = useMemo(() => ({ client, mounted: false, epoch: 0, request: 0 }), [client]);
  const live = useRef(lifetime);
  live.current = lifetime;
  useEffect(() => {
    lifetime.mounted = true;
    lifetime.epoch += 1;
    return () => {
      lifetime.mounted = false;
    };
  }, [lifetime]);
  return useCallback(
    async (content, options = {}) => {
      // Silent cancellation: an obsolete open must not navigate or raise an old error.
      const cancelled = { handled: false, message: "" } as const;
      if (live.current !== lifetime || !lifetime.mounted) return cancelled;
      const epoch = lifetime.epoch;
      const request = ++lifetime.request;
      const isCurrent = () =>
        live.current === lifetime && lifetime.mounted && lifetime.epoch === epoch && lifetime.request === request;
      const target = options.workspaceId ?? activeId;
      // The displayed workspace can have an older switch pending; submit this intent too.
      let activated: boolean;
      try {
        activated = target ? await activate(target) : true;
      } catch (error) {
        if (!isCurrent()) return cancelled;
        throw error;
      }
      if (!isCurrent()) return cancelled;
      if (!activated) {
        return { handled: false, message: "KalCode couldn't open that workspace." };
      }
      navigate("code");
      return dispatchPaneCommand(
        { kind: "open", content, ...(options.placement ? { placement: options.placement } : {}) },
        { queue: true, scope: target },
      );
    },
    [activeId, activate, navigate, lifetime],
  );
}
