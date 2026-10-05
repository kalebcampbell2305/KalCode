import { ObjectContextMenu, type ObjectMenuItem, useToast } from "@kalcode/ui/components";
import { Bot, Copy, FileQuestion, FolderOpen, Wrench } from "lucide-react";
import { cloneElement, type HTMLAttributes, type ReactElement, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { deliverToProviderThread, waitForProviderThreadTarget } from "../../kalvoice/dictation.ts";
import { useUiIntents } from "../../runtime/uiIntents.tsx";
import { useCodingAgents } from "../../surfaces/dashboard/data/DashboardData.tsx";
import { useFavoriteMenuItems } from "../favorites/FavoriteActions.tsx";
import type { FavoriteTarget } from "../favorites/model.ts";
import {
  availableContentAgents,
  type ContentAction,
  type ContentContext,
  contentContextText,
  contentPrompt,
} from "./contentActions.ts";

/** Content remains local until the user explicitly picks an action and an agent. */
export function ContentContextMenu({
  workspaceId,
  sourceAgentId,
  context,
  getContext,
  onOpen,
  onAgentSelect,
  favoriteTarget,
  children,
}: {
  workspaceId?: string | null;
  sourceAgentId?: string;
  context: ContentContext;
  /** Capture xterm selection/the clicked line synchronously, without reading the PTY. */
  getContext?: (target: EventTarget | null, keyboard?: boolean) => ContentContext;
  onOpen?: () => void;
  onAgentSelect?: () => void;
  /** null suppresses saving a non-file target, such as a directory. */
  favoriteTarget?: FavoriteTarget | null;
  children: ReactElement;
}) {
  const { state } = useCodingAgents();
  const intents = useUiIntents();
  const toast = useToast();
  const [captured, setCaptured] = useState<ContentContext | null>(null);
  const keyboardInvocation = useRef(false);
  const selected = getContext ? (captured ?? context) : context;
  const allAgents = state.status === "ready" ? state.data : [];
  const targetWorkspace = workspaceId ?? allAgents.find((agent) => agent.id === sourceAgentId)?.workspaceId;
  const agents = availableContentAgents(allAgents, targetWorkspace);
  const report = (cause: unknown) =>
    toast.show({
      tone: "danger",
      title: "Couldn't use that context",
      description: cause instanceof Error ? cause.message : "Please try again.",
    });
  const insert = async (agentId: string, action: ContentAction) => {
    if (!targetWorkspace) return;
    const prompt = contentPrompt(selected, action);
    toast.show({ tone: "info", title: "Opening agent with context…" });
    try {
      onAgentSelect?.();
      await intents.focus({ kind: "agent", agentId, workspaceId: targetWorkspace });
      const target = await waitForProviderThreadTarget(agentId);
      if (!target) throw new Error("That agent is no longer available.");
      // Native rechecks process identity and provider approvals; insert never presses Enter.
      await deliverToProviderThread(agentId, prompt, { mode: "insert" });
      toast.show({
        tone: "success",
        title: "Context added to the agent's prompt",
        description: "Review the prompt, then send it when ready.",
      });
    } catch (cause) {
      report(cause);
    }
  };
  const actionItem = (id: ContentAction, label: string, icon: ReactElement): ObjectMenuItem =>
    agents.length > 1
      ? {
          id,
          label,
          icon,
          children: agents.map((agent) => ({
            id: `${id}-${agent.id}`,
            label: agent.name,
            onSelect: () => void insert(agent.id, id),
          })),
        }
      : {
          id,
          label,
          icon,
          onSelect: () => {
            const first = agents[0];
            if (first) void insert(first.id, id);
          },
        };
  const items: ObjectMenuItem[] = useFavoriteMenuItems(
    favoriteTarget === undefined
      ? selected.kind === "file" && selected.path && targetWorkspace
        ? { kind: "file", id: selected.path, workspaceId: targetWorkspace }
        : null
      : favoriteTarget,
    selected.label,
  );
  if (onOpen) items.push({ id: "open", label: "Open", icon: <FolderOpen />, onSelect: onOpen });
  if (agents.length > 0 && (selected.text.trim() || selected.path)) {
    items.push(actionItem("ask", "Ask Agent", <Bot />));
    if (selected.kind === "error") items.push(actionItem("fix", "Fix This", <Wrench />));
    items.push(actionItem("explain", "Explain", <FileQuestion />));
  }
  if (selected.text.trim() || selected.path) {
    if (items.length > 0) items.push({ id: "copy-separator", separator: true });
    items.push({
      id: "copy-context",
      label: "Copy relevant context",
      icon: <Copy />,
      onSelect: () => {
        void navigator.clipboard
          .writeText(contentContextText(selected))
          .then(() => toast.show({ tone: "success", title: "Context copied" }))
          .catch(report);
      },
    });
  }
  const child = children as ReactElement<HTMLAttributes<HTMLElement>>;
  return (
    <ObjectContextMenu label={`${context.label} actions`} items={items}>
      {cloneElement(child, {
        tabIndex: child.props.tabIndex ?? 0,
        onContextMenuCapture: (event) => {
          if (getContext) {
            const next = getContext(event.target, keyboardInvocation.current);
            keyboardInvocation.current = false;
            // The nested trigger must know whether to open or let the pane handle this same event.
            flushSync(() => setCaptured(next));
          }
          child.props.onContextMenuCapture?.(event);
        },
        onKeyDownCapture: (event) => {
          if (getContext && (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10"))) {
            const next = getContext(event.target, true);
            keyboardInvocation.current = Boolean(next.text.trim() || next.path);
            flushSync(() => setCaptured(next));
          }
          child.props.onKeyDownCapture?.(event);
        },
      })}
    </ObjectContextMenu>
  );
}
