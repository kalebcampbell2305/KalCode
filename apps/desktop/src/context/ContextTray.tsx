import type { ContextItemPreview, ContextPreview, FeatureFlag, ThreadSummary } from "@kalcode/protocol";
import { Button, TextArea, TextInput, useToast } from "@kalcode/ui/components";
import { FilePlus2, Link2, Paperclip, ShieldCheck, Trash2 } from "lucide-react";
import { useId, useState } from "react";
import type { ContextInput } from "../ipc/context.ts";
import { toKalCodeError } from "../ipc/errors.ts";
import { useRuntime } from "../runtime/RuntimeProvider.tsx";
import styles from "./ContextTray.module.css";

type DraftKind = "text" | "selection" | "log_output" | "url";

/** Both the sharing surface and its safety authority must be available in this build. */
export function contextDropAvailable(features: readonly FeatureFlag[] | undefined): boolean {
  const available = new Set(
    features?.filter((feature) => feature.visible && feature.state === "available").map((feature) => feature.id),
  );
  return available.has("context_drop") && available.has("context_firewall");
}

export interface ContextTrayProps {
  thread: ThreadSummary;
  preview: ContextPreview | null;
  busy: boolean;
  disabled: boolean;
  onAddInput(input: ContextInput): Promise<unknown>;
  onAddFiles(): Promise<number>;
  onSetIncluded(position: number, included: boolean): Promise<void>;
  onConfirm(position: number): Promise<void>;
  onDiscard(): Promise<void>;
}

function verdict(item: ContextItemPreview): string {
  if (item.verdict.kind === "allow_redacted")
    return `${item.verdict.spans} redaction${item.verdict.spans === 1 ? "" : "s"}`;
  if (item.verdict.kind === "block") return item.verdict.overridable ? "Needs confirmation" : "Blocked";
  return "Ready";
}

