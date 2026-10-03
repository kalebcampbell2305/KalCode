import { IconButton, Tooltip, useToast } from "@kalcode/ui/components";
import { ImagePlus, LoaderCircle } from "lucide-react";
import { useEffect, useRef, useSyncExternalStore } from "react";
import styles from "./TerminalImageButton.module.css";
import {
  attachTerminalImage,
  focusTerminalImageTarget,
  subscribeTerminalImageState,
  type TerminalImageTargetKey,
  terminalImageState,
} from "./terminalImages.ts";

export function TerminalImageButton({
  targetKey,
  label = "Attach image",
}: {
  targetKey: TerminalImageTargetKey;
  label?: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const toast = useToast();
  const state = useSyncExternalStore(
    (listener) => subscribeTerminalImageState(targetKey, listener),
    () => terminalImageState(targetKey),
    () => terminalImageState(targetKey),
  );
  const shownErrorRevision = useRef(0);

  useEffect(() => {
    shownErrorRevision.current = 0;
    const input = inputRef.current;
    if (!input) return;
    const restoreFocus = () => focusTerminalImageTarget(targetKey);
    input.addEventListener("cancel", restoreFocus);
    return () => input.removeEventListener("cancel", restoreFocus);
  }, [targetKey]);

  useEffect(() => {
    if (!state.error || state.revision === shownErrorRevision.current) return;
    shownErrorRevision.current = state.revision;
    toast.show({ tone: "danger", title: "Couldn't attach image", description: state.error });
  }, [state.error, state.revision, toast]);

  const tooltip = state.error
    ? state.error
    : state.busy
      ? "Attaching image…"
      : state.available
        ? "Attach an image"
        : "Terminal is still connecting";

  return (
    <span className={styles.root} aria-busy={state.busy || undefined}>
      <input
        ref={inputRef}
        className={styles.input}
        type="file"
        tabIndex={-1}
        aria-hidden="true"
        accept="image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp"
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = "";
          if (file) void attachTerminalImage(targetKey, file);
          else focusTerminalImageTarget(targetKey);
        }}
      />
      <Tooltip content={tooltip}>
        <IconButton
          size="sm"
          label={label}
          icon={state.busy ? <LoaderCircle className={styles.spin} /> : <ImagePlus />}
          disabled={!state.available || state.busy}
          onClick={() => inputRef.current?.click()}
        />
      </Tooltip>
    </span>
  );
}
