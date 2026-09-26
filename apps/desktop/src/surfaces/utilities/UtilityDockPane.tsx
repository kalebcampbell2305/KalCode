import type { FeatureFlag } from "@kalcode/protocol";
import { Wrench } from "lucide-react";
import { useCallback, useEffect, useMemo } from "react";
import type { UtilityApi } from "../../ipc/utilities.ts";
import { UtilityClient } from "../../ipc/utilities.ts";
import { useRuntime } from "../../runtime/RuntimeProvider.tsx";
import { useWorkspaces } from "../../runtime/WorkspaceProvider.tsx";
import { registerPaneWidget } from "../../shell/panes/contentRegistry.ts";
import { UtilityDock } from "./UtilityDock.tsx";

export const UTILITY_DOCK_WIDGET_ID = "utility-dock";

export function utilityDockAvailable(features: readonly FeatureFlag[] | undefined): boolean {
  return (
    features?.some((feature) => feature.id === "utility_dock" && feature.visible && feature.state === "available") ??
    false
  );
}

/** Registers the Dock through the canonical pane widget registry. */
export function registerUtilityDock(api: UtilityApi, openScratchTerminal: () => void): () => void {
  return registerPaneWidget(UTILITY_DOCK_WIDGET_ID, {
    describe: () => ({
      title: "Utility Dock",
      glyph: <Wrench />,
      statusText: "Bounded local tools and governed native actions",
    }),
    render: () => <UtilityDock api={api} openScratchTerminal={openScratchTerminal} />,
  });
}

/**
 * Feature-aware registration mounted inside the Code runtime. Stable builds never advertise the
 * gated Dock; development builds register it only while the native feature flag is visible.
 */
export function UtilityDockRegistration() {
  const { client, info } = useRuntime();
  const { createTerminal } = useWorkspaces();
  const available = utilityDockAvailable(info.flags.features);
  const api = useMemo(() => new UtilityClient((command, args) => client.transport.invoke(command, args)), [client]);
  const openScratchTerminal = useCallback(() => {
    void createTerminal(null);
  }, [createTerminal]);

  useEffect(() => {
    if (!available) return;
    return registerUtilityDock(api, openScratchTerminal);
  }, [api, available, openScratchTerminal]);

  return null;
}
