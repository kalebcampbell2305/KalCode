import type { LocatorEntityKind, LocatorVia } from "@kalcode/protocol";
import { useToast } from "@kalcode/ui/components";
import { useCallback, useRef } from "react";
import { toKalCodeError } from "../../../ipc/errors.ts";
import { useRuntime } from "../../../runtime/RuntimeProvider.tsx";
import { useWorkspaces } from "../../../runtime/WorkspaceProvider.tsx";
import { useThreadsIntent } from "../../../surfaces/threads/intent.tsx";
import { useNavigation, viewVisible } from "../../navigation.tsx";

/**
 * Opens what the locator found: a thread in Threads, a workspace's project page, a terminal in
 * Code, a provider in Providers. Native resolves the entry first (and records that it was
 * opened — never the query), so a stale result fails with a clear message instead of a blank page.
 */
export function useOpenLocated() {
  const { client, info } = useRuntime();
  const { navigate } = useNavigation();
  const workspaces = useWorkspaces();
  const threadsIntent = useThreadsIntent();
  const toast = useToast();
  const live = useRef({ workspaces, threadsIntent });
  live.current = { workspaces, threadsIntent };
  const folderVisible = viewVisible("folder", info.flags.features);

  return useCallback(
    async (kind: LocatorEntityKind, entityId: string, via: LocatorVia): Promise<boolean> => {
      try {
        const target = await client.locatorOpen(kind, entityId, via);
        const { workspaces, threadsIntent } = live.current;
        if (target.threadId) {
          navigate("threads");
          threadsIntent.request("open", target.threadId);
        } else if (target.terminalId && target.workspaceId) {
          const { terminalId, workspaceId } = target;
          navigate("code");
          await workspaces.refresh();
          workspaces.selectTerminal(terminalId, true, workspaceId);
        } else if (target.workspaceId) {
          if (await workspaces.activate(target.workspaceId)) navigate(folderVisible ? "folder" : "code");
        } else if (target.providerId) {
          navigate("providers");
        }
        return true;
      } catch (cause) {
        const error = toKalCodeError(cause);
        toast.show({ tone: "danger", title: "Couldn't open that", description: error.message });
        return false;
      }
    },
    [client, navigate, toast, folderVisible],
  );
}
