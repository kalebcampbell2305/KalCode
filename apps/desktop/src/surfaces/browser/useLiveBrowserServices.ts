import type { DevelopmentService, OperationEnvironment } from "@kalcode/protocol";
import { useMemo } from "react";
import {
  deliverToProviderThread,
  dictationTargetForProviderThread,
  waitForProviderThreadTarget,
} from "../../kalvoice/dictation.ts";
import { useOptionalRuntime } from "../../runtime/RuntimeProvider.tsx";
import { useOptionalUiIntents } from "../../runtime/uiIntents.tsx";
import { useOptionalDeckData } from "../../shell/deck/DeckData.tsx";
import { askableAgents, type LiveBrowserAgent } from "./liveBrowser.ts";

/** What Live Browser reads from the rest of KalCode. Every part is optional (isolated panes). */
export interface LiveBrowserServices {
  /** The shared Operations snapshot: dev servers (Local) and environments (Preview/Production). */
  snapshot: { services: readonly DevelopmentService[]; environments: readonly OperationEnvironment[] } | null;
  /** Live coding agents of the workspace, most recently active first. */
  listAgents(): Promise<LiveBrowserAgent[]>;
  /**
   * Sends one prompt to a coding agent's terminal through the canonical provider-pane input path
   * (the one KalVoice uses): its native instance and readiness guards apply unchanged. Opens the
   * agent's pane first when it isn't mounted.
   */
  ask(agent: LiveBrowserAgent, prompt: string, signal?: AbortSignal): Promise<void>;
}

export function useLiveBrowserServices(workspaceId: string): LiveBrowserServices {
  const runtime = useOptionalRuntime();
  const deck = useOptionalDeckData();
  const intents = useOptionalUiIntents();
  const client = runtime?.client ?? null;
  const operations = deck?.operations.data ?? null;
  return useMemo<LiveBrowserServices>(
    () => ({
      snapshot: operations ? { services: operations.services, environments: operations.environments } : null,
      listAgents: async () => (client ? askableAgents(await client.listThreads({ workspaceId }), workspaceId) : []),
      ask: async (agent, prompt, signal) => {
        if (!dictationTargetForProviderThread(agent.threadId)) {
          if (!intents) throw new Error("Open the agent's pane in Code, then ask again.");
          await intents.focus({ kind: "agent", agentId: agent.threadId, workspaceId });
          // Focusing opens the agent's pane on a later render; its terminal registers then.
          const target = await waitForProviderThreadTarget(agent.threadId, signal);
          if (!target) throw new Error(`${agent.name} isn't open in Code right now.`);
        }
        await deliverToProviderThread(agent.threadId, prompt, { mode: "send", signal });
      },
    }),
    [client, operations, intents, workspaceId],
  );
}
