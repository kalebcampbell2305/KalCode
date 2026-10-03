import type { WorkspaceRailEntry } from "@kalcode/protocol";
import { ObjectContextMenu, type ObjectMenuItem, useToast } from "@kalcode/ui/components";
import {
  Archive,
  ArchiveRestore,
  ArrowDown,
  ArrowUp,
  Code2,
  FolderInput,
  FolderMinus,
  FolderOpen,
  FolderPlus,
  Globe,
  PanelRight,
  Pin,
  PinOff,
  Rocket,
  Settings2,
  Trash2,
} from "lucide-react";
import { type ReactElement, useRef } from "react";
import { toKalCodeError } from "../../ipc/errors.ts";
import { OperationsClient } from "../../ipc/operations.ts";
import { useRuntime } from "../../runtime/RuntimeProvider.tsx";
import { useWorkspaces } from "../../runtime/WorkspaceProvider.tsx";
import { browserContent } from "../../surfaces/browser/browserModel.ts";
import { useDeckData } from "../deck/DeckData.tsx";
import { useNavigation } from "../navigation.tsx";
import { activateAndDispatchPaneCommand } from "../panes/paneCommands.ts";
import { useOpenInPane } from "../panes/useOpenInPane.ts";
import type { RailNode } from "./model.ts";
import { PROJECT_WIDGET } from "./paneIds.ts";
import { useRail } from "./RailProvider.tsx";
import type { RailDialog } from "./RailTree.tsx";
import { workspaceDeployments } from "./workspaceOperations.ts";

const REVEAL_LABEL =
  typeof navigator !== "undefined" && /Mac/.test(navigator.platform) ? "Reveal in Finder" : "Show in File Explorer";

