import { useEffect, useRef } from "react";
import { useNavigation } from "../shell/navigation.tsx";
import { useSelectedThread } from "../surfaces/threads/accountIntent.ts";
import { useThreadsIntent } from "../surfaces/threads/intent.tsx";
import { useRuntime } from "./RuntimeProvider.tsx";
import { useWorkspaces } from "./WorkspaceProvider.tsx";

/** Runtime-specific replay. History only selects existing resources; it never launches one. */
export function NavigationBridge() {
  const { current, recordLocation, registerRestorer } = useNavigation();
  const workspaces = useWorkspaces();
  const { client } = useRuntime();
  const threads = useThreadsIntent();
  const selected = useSelectedThread();
  const live = useRef({ workspaces, client, threads });
  live.current = { workspaces, client, threads };

  useEffect(
    () =>
      registerRestorer(async (entry, isCurrent) => {
        const { workspaces, client } = live.current;
        if (entry.workspaceId) {
          if (!workspaces.workspaces.some((workspace) => workspace.id === entry.workspaceId)) return false;
          // Even the displayed workspace must supersede an older native activation
          // still in flight; checking only the rendered id would let that write win.
          if (!isCurrent() || !(await workspaces.activate(entry.workspaceId)) || !isCurrent()) return false;
        }
        if (entry.target?.kind === "thread") {
          const exists = await client
            .getThread(entry.target.threadId)
            .then((thread) => thread.archivedAt === null)
            .catch(() => false);
          if (!isCurrent() || !exists) return false;
        }
        return undefined;
      }, "prepare"),
    [registerRestorer],
  );

  useEffect(
    () =>
      registerRestorer((entry, isCurrent) => {
        if (entry.target?.kind !== "thread") return undefined;
        if (!isCurrent()) return false;
        live.current.threads.request("open", entry.target.threadId);
        return true;
      }),
    [registerRestorer],
  );

  useEffect(() => {
    if (current === "threads" && selected)
      recordLocation({
        destination: "threads",
        target: { kind: "thread", threadId: selected.threadId },
        label: "Thread",
      });
  }, [current, selected, recordLocation]);
  useEffect(() => {
    if (current === "folder" && workspaces.active)
      recordLocation({ destination: "folder", workspaceId: workspaces.active.id, label: workspaces.active.name });
  }, [current, workspaces.active, recordLocation]);
  return null;
}
