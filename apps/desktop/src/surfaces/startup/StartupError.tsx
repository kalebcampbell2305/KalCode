import type { AppInfo, IpcError } from "@kalcode/protocol";
import { Button, ErrorState } from "@kalcode/ui/components";
import { ClipboardCopy, FolderOpen } from "lucide-react";
import { useState } from "react";
import type { KalCodeClient } from "../../ipc/client.ts";
import { formatVersion } from "../../platform/version.ts";
import { Lockup } from "../../shell/Brand.tsx";
import styles from "./Startup.module.css";

interface StartupErrorProps {
  client: KalCodeClient | null;
  info: AppInfo | null;
  error: IpcError;
}

/** KalCode's official download page: the way to a newer KalCode when this one can't start. */
export const DOWNLOAD_URL = "https://kalcoded.com/download";

/** Shown when the native runtime could not start. Explains what is safe and what to do. */
export function StartupError({ client, info, error }: StartupErrorProps) {
  const [openError, setOpenError] = useState<string | null>(null);
  const [copied, setCopied] = useState<"copied" | "failed" | null>(null);
  // Data from a newer KalCode needs that newer KalCode. The page can't open a browser before the
  // runtime starts, so it hands over the official download link.
  const needsNewer = error.code === "schema_too_new";
  const copyDownloadLink = async () => {
    try {
      await navigator.clipboard.writeText(DOWNLOAD_URL);
      setCopied("copied");
    } catch {
      setCopied("failed");
    }
  };

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
        <Lockup className={styles.lockup} />
        <ErrorState
          headingLevel={1}
          title="KalCode couldn't start"
          code={`${error.category}/${error.code}`}
          actions={
            needsNewer || client ? (
              <>
                {needsNewer ? (
                  <Button variant="primary" icon={<ClipboardCopy />} onClick={() => void copyDownloadLink()}>
                    {copied === "copied" ? "Download link copied" : "Copy download link"}
                  </Button>
                ) : null}
                {client ? (
                  <Button icon={<FolderOpen />} onClick={openDataFolder}>
                    Open data folder
                  </Button>
                ) : null}
              </>
            ) : null
          }
        >
          <p>{error.message}</p>
          {needsNewer ? (
            <p>
              Get the latest KalCode from <code data-selectable>kalcoded.com/download</code>, install it, then open
              KalCode again.
            </p>
          ) : (
            <p>Nothing was deleted or changed. Close KalCode, resolve the issue, then open KalCode again.</p>
          )}
          {copied === "copied" ? (
            <p role="status">Paste the link into your browser to download the latest KalCode.</p>
          ) : copied === "failed" ? (
            <p role="alert">Couldn't copy the link. Type kalcoded.com/download into your browser.</p>
          ) : null}
          {openError ? <p role="alert">{openError}</p> : null}
        </ErrorState>
        {info ? (
          <p className={styles.meta}>
            KalCode {formatVersion(info.version)} ({info.channel})
          </p>
        ) : null}
      </div>
    </main>
  );
}
