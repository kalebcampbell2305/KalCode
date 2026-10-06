import type { PaneContent } from "@kalcode/protocol";
import { Button } from "@kalcode/ui/components";
import { AlertDialog } from "radix-ui";
import { useCallback, useEffect, useRef, useState } from "react";
import { toKalCodeError } from "../../ipc/errors.ts";
import { contentKey } from "../../shell/panes/model.ts";
import styles from "./SmartClose.module.css";

interface CloseRequest {
  contents: readonly PaneContent[];
  closed: () => void;
  error: string | null;
  stopped: Set<string>;
  stop: (content: PaneContent, confirmed: boolean) => Promise<void>;
}

/** One close transaction for a whole pane. Unknown activity is always protected. */
export function useSmartClose(ports: {
  inspect: (content: PaneContent) => Promise<boolean>;
  stop: (content: PaneContent, confirmed: boolean) => Promise<void>;
}) {
  const latest = useRef(ports);
  latest.current = ports;
  const current = useRef<CloseRequest | null>(null);
  const alive = useRef(false);
  const stopping = useRef(false);
  const [pending, setPending] = useState<CloseRequest | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      current.current = null;
    };
  }, []);

  const finish = useCallback((request: CloseRequest) => {
    if (!alive.current || current.current !== request) return;
    current.current = null;
    setPending(null);
    request.closed();
  }, []);

  const stopAndClose = useCallback(
    async (confirmed = true) => {
      const request = current.current;
      if (!request || stopping.current) return;
      stopping.current = true;
      setBusy(true);
      try {
        for (const content of request.contents) {
          if (!alive.current || current.current !== request) return;
          const key = contentKey(content);
          if (request.stopped.has(key)) continue;
          await request.stop(content, confirmed);
          request.stopped.add(key);
        }
        finish(request);
      } catch (cause) {
        if (alive.current && current.current === request) {
          const error = toKalCodeError(cause);
          request.error =
            error.code === "terminal_still_running" || error.code === "agent_still_running" ? null : error.message;
          setPending({ ...request });
        }
      } finally {
        stopping.current = false;
        if (alive.current) setBusy(false);
      }
    },
    [finish],
  );

  const request = useCallback(
    async (contents: readonly PaneContent[], closed: () => void) => {
      if (current.current || !alive.current) return;
      const next = {
        contents: [...contents],
        closed,
        error: null,
        stopped: new Set<string>(),
        stop: latest.current.stop,
      };
      current.current = next;
      const active = await Promise.all(contents.map((content) => latest.current.inspect(content).catch(() => true)));
      if (!alive.current || current.current !== next) return;
      if (active.some(Boolean)) setPending(next);
      else await stopAndClose(false);
    },
    [stopAndClose],
  );

  const cancel = useCallback(() => {
    if (stopping.current) return;
    current.current = null;
    setPending(null);
  }, []);
  return { request, pending, busy, cancel, stopAndClose };
}

export function SmartCloseDialog({ close }: { close: ReturnType<typeof useSmartClose> }) {
  return (
    <AlertDialog.Root
      open={close.pending !== null}
      onOpenChange={(open) => {
        if (!open) close.cancel();
      }}
    >
      <AlertDialog.Portal>
        <AlertDialog.Overlay className={styles.overlay} />
        <AlertDialog.Content
          className={styles.dialog}
          onEscapeKeyDown={(event) => {
            if (close.busy) event.preventDefault();
          }}
        >
          <AlertDialog.Title className={styles.title}>Close active work?</AlertDialog.Title>
          <AlertDialog.Description className={styles.description}>
            A terminal or agent may still be running. Stop it and close the pane, or cancel to keep working.
          </AlertDialog.Description>
          {close.pending?.error ? (
            <p className={styles.error} role="alert">
              Couldn't close: {close.pending.error}
            </p>
          ) : null}
          <div className={styles.actions}>
            <AlertDialog.Cancel asChild>
              <Button variant="ghost" disabled={close.busy}>
                Cancel
              </Button>
            </AlertDialog.Cancel>
            <Button variant="danger" busy={close.busy} onClick={() => void close.stopAndClose()}>
              Stop and Close
            </Button>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