export function ContextTray({
  thread,
  preview,
  busy,
  disabled,
  onAddInput,
  onAddFiles,
  onSetIncluded,
  onConfirm,
  onDiscard,
}: ContextTrayProps) {
  const toast = useToast();
  const { info } = useRuntime();
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<DraftKind>("text");
  const [label, setLabel] = useState("Context note");
  const [value, setValue] = useState("");
  const addPanelId = useId();
  const labelInputId = useId();
  const valueInputId = useId();

  if (!contextDropAvailable(info.flags.features)) return null;

  const report = (error: unknown) => {
    toast.show({ tone: "danger", title: "Context wasn't added", description: toKalCodeError(error).message });
  };

  const addDraft = async () => {
    const trimmed = value.trim();
    if (!trimmed) return;
    try {
      if (kind === "url") await onAddInput({ kind: "url", url: trimmed });
      else await onAddInput({ kind, label: label.trim() || "Context note", text: value });
      setValue("");
      setOpen(false);
    } catch (error) {
      report(error);
    }
  };

  return (
    <section className={styles.tray} aria-label="Context drop" data-open={open || Boolean(preview) || undefined}>
      <div className={styles.toolbar}>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          icon={<Paperclip />}
          disabled={disabled || busy}
          aria-expanded={open}
          aria-controls={addPanelId}
          onClick={() => setOpen((value) => !value)}
        >
          Add context
        </Button>
        {preview ? (
          <p className={styles.summary} aria-live="polite">
            <ShieldCheck aria-hidden="true" />
            {preview.items.length} {preview.items.length === 1 ? "item" : "items"} checked for {thread.providerName}
            {thread.accountLabel ? ` · ${thread.accountLabel}` : ""}
          </p>
        ) : null}
        {preview ? (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            icon={<Trash2 />}
            disabled={busy}
            onClick={() => void onDiscard().catch(report)}
          >
            Clear
          </Button>
        ) : null}
      </div>

      {open ? (
        <div id={addPanelId} className={styles.addPanel}>
          <fieldset
            className={styles.kindRow}
            aria-label="Context source"
            style={{ border: 0, margin: 0, minInlineSize: 0, padding: 0 }}
          >
            {(["text", "selection", "log_output", "url"] as const).map((option) => (
              <Button
                key={option}
                type="button"
                size="sm"
                variant={kind === option ? "secondary" : "ghost"}
                disabled={disabled || busy}
                aria-pressed={kind === option}
                onClick={() => setKind(option)}
              >
                {option === "text"
                  ? "Pasted text"
                  : option === "selection"
                    ? "Selection"
                    : option === "log_output"
                      ? "Log excerpt"
                      : "URL"}
              </Button>
            ))}
          </fieldset>
          {kind !== "url" ? (
            <label className={styles.field} htmlFor={labelInputId}>
              <span>Label</span>
              <TextInput
                id={labelInputId}
                disabled={disabled || busy}
                value={label}
                maxLength={120}
                onChange={(event) => setLabel(event.target.value)}
              />
            </label>
          ) : null}
          <label className={styles.field} htmlFor={valueInputId}>
            <span>{kind === "url" ? "URL reference" : "Content"}</span>
            {kind === "url" ? (
              <TextInput
                id={valueInputId}
                value={value}
                disabled={disabled || busy}
                maxLength={2048}
                placeholder="https://docs.example.com/reference"
                onChange={(event) => setValue(event.target.value)}
              />
            ) : (
              <TextArea
                id={valueInputId}
                rows={4}
                value={value}
                disabled={disabled || busy}
                maxLength={256_000}
                placeholder="Paste only the context you want to share"
                onChange={(event) => setValue(event.target.value)}
              />
            )}
          </label>
          <div className={styles.addActions}>
            <Button
              type="button"
              size="sm"
              icon={<FilePlus2 />}
              disabled={disabled || busy}
              onClick={() =>
                void onAddFiles()
                  .then((count) => {
                    if (count === 0) toast.show({ tone: "info", title: "No files selected" });
                  })
                  .catch(report)
              }
            >
              Choose workspace files
            </Button>
            <Button
              type="button"
              size="sm"
              variant="primary"
              icon={kind === "url" ? <Link2 /> : undefined}
              disabled={disabled || busy || !value.trim()}
              onClick={() => void addDraft()}
            >
              Preview context
            </Button>
          </div>
          <p className={styles.help}>
            KalCode previews and redacts context before it reaches the selected provider session.
          </p>
        </div>
      ) : null}

      {preview ? (
        <div className={styles.preview}>
          <div className={styles.target}>
            <span>Sending to</span>
            <strong>
              {thread.providerName}
              {thread.accountLabel ? ` · ${thread.accountLabel}` : ""}
            </strong>
            <span>{thread.workspaceName}</span>
          </div>
          <ul className={styles.items}>
            {preview.items.map((item) => (
              <li key={item.position} className={styles.item} data-verdict={item.verdict.kind}>
                <label className={styles.itemTitle}>
                  <input
                    type="checkbox"
                    checked={item.included}
                    disabled={busy || item.unavailable !== null}
                    onChange={(event) => void onSetIncluded(item.position, event.target.checked).catch(report)}
                  />
                  <span>{item.label}</span>
                </label>
                <span className={styles.verdict}>{verdict(item)}</span>
                <span className={styles.bytes}>{item.bytes.toLocaleString()} bytes</span>
                {item.excerpt ? <pre>{item.excerpt}</pre> : null}
                {item.rules.map((reason) => (
                  <p
                    key={`${item.position}:${reason.effect}:${JSON.stringify(reason.rule)}:${reason.message}`}
                    className={styles.reason}
                  >
                    {reason.message}
                  </p>
                ))}
                {item.overridable && !item.overrideConfirmed ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    disabled={busy}
                    onClick={() => void onConfirm(item.position).catch(report)}
                  >
                    Confirm this item
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
          <p className={styles.total}>
            {preview.totalBytes.toLocaleString()} of {preview.maxBytes.toLocaleString()} bytes ready
          </p>
        </div>
      ) : null}
    </section>
  );
}
