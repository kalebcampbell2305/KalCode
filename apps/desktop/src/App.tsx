import type { AppInfo, IpcError, Settings } from "@kalcode/protocol";
import { ToastProvider, TooltipProvider } from "@kalcode/ui/components";
import { useEffect, useState } from "react";
import { KalCodeClient } from "./ipc/client.ts";
import { toKalCodeError } from "./ipc/errors.ts";
import { resolveTransport } from "./ipc/transport.ts";
import { RuntimeProvider } from "./runtime/RuntimeProvider.tsx";
import { applyAppearance, systemPrefersDark } from "./shell/appearance.ts";
import { Shell } from "./shell/Shell.tsx";
import { NoRuntime } from "./surfaces/startup/NoRuntime.tsx";
import { StartupError } from "./surfaces/startup/StartupError.tsx";

type BootResult =
  | { kind: "booting" }
  | { kind: "no-runtime" }
  | { kind: "failed"; client: KalCodeClient | null; info: AppInfo | null; error: IpcError }
  | { kind: "ready"; client: KalCodeClient; info: AppInfo; settings: Settings };

async function boot(): Promise<BootResult> {
  const transport = await resolveTransport();
  if (!transport) return { kind: "no-runtime" };
  const client = new KalCodeClient(transport);
  try {
    const state = await client.boot();
    if (state.startupError) return { kind: "failed", client, info: state.info, error: state.startupError };
    const settings = await client.getSettings();
    return { kind: "ready", client, info: state.info, settings };
  } catch (error) {
    return { kind: "failed", client, info: null, error: toKalCodeError(error).toIpcError() };
  }
}

export function App() {
  const [result, setResult] = useState<BootResult>({ kind: "booting" });

  useEffect(() => {
    let cancelled = false;
    boot().then((next) => {
      if (cancelled) return;
      // Apply the saved appearance before the first real render so the window never flashes
      // the wrong theme.
      if (next.kind === "ready") applyAppearance(document.documentElement, next.settings, systemPrefersDark());
      setResult(next);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Show the (initially hidden) native window only after the first meaningful paint.
  useEffect(() => {
    if (result.kind === "booting" || result.kind === "no-runtime") return;
    const client = result.client;
    if (!client) return;
    const frame = requestAnimationFrame(() => {
      void client.windowReady().catch(() => undefined);
    });
    return () => cancelAnimationFrame(frame);
  }, [result]);

  switch (result.kind) {
    case "booting":
      return <div className="boot-screen" aria-busy="true" aria-label="Starting KalCode" />;
    case "no-runtime":
      return <NoRuntime />;
    case "failed":
      return <StartupError client={result.client} info={result.info} error={result.error} />;
    case "ready":
      return (
        <ToastProvider>
          <TooltipProvider delayDuration={350}>
            <RuntimeProvider client={result.client} info={result.info} initialSettings={result.settings}>
              <Shell />
            </RuntimeProvider>
          </TooltipProvider>
        </ToastProvider>
      );
  }
}
