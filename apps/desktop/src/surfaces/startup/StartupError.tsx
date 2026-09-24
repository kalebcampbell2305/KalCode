import type { AppInfo, IpcError } from "@kalcode/protocol";
import { Button, ErrorState } from "@kalcode/ui/components";
import { FolderOpen } from "lucide-react";
import { useState } from "react";
import type { KalCodeClient } from "../../ipc/client.ts";
import { Wordmark } from "../../shell/Brand.tsx";
import styles from "./Startup.module.css";

interface StartupErrorProps {
  client: KalCodeClient | null;
  info: AppInfo | null;
  error: IpcError;
}

/** Shown when the native runtime could not start. Explains what is safe and what to do. */
export function StartupError({ client, info, error }: StartupErrorProps) {
  const [openError, setOpenError] = useState<string | null>(null);

  const openDataFolder = async () => {
    if (!client) return;
    try {
      setOpenError(null);
      await client.openDataFolder();
    } catch (err) {
      setOpenError(err instanceof Error ? err.message : "Your system couldn't open that folder.");
    }
  };

  return (
    <main className={styles.screen}>
      <div className={styles.panel}>
        <Wordmark className={styles.wordmark} />
        <ErrorState
          title="KalCode couldn't start"
          code={`${error.category}/${error.code}`}
          actions={
            client ? (
              <Button icon={<FolderOpen />} onClick={openDataFolder}>
                Open data folder
              </Button>
            ) : null
          }
        >
          <p>{error.message}</p>
          <p>Nothing was deleted or changed. Close KalCode, resolve the issue, then open KalCode again.</p>
          {openError ? <p role="alert">{openError}</p> : null}
        </ErrorState>
        {info ? (
          <p className={styles.meta}>
            KalCode {info.version} ({info.channel})
          </p>
        ) : null}
      </div>
    </main>
  );
}
