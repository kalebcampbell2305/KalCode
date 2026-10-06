import type { PaneInfo, ProviderAccount, ThreadSummary } from "@kalcode/protocol";
import { ObjectContextMenu, type ObjectMenuItem, useToast } from "@kalcode/ui/components";
import { Copy, Focus, Globe, PenLine, Square, UserRoundCog, X } from "lucide-react";
import { cloneElement, type HTMLAttributes, type ReactElement, useEffect, useMemo, useRef, useState } from "react";
import { toKalCodeError } from "../../ipc/errors.ts";
import { useRuntime } from "../../runtime/RuntimeProvider.tsx";
import { useUiIntents } from "../../runtime/uiIntents.tsx";
import { useWorkspaces } from "../../runtime/WorkspaceProvider.tsx";
import { useFavoriteMenuItems } from "../../shell/favorites/FavoriteActions.tsx";
import { contentKey, parseLayout, removeContents } from "../../shell/panes/model.ts";
import { dispatchPaneCommand } from "../../shell/panes/paneCommands.ts";
import { accountName } from "../providers/accountIdentity.ts";
import { useOptionalProviderAccountSessions } from "../providers/ProviderAccountSessions.tsx";
import { RebindThreadDialog } from "../threads/RebindThreadDialog.tsx";
import { rebindBlocker } from "../threads/useThreadAccount.ts";
import { announceClosedPane } from "./kaltidy/closedPanes.ts";
import { canStopPane, duplicatePaneInput, paneRebindAccounts } from "./paneContextActions.ts";
import { PaneChannel } from "./panes/paneChannel.ts";
import { RenamePaneDialog } from "./RenamePaneDialog.tsx";

