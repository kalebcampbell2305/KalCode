import type { LocatorEntityKind, LocatorVia } from "@kalcode/protocol";
import { useToast } from "@kalcode/ui/components";
import { useCallback, useEffect, useRef } from "react";
import { toKalCodeError } from "../../../ipc/errors.ts";
import { useRuntime } from "../../../runtime/RuntimeProvider.tsx";
import { useUiIntents } from "../../../runtime/uiIntents.tsx";
import { useOpenInPane } from "../../panes/useOpenInPane.ts";

/**
 * Opens what the locator found. Threads, workspaces and providers go through the shared focus
 * intent (Z7-W3 `useUiIntents`), so the pane system can show them where they live; terminals open
 * in their pane (Z7-W1 `useOpenInPane`). Native resolves the entry first (and records that it was opened — never the
 * query), so a stale result fails with a clear message instead of a blank page.
 */
export function useOpenLocated() {
  const { client } = useRuntime();
  const intents = useUiIntents();
  const openInPane = useOpenInPane();
  const toast = useToast();
  const live = useRef({ client, intents, openInPane });
  live.current = { client, intents, openInPane };
  const generation = useRef(0);
  useEffect(
    () => () => {
      generation.current += 1;
    },
    [],
  );

  return useCallback(
    async (kind: LocatorEntityKind, entityId: string, via: LocatorVia): Promise<boolean> => {
      if (client !== live.current.client) return false;
      const request = ++generation.current;
      const isCurrent = () => request === generation.current && client === live.current.client;
      try {
        const target = await client.locatorOpen(kind, entityId, via);
        if (!isCurrent()) return false;
        const { intents, openInPane } = live.current;
        if (target.threadId) {
          await intents.focus({ kind: "thread", threadId: target.threadId, workspaceId: target.workspaceId });
        } else if (target.terminalId && target.workspaceId) {
          const result = await openInPane(
            { kind: "terminal", terminalId: target.terminalId },
            { workspaceId: target.workspaceId },
          );
          if (!isCurrent()) return false;
          if (!result.handled && result.message) {
            toast.show({ tone: "danger", title: "Couldn't open that", description: result.message });
            return false;
          }
        } else if (target.workspaceId) {
          await intents.focus({ kind: "workspace", workspaceId: target.workspaceId });
        } else if (target.providerId) {
          await intents.focus({ kind: "provider", providerId: target.providerId });
        }
        return isCurrent();
      } catch (cause) {
        if (!isCurrent()) return false;
        const error = toKalCodeError(cause);
        toast.show({ tone: "danger", title: "Couldn't open that", description: error.message });
        return false;
      }
    },
    [client, toast],
  );
}
