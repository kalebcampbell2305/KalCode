import type { SecureStoreCheck } from "@kalcode/protocol";
import { useToast } from "@kalcode/ui/components";
import { useCallback, useState } from "react";
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
  const [checking, setChecking] = useState(false);

  const copyReport = useCallback(async () => {
    try {
      const report = await buildDiagnosticReport(() => client.getDiagnostics());
      await navigator.clipboard.writeText(report);
      toast.show({
        tone: "success",
        title: "Diagnostic report copied",
        description: "Paste it into a support request.",
      });
    } catch (error) {
      toast.show({
        tone: "danger",
        title: "Couldn't copy the diagnostic report",
        description: toKalCodeError(error).message,
      });
    }
  }, [client, toast]);

  const openLogs = useCallback(async () => {
    try {
      await client.openLogFolder();
    } catch (error) {
      toast.show({
        tone: "danger",
        title: "Couldn't open the logs folder",
        description: toKalCodeError(error).message,
      });
    }
  }, [client, toast]);

  const checkSecureStore = useCallback(async (): Promise<SecureStoreCheck | null> => {
    setChecking(true);
    try {
      const result = await client.checkSecureStore();
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
      toast.show({
        tone: "danger",
        title: "Couldn't run the credential store check",
        description: toKalCodeError(error).message,
      });
      return null;
    } finally {
      setChecking(false);
    }
  }, [client, toast]);

  return { copyReport, openLogs, checkSecureStore, checking };
}
