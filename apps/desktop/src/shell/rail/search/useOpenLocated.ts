import type { LocatorEntityKind, LocatorVia } from "@kalcode/protocol";
import { useToast } from "@kalcode/ui/components";
import { useCallback, useRef } from "react";
import { toKalCodeError } from "../../../ipc/errors.ts";
import { useRuntime } from "../../../runtime/RuntimeProvider.tsx";
import { useUiIntents } from "../../../runtime/uiIntents.tsx";
import { useWorkspaces } from "../../../runtime/WorkspaceProvider.tsx";
import { useNavigation } from "../../navigation.tsx";

/**
 * Opens what the locator found. Threads, workspaces and providers go through the shared focus
 * intent (Z7-W3 `useUiIntents`), so the pane system can show them where they live; terminals open
 * their tab in Code. Native resolves the entry first (and records that it was opened — never the
 * query), so a stale result fails with a clear message instead of a blank page.
 */
export function useOpenLocated() {
  const { client } = useRuntime();
  const { navigate } = useNavigation();
  const workspaces = useWorkspaces();
  const intents = useUiIntents();
  const toast = useToast();
  const live = useRef({ workspaces, intents });
  live.current = { workspaces, intents };

  return useCallback(
    async (kind: LocatorEntityKind, entityId: string, via: LocatorVia): Promise<boolean> => {
      try {
        const target = await client.locatorOpen(kind, entityId, via);
        const { workspaces, intents } = live.current;
        if (target.threadId) {
          await intents.focus({ kind: "thread", threadId: target.threadId, workspaceId: target.workspaceId });
        } else if (target.terminalId && target.workspaceId) {
          const { terminalId, workspaceId } = target;
          if (workspaces.active?.id !== workspaceId && !(await workspaces.activate(workspaceId))) return false;
          navigate("code");
          await workspaces.refresh();
          workspaces.selectTerminal(terminalId, true, workspaceId);
        } else if (target.workspaceId) {
          await intents.focus({ kind: "workspace", workspaceId: target.workspaceId });
        } else if (target.providerId) {
          await intents.focus({ kind: "provider", providerId: target.providerId });
        }
        return true;
      } catch (cause) {
        const error = toKalCodeError(cause);
        toast.show({ tone: "danger", title: "Couldn't open that", description: error.message });
        return false;
      }
    },
    [client, navigate, toast],
  );
}
