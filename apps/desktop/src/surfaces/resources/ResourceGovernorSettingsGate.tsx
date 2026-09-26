import type { FeatureFlag } from "@kalcode/protocol";
import { useRuntime } from "../../runtime/RuntimeProvider.tsx";
import { ResourceGovernorSettings } from "./ResourceGovernorSettings.tsx";

export function resourceGovernorAvailable(features: readonly FeatureFlag[] | undefined): boolean {
  return (
    features?.some(
      (feature) => feature.id === "resource_governor" && feature.visible && feature.state === "available",
    ) ?? false
  );
}

/** Hides staged resource controls until canonical admission enforcement is fully activated. */
export function ResourceGovernorSettingsGate() {
  const { info } = useRuntime();
  return resourceGovernorAvailable(info.flags.features) ? <ResourceGovernorSettings /> : null;
}