/** The same coding-session actions for rail and Fleet objects outside their terminal canvas. */
export function CodingAgentContextMenu({
  thread,
  children,
  onChanged,
}: {
  thread: ThreadSummary;
  children: ReactElement;
  onChanged?: (thread: ThreadSummary) => void;
}) {
  const { client } = useRuntime();
  const intents = useUiIntents();
  const { active, workspaces } = useWorkspaces();
  const sessions = useOptionalProviderAccountSessions();
  const toast = useToast();
  const channel = useMemo(() => new PaneChannel(client), [client]);
  const [info, setInfo] = useState<PaneInfo | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [rebind, setRebind] = useState<ProviderAccount | null>(null);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const invoker = useRef<HTMLElement | null>(null);
  const child = children as ReactElement<HTMLAttributes<HTMLElement>>;
  const trigger = cloneElement(child, {
    onContextMenuCapture: (event) => {
      invoker.current = event.currentTarget;
      child.props.onContextMenuCapture?.(event);
    },
    onKeyDownCapture: (event) => {
      if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) invoker.current = event.currentTarget;
      child.props.onKeyDownCapture?.(event);
    },
  });
  const [local, setLocal] = useState(thread);
  useEffect(() => setLocal(thread), [thread]);
  useEffect(() => {
    void thread.status;
    let live = true;
    setInfo(null);
    void channel
      .info(thread.id)
      .then((next) => {
        if (live) setInfo(next);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [channel, thread.id, thread.status]);
  const changed = (next: ThreadSummary) => {
    setLocal(next);
    onChanged?.(next);
  };
  const run = (title: string, action: () => Promise<void>) => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    toast.show({ tone: "info", title });
    void action()
      .catch((cause) => toast.show({ tone: "danger", title, description: toKalCodeError(cause).message }))
      .finally(() => {
        pending.current = false;
        setBusy(false);
      });
  };
  // An agent is a real coding terminal: the explicit agent intent always lands on its Code pane and
  // never falls back to Threads (the thread intent does when its metadata read fails).
  const focus = () => intents.focus({ kind: "agent", agentId: local.id, workspaceId: local.workspaceId });
  const items: ObjectMenuItem[] = useFavoriteMenuItems(
    { kind: "agent", id: local.id, workspaceId: local.workspaceId },
    local.name,
  );
  const workspace = workspaces.find((item) => item.id === local.workspaceId);
  if (workspace?.available) {
    items.push({
      id: "browser",
      label: "Open Browser beside",
      icon: <Globe />,
      onSelect: () =>
        run("Opening Browser beside agent", async () => {
          await focus();
          dispatchPaneCommand(
            { kind: "agent-browser-beside", threadId: local.id },
            {
              scope: local.workspaceId,
              queue: true,
              onResult: (result) => {
                if (!result.handled)
                  toast.show({ tone: "danger", title: "Couldn't open Browser", description: result.message });
              },
            },
          );
        }),
    });
    const input = duplicatePaneInput(local);
    if (input)
      items.push({
        id: "duplicate",
        label: "Duplicate agent",
        icon: <Copy />,
        onSelect: () =>
          run("Duplicating agent", async () => {
            const created = await channel.create(input);
            await intents.focus({ kind: "agent", agentId: created.id, workspaceId: created.workspaceId });
          }),
      });
  }
  items.push({ id: "rename", label: "Rename", icon: <PenLine />, onSelect: () => setRenaming(true) });
  const accounts = paneRebindAccounts(local, info, sessions?.accounts ?? []);
  if (accounts.length)
    items.push({
      id: "account",
      label: "Change account",
      icon: <UserRoundCog />,
      children: accounts.map((account) => ({
        id: account.id,
        label: accountName(account),
        onSelect: () => setRebind(account),
      })),
    });
  if (workspace?.available)
    items.push({ id: "focus", label: "Focus", icon: <Focus />, onSelect: () => run("Focusing agent", focus) });
  items.push({ id: "destructive", separator: true });
  if (canStopPane(local, info))
    items.push({
      id: "stop",
      label: "Stop agent",
      icon: <Square />,
      tone: "danger",
      onSelect: () =>
        run("Stopping agent", async () => {
          changed(await client.stopThread(local.id));
          setInfo(await channel.info(local.id));
        }),
    });
  items.push({
    id: "close",
    label: "Close agent",
    icon: <X />,
    tone: "danger",
    onSelect: () =>
      run("Closing agent", async () => {
        changed(await client.stopThread(local.id));
        if (active?.id === local.workspaceId) announceClosedPane({ kind: "agent", id: local.id });
        else {
          const stored = await client.layoutGet(local.workspaceId);
          const layout = stored ? parseLayout(stored.layout) : null;
          if (layout)
            await client.layoutSave(
              local.workspaceId,
              removeContents(layout, new Set([contentKey({ kind: "agent", agentId: local.id })])),
            );
        }
        setInfo(await channel.info(local.id));
      }),
  });
  if (local.archivedAt !== null) return children;
  return (
    <>
      <ObjectContextMenu label={`${local.name} actions`} items={items}>
        {trigger}
      </ObjectContextMenu>
      {renaming ? (
        <RenamePaneDialog
          name={local.name}
          returnFocus={() => invoker.current?.focus()}
          kind="agent"
          onClose={() => setRenaming(false)}
          onSave={async (name) => changed(await client.renameThread(local.id, name))}
        />
      ) : null}
      {rebind ? (
        <RebindThreadDialog
          objectKind="agent"
          returnFocus={() => invoker.current?.focus()}
          open
          from={local.accountLabel ?? "Default account"}
          to={accountName(rebind)}
          busy={busy}
          blocker={!info || info.running ? "Stop this coding agent before changing its account." : rebindBlocker(local)}
          signInRequired={false}
          onSignIn={() => {}}
          onCancel={() => setRebind(null)}
          onConfirm={() =>
            run("Changing agent account", async () => {
              changed(await client.rebindThreadAccount(local.id, rebind.id));
              setRebind(null);
            })
          }
        />
      ) : null}
    </>
  );
}