export function WorkspaceContextMenu({
  entry,
  node,
  onDialog,
  children,
}: {
  entry: WorkspaceRailEntry;
  node?: Extract<RailNode, { kind: "workspace" }>;
  onDialog: (dialog: RailDialog) => void;
  children: ReactElement;
}) {
  const rail = useRail();
  const { activate } = useWorkspaces();
  const { navigate } = useNavigation();
  const { client, info } = useRuntime();
  const { operations } = useDeckData();
  const openInPane = useOpenInPane();
  const toast = useToast();
  const pending = useRef(new Set<string>());
  const action = (key: string, title: string, run: () => Promise<unknown>) => {
    if (pending.current.has(key)) return;
    pending.current.add(key);
    toast.show({ title });
    void run()
      .catch((error: unknown) =>
        toast.show({ tone: "danger", title: "Action couldn't complete", description: toKalCodeError(error).message }),
      )
      .finally(() => pending.current.delete(key));
  };
  const reportPane = (result: { handled: boolean; message?: string }) => {
    if (!result.handled && result.message) toast.show({ tone: "danger", title: result.message });
  };
  const agentEnabled = info.flags.features?.some(
    (flag) => flag.id === "provider_panes" && flag.visible && flag.state !== "gated",
  );
  const items: ObjectMenuItem[] = [];
  if (entry.available) {
    if (agentEnabled)
      items.push({
        id: "new-agent",
        label: "New coding agent…",
        icon: <Code2 />,
        onSelect: () =>
          action("agent", `Opening agent launcher in ${entry.name}`, () =>
            activateAndDispatchPaneCommand(
              entry.workspaceId,
              { kind: "open-agent-launcher" },
              activate,
              () => navigate("code"),
              reportPane,
            ),
          ),
      });
    items.push({
      id: "browser",
      label: "Open Browser",
      icon: <Globe />,
      onSelect: () =>
        action("browser", `Opening Browser in ${entry.name}`, async () =>
          reportPane(await openInPane(browserContent(), { workspaceId: entry.workspaceId })),
        ),
    });
    const runs = operations.failed ? [] : workspaceDeployments(operations.data, entry.workspaceId);
    if (runs.length)
      items.push({
        id: "deploy",
        label: "Deploy / release",
        icon: <Rocket />,
        children: runs.map((run) => ({
          id: run.id,
          label: `${run.spec.name} · ${run.spec.environment}`,
          onSelect: () =>
            action(run.id, `Starting ${run.spec.name}`, () =>
              new OperationsClient((command, args) => client.transport.invoke(command, args)).runNow(run.id),
            ),
        })),
      });
  }
  if (!entry.archived)
    items.push({
      id: "pin",
      label: entry.pinned ? "Unpin" : "Pin",
      icon: entry.pinned ? <PinOff /> : <Pin />,
      onSelect: () => void rail.update({ workspaceId: entry.workspaceId, pinned: !entry.pinned }),
    });
  items.push({
    id: "settings",
    label: "Workspace settings…",
    icon: <Settings2 />,
    onSelect: () => onDialog({ kind: "settings", entry }),
  });
  const organize: ObjectMenuItem[] = [];
  const canMove = node?.siblings === "pinned" || node?.siblings === "group";
  if (node && canMove && node.index > 0)
    organize.push({
      id: "up",
      label: "Move up",
      icon: <ArrowUp />,
      onSelect: () => void rail.update({ workspaceId: entry.workspaceId, position: node.index - 1 }),
    });
  if (node && canMove && node.index < node.siblingCount - 1)
    organize.push({
      id: "down",
      label: "Move down",
      icon: <ArrowDown />,
      onSelect: () => void rail.update({ workspaceId: entry.workspaceId, position: node.index + 1 }),
    });
  organize.push({ id: "rename", label: "Rename in rail…", onSelect: () => onDialog({ kind: "rename", entry }) });
  if (!entry.pinned && !entry.archived) {
    for (const { group } of rail.rail?.groups ?? [])
      if (group.id !== entry.groupId)
        organize.push({
          id: group.id,
          label: `Move to ${group.name}`,
          icon: <FolderInput />,
          onSelect: () => void rail.update({ workspaceId: entry.workspaceId, groupId: group.id }),
        });
    if (entry.groupId)
      organize.push({
        id: "ungroup",
        label: "Take out of folder",
        icon: <FolderMinus />,
        onSelect: () => void rail.update({ workspaceId: entry.workspaceId, groupId: "" }),
      });
    organize.push({
      id: "new-group",
      label: "New folder with this workspace…",
      icon: <FolderPlus />,
      onSelect: () => onDialog({ kind: "new-group", forWorkspace: entry }),
    });
  }
  items.push({ id: "organize", label: "Organize", icon: <FolderInput />, children: organize });
  if (entry.available)
    items.push({
      id: "open",
      label: "Open",
      icon: <FolderOpen />,
      children: [
        {
          id: "project",
          label: "Open project",
          icon: <FolderOpen />,
          onSelect: () => void rail.openWorkspace(entry.workspaceId, "project"),
        },
        {
          id: "code",
          label: "Open in Code",
          icon: <Code2 />,
          onSelect: () => void rail.openWorkspace(entry.workspaceId, "code"),
        },
        {
          id: "pane",
          label: "Open project in a pane",
          icon: <PanelRight />,
          onSelect: () =>
            action("project", `Opening ${entry.name}`, async () =>
              reportPane(
                await openInPane(
                  { kind: "widget", widgetId: PROJECT_WIDGET },
                  { workspaceId: entry.workspaceId, placement: "split" },
                ),
              ),
            ),
        },
        {
          id: "reveal",
          label: REVEAL_LABEL,
          icon: <FolderOpen />,
          onSelect: () => void rail.reveal(entry.workspaceId),
        },
      ],
    });
  items.push(
    { id: "danger", separator: true },
    {
      id: "archive",
      label: entry.archived ? "Unarchive" : "Archive",
      icon: entry.archived ? <ArchiveRestore /> : <Archive />,
      ...(entry.archived ? {} : { tone: "danger" as const }),
      onSelect: () => void rail.update({ workspaceId: entry.workspaceId, archived: !entry.archived }),
    },
    {
      id: "remove",
      label: "Remove from KalCode…",
      icon: <Trash2 />,
      tone: "danger",
      onSelect: () => onDialog({ kind: "remove", entry }),
    },
  );
  return (
    <ObjectContextMenu label={`${entry.name} workspace actions`} items={items}>
      {children}
    </ObjectContextMenu>
  );
}
