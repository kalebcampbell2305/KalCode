import type { SecureStoreCheck } from "@kalcode/protocol";
import { useToast } from "@kalcode/ui/components";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toKalCodeError } from "../../ipc/errors.ts";
import { useRuntime } from "../../runtime/RuntimeProvider.tsx";

/** Builds the sanitized text report copied to the clipboard. No project content or secrets. */
export async function buildDiagnosticReport(getDiagnostics: () => Promise<unknown>): Promise<string> {
  const diagnostics = await getDiagnostics();
  return [
    "KalCode diagnostic report",
    "Contains build, OS and runtime health only. No project files, prompts or credentials.",
    "",
    JSON.stringify(diagnostics, null, 2),
  ].join("\n");
}

export function useDiagnosticsActions() {
  const { client } = useRuntime();
  const toast = useToast();
  const scope = useMemo(() => ({ client, mounted: false, epoch: 0, copy: 0, check: null as symbol | null }), [client]);
  const live = useRef(scope);
  live.current = scope;
  const [checking, setChecking] = useState<symbol | null>(null);
  useEffect(() => {
    scope.mounted = true;
    scope.epoch += 1;
    return () => {
      scope.mounted = false;
      scope.check = null;
    };
  }, [scope]);
  const isCurrent = useCallback(
    (epoch: number) => live.current === scope && scope.mounted && scope.epoch === epoch,
    [scope],
  );

  const copyReport = useCallback(async () => {
    const epoch = scope.epoch;
    if (!isCurrent(epoch)) return;
    const request = ++scope.copy;
    const canCopy = () => isCurrent(epoch) && request === scope.copy;
    try {
      const report = await buildDiagnosticReport(() => client.getDiagnostics());
      if (!canCopy()) return;
      await navigator.clipboard.writeText(report);
      if (!canCopy()) return;
      toast.show({
        tone: "success",
        title: "Diagnostic report copied",
        description: "Paste it into a support request.",
      });
    } catch (error) {
      if (!canCopy()) return;
      toast.show({
        tone: "danger",
        title: "Couldn't copy the diagnostic report",
        description: toKalCodeError(error).message,
      });
    }
  }, [client, toast, scope, isCurrent]);

  const openLogs = useCallback(async () => {
    const epoch = scope.epoch;
    if (!isCurrent(epoch)) return;
    try {
      await client.openLogFolder();
    } catch (error) {
      if (!isCurrent(epoch)) return;
      toast.show({
        tone: "danger",
        title: "Couldn't open the logs folder",
        description: toKalCodeError(error).message,
      });
    }
  }, [client, toast, scope, isCurrent]);

  const checkSecureStore = useCallback(async (): Promise<SecureStoreCheck | null> => {
    const epoch = scope.epoch;
    if (!isCurrent(epoch) || scope.check !== null) return null;
    const request = Symbol();
    scope.check = request;
    setChecking(request);
    try {
      const result = await client.checkSecureStore();
      if (!isCurrent(epoch)) return null;
      toast.show(
        result.ok
          ? {
              tone: "success",
              title: "Credential store verified",
              description: `${result.backend} saved, read and removed a test entry.`,
            }
          : { tone: "danger", title: "Credential store check failed", description: result.message ?? undefined },
      );
      return result;
    } catch (error) {
      if (!isCurrent(epoch)) return null;
      toast.show({
        tone: "danger",
        title: "Couldn't run the credential store check",
        description: toKalCodeError(error).message,
      });
      return null;
    } finally {
      if (isCurrent(epoch) && scope.check === request) {
        scope.check = null;
        setChecking(null);
      }
    }
  }, [client, toast, scope, isCurrent]);

  return { copyReport, openLogs, checkSecureStore, checking: checking !== null && checking === scope.check };
}
