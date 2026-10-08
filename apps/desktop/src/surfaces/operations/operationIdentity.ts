import type { OperationRecord } from "@kalcode/protocol";
import { accountProviderName } from "../../shell/accountCommands.ts";
import { useOptionalAllThreads } from "../dashboard/data/DashboardData.tsx";
import { useSessionIdentity } from "../providers/useSessionIdentity.ts";

export type ObservedOperationRecord = OperationRecord & {
  observedProviderId?: string | null;
  observedProviderAccountId?: string | null;
  observedAccountLabel?: string | null;
  observedModel?: string | null;
  observedEffort?: string | null;
};

export function operationUsesLiveIdentity(record: OperationRecord): boolean {
  return ["starting", "running", "blocked"].includes(record.status);
}

/**
 * Resolves one Operation through the same session identity authority as agent surfaces. Live work
 * follows its current thread; every other status stays inside the run's durable observed bounds.
 */
export function useOperationIdentity(record: ObservedOperationRecord) {
  const threads = useOptionalAllThreads();
  const thread =
    operationUsesLiveIdentity(record) && record.threadId && threads
      ? (threads.find((candidate) => candidate.id === record.threadId) ?? null)
      : null;
  const providerId = record.observedProviderId ?? record.spec.providerId ?? "unknown";
  const hasObservedBinding = record.observedProviderId !== undefined && record.observedProviderId !== null;
  return useSessionIdentity(
    thread
      ? thread
      : {
          providerId,
          providerName: accountProviderName(providerId),
          providerAccountId: hasObservedBinding
            ? (record.observedProviderAccountId ?? null)
            : record.spec.providerAccountId,
          accountLabel: hasObservedBinding ? (record.observedAccountLabel ?? null) : record.accountLabel,
          model: record.spec.model,
          effort: record.spec.effort,
          activeModel: record.observedModel,
          activeEffort: record.observedEffort,
        },
  );
}
