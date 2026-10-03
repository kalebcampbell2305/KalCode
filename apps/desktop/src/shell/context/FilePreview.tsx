import type { FileRef } from "@kalcode/protocol";
import { IconButton, Skeleton } from "@kalcode/ui/components";
import { X } from "lucide-react";
import { Dialog } from "radix-ui";
import { useEffect, useRef, useState } from "react";
import { toKalCodeError } from "../../ipc/errors.ts";
import { useRuntime } from "../../runtime/RuntimeProvider.tsx";
import { ContentContextMenu } from "./ContentContextMenu.tsx";
import styles from "./FilePreview.module.css";

export function FilePreview({
  file,
  onClose,
  returnFocus,
}: {
  file: FileRef;
  onClose: () => void;
  returnFocus?: HTMLElement | null;
}) {
  const { client } = useRuntime();
  const [result, setResult] = useState<{ text: string; truncated: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const movingToAgent = useRef(false);
  useEffect(() => {
    let live = true;
    setResult(null);
    setError(null);
    client
      .readWorkspaceFile(file.workspaceId, file.handle)
      .then((value) => {
        if (live) setResult(value);
      })
      .catch((cause) => {
        if (live) setError(toKalCodeError(cause).message);
      });
    return () => {
      live = false;
    };
  }, [client, file]);
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className={styles.overlay} />
        <Dialog.Content
          className={styles.dialog}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            if (!movingToAgent.current && returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
          }}
        >
          <header className={styles.header}>
            <div>
              <Dialog.Title className={styles.title}>{file.displayPath}</Dialog.Title>
              <Dialog.Description className={styles.description}>File preview · Read only</Dialog.Description>
            </div>
            <Dialog.Close asChild>
              <IconButton label="Close file preview" icon={<X />} />
            </Dialog.Close>
          </header>
          {error ? (
            <p role="alert" className={styles.note}>
              {error}
            </p>
          ) : result ? (
            <>
              <ContentContextMenu
                workspaceId={file.workspaceId}
                context={{ kind: "file", label: file.displayPath, path: file.displayPath, text: result.text }}
                onAgentSelect={() => {
                  movingToAgent.current = true;
                  onClose();
                }}
              >
                <section className={styles.content} aria-label={`Contents of ${file.displayPath}`}>
                  <pre>{result.text || "Empty file"}</pre>
                </section>
              </ContentContextMenu>
              {result.truncated ? (
                <p className={styles.note}>Preview truncated. The full file remains available to your agent.</p>
              ) : null}
            </>
          ) : (
            <div className={styles.loading} role="status" aria-label="Loading file" aria-busy="true">
              <Skeleton width="75%" />
              <Skeleton width="55%" />
            </div>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
