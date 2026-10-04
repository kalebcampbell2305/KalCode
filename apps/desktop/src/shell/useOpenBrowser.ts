import { useToast } from "@kalcode/ui/components";
import { useWorkspaces } from "../runtime/WorkspaceProvider.tsx";
import { browserContent } from "../surfaces/browser/index.ts";
import { useNavigation } from "./navigation.tsx";
import { useOpenInPane } from "./panes/useOpenInPane.ts";

/** Revisit the last Browser pane in this workspace, or open its first one. */
export function useOpenBrowser() {
  const { active, openFolder } = useWorkspaces();
  const { history = [] } = useNavigation();
  const open = useOpenInPane();
  const toast = useToast();
  return async () => {
    const workspace = active ?? (await openFolder());
    if (!workspace) return;
    const previous = [...history]
      .reverse()
      .find(
        (entry) =>
          entry.workspaceId === workspace.id &&
          entry.target?.kind === "pane" &&
          entry.target.content.kind === "browser",
      );
    const content = previous?.target?.kind === "pane" ? previous.target.content : browserContent();
    try {
      const result = await open(content, { workspaceId: workspace.id });
      if (!result.handled && result.message)
        toast.show({ tone: "danger", title: "Browser couldn't open", description: result.message });
    } catch {
      toast.show({ tone: "danger", title: "Browser couldn't open", description: "Try opening the workspace again." });
    }
  };
}
