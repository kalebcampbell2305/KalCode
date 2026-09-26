import type { FeatureFlag } from "@kalcode/protocol";
import { useMemo } from "react";
import { createDoctorApi } from "../../ipc/doctor.ts";
import { useRuntime } from "../../runtime/RuntimeProvider.tsx";
import { useWorkspaces } from "../../runtime/WorkspaceProvider.tsx";
import { DoctorPage } from "./DoctorPage.tsx";

export function doctorAvailable(features: readonly FeatureFlag[] | undefined): boolean {
  return (
    features?.some(
      (feature) => feature.id === "environment_doctor" && feature.visible && feature.state === "available",
    ) ?? false
  );
}

/** Settings surface for the canonical native Doctor. Gated builds expose no dead controls. */
export function DoctorSettings() {
  const { client, info } = useRuntime();
  const { active } = useWorkspaces();
  const available = doctorAvailable(info.flags.features);
  const api = useMemo(() => createDoctorApi((command, args) => client.transport.invoke(command, args)), [client]);

  if (!available) return null;
  return <DoctorPage api={api} workspaceId={active?.id} />;
}
