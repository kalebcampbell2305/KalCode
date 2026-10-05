import type { ThreadSummary } from "@kalcode/protocol";
import { createContext, type ReactElement, type ReactNode, useContext, useEffect, useState } from "react";
import { useEvents, useRuntime } from "../../runtime/RuntimeProvider.tsx";
import { CodingAgentContextMenu } from "../../surfaces/code/CodingAgentContextMenu.tsx";
import { isCodingAgent } from "../../surfaces/dashboard/data/agents.ts";
import { ThreadContextMenu, ThreadMenuDataProvider } from "../../surfaces/threads/ThreadContextMenu.tsx";
import { FavoriteButton } from "../favorites/FavoriteActions.tsx";
import { useRail } from "./RailProvider.tsx";

const Summaries = createContext<ReadonlyMap<string, ThreadSummary>>(new Map());

export function RailThreadFavoriteButton({ id }: { id: string }) {
  const thread = useContext(Summaries).get(id);
  return thread ? (
    <FavoriteButton
      target={{ kind: isCodingAgent(thread) ? "agent" : "thread", id, workspaceId: thread.workspaceId }}
      title={thread.name}
    />
  ) : null;
}

/** Rail projections omit account/runtime identity; read authoritative records once for the tree. */
export function RailThreadMenus({ children }: { children: ReactNode }) {
  const { client } = useRuntime();
  const { events } = useEvents();
  const [snapshot, setSnapshot] = useState<{
    client: typeof client;
    threads: ReadonlyMap<string, ThreadSummary>;
  } | null>(null);
  const revision = events.find((event) => event.type.startsWith("thread."))?.seq;
  // biome-ignore lint/correctness/useExhaustiveDependencies: a thread event invalidates this projection.
  useEffect(() => {
    let current = true;
    void client
      .listThreads({ includeArchived: true })
      .then((threads) => {
        if (current) setSnapshot({ client, threads: new Map(threads.map((thread) => [thread.id, thread])) });
      })
      .catch(() => {
        if (current) setSnapshot(null);
      });
    return () => {
      current = false;
    };
  }, [client, revision]);
  return (
    <Summaries.Provider value={snapshot?.client === client ? snapshot.threads : new Map()}>
      <ThreadMenuDataProvider>{children}</ThreadMenuDataProvider>
    </Summaries.Provider>
  );
}

export function RailThreadContextMenu({ id, children }: { id: string; children: ReactElement }) {
  const thread = useContext(Summaries).get(id);
  const rail = useRail();
  if (!thread) return children;
  if (isCodingAgent(thread))
    return (
      <CodingAgentContextMenu thread={thread} onChanged={() => void rail.refresh()}>
        {children}
      </CodingAgentContextMenu>
    );
  return (
    <ThreadContextMenu
      thread={thread}
      onChanged={() => void rail.refresh()}
      onDuplicated={(copy) => rail.openThread(copy.id, copy.workspaceId)}
    >
      {children}
    </ThreadContextMenu>
  );
}
