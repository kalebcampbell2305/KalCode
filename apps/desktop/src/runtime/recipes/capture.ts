import type { LaunchRecipe, PaneContent, PaneNode, RecipeComponent } from "@kalcode/protocol";
import type { KalCodeClient } from "../../ipc/client.ts";
import { MAX_RECIPE_COMPONENTS, RECIPE_SCHEMA_VERSION, safeRecipeUrl } from "./model.ts";

/** Same rule as pane widget ids (shell/panes/model.ts). */
const WIDGET_ID = /^[a-z0-9][a-z0-9_.-]{0,63}$/;
const LAYOUT_BY_LEAVES: Record<number, string> = { 2: "two", 3: "three", 4: "four", 6: "six" };

function leaves(node: PaneNode): Extract<PaneNode, { kind: "leaf" }>[] {
  return node.kind === "leaf" ? [node] : node.children.flatMap(leaves);
}

/**
 * Builds a Recipe from the saved Code desk. Read-only: nothing running is touched, and session
 * ids, process ids and tokens are never copied (only provider/account/model/effort/names).
 */
export async function captureDesk(client: KalCodeClient, workspaceId: string, name: string): Promise<LaunchRecipe> {
  const saved = await client.layoutGet(workspaceId);
  const root = saved?.layout.root;
  const panes = root ? leaves(root) : [];
  const contents: PaneContent[] = panes.flatMap((pane) => pane.tabs);
  const needsTerminals = contents.some((c) => c.kind === "terminal");
  const terminals = needsTerminals ? await client.listTerminals(workspaceId).catch(() => []) : [];
  const counts: Record<string, number> = {};
  const key = (kind: string) => {
    counts[kind] = (counts[kind] ?? 0) + 1;
    return `${kind}-${counts[kind]}`;
  };
  const components: RecipeComponent[] = [];
  for (const content of contents) {
    if (components.length >= MAX_RECIPE_COMPONENTS) break;
    if (content.kind === "agent" || content.kind === "thread") {
      const id = content.kind === "agent" ? content.agentId : content.threadId;
      const thread = await client.getThread(id).catch(() => null);
      // Only real coding terminals are agents; a plain Thread isn't part of a desk.
      if (thread?.runtimeKind !== "interactive_pty") continue;
      components.push({
        kind: "agent",
        key: key("agent"),
        providerId: thread.providerId,
        providerAccountId: thread.providerAccountId,
        model: thread.model,
        effort: thread.effort,
        // An automatic task title must not become a manual name on every relaunch.
        name: null,
        task: null,
      });
    } else if (content.kind === "terminal") {
      const title = terminals.find((t) => t.id === content.terminalId)?.title;
      components.push({ kind: "terminal", key: key("terminal"), name: title || null, command: null });
    } else if (content.kind === "browser") {
      const url = content.url ? safeRecipeUrl(content.url) : null;
      if (url) components.push({ kind: "browser", key: key("browser"), url });
    } else if (content.kind === "widget" && WIDGET_ID.test(content.widgetId)) {
      components.push({ kind: "widget", key: key("widget"), widget: content.widgetId });
    }
  }
  return {
    id: crypto.randomUUID(),
    name,
    schemaVersion: RECIPE_SCHEMA_VERSION,
    workspaceId,
    pinned: false,
    position: 0,
    variables: [],
    components,
    layout: LAYOUT_BY_LEAVES[panes.length] ?? null,
    updatedAt: "",
  };
}
