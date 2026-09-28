import type { LocalReasoningDownload, PanelAnchor, SpeechModelInfo } from "@kalcode/protocol";
import { Badge, Button, Panel, Skeleton } from "@kalcode/ui/components";
import { AudioLines } from "lucide-react";
import { AlertDialog } from "radix-ui";
import { type KeyboardEvent, useEffect, useId, useState } from "react";
import { toKalCodeError } from "../ipc/errors.ts";
import { formatBytes } from "./assistantState.ts";
import { useKalVoice, useOptionalKalVoice } from "./KalVoiceProvider.tsx";
import styles from "./KalVoiceSettings.module.css";
import { localIntelligence } from "./localIntelligence.ts";
import { ANCHOR_LABELS } from "./panelGeometry.ts";
import { pushToTalkReadiness } from "./readiness.ts";
import { checkReserved, displayKey, isModifierOnly, talkKeyChoiceHint, talkKeyFromEvent } from "./shortcutModel.ts";

const ANCHORS: PanelAnchor[] = [
  "bottom_right",
  "bottom",
  "bottom_left",
  "right",
  "left",
  "top_right",
  "top",
  "top_left",
];

function Row({ id, label, help, children }: { id: string; label: string; help: string; children: React.ReactNode }) {
  return (
    <div className={styles.row}>
      <div className={styles.rowText}>
        <p id={`${id}-label`} className={styles.rowLabel}>
          {label}
        </p>
        <p id={`${id}-help`} className={styles.rowHelp}>
          {help}
        </p>
      </div>
      <div className={styles.rowControl}>{children}</div>
    </div>
  );
}

/** Settings → KalVoice (rendered only when the KalVoice feature is on). */
export function KalVoiceSettings() {
  return useOptionalKalVoice() ? <KalVoiceSettingsSection /> : null;
}

function KalVoiceSettingsSection() {
  const { status, statusError, refreshStatus } = useKalVoice();
  // Opening Settings re-reads native status, so key registration shown here is current.
  // biome-ignore lint/correctness/useExhaustiveDependencies: once per mount.
  useEffect(() => {
    void refreshStatus();
  }, []);
  return (
    <Panel
      id="kalvoice"
      title="KalVoice"
      icon={<AudioLines />}
      description="Speech recognition and command interpretation run on this computer. Providers receive only the coding tasks or dictation you send to them."
      padding="none"
    >
      {!status ? (
        statusError ? (
          <div className={styles.inlineError} role="alert">
            <p>{statusError.message}</p>
            <Button size="sm" onClick={() => void refreshStatus()}>
              Try again
            </Button>
          </div>
        ) : (
          <div role="status" aria-busy="true" className={styles.loading}>
            <span className="visually-hidden">Loading KalVoice settings</span>
            <Skeleton width="55%" />
            <Skeleton width="40%" />
          </div>
        )
      ) : (
        <div className={styles.rows}>
          <PushToTalkReadinessRow />
          <TalkKeyRow />
          {/* The talk key's issue is in the readiness row above; list only the others. */}
          {status.shortcutIssues
            .filter((issue) => issue.mode !== "talk")
            .map((issue) => (
              <p key={issue.accelerator} className={styles.issue} role="alert">
                {displayKey(issue.accelerator)} unavailable: {issue.message}
              </p>
            ))}
          <TalkEnabledRow />
          <IntelligenceRow />
          <ModelsRow />
          <VoiceRepliesRow />
          <PanelRow />
        </div>
      )}
    </Panel>
  );
}

/** Whether holding the key works right now, from native status (never assumed). */
function PushToTalkReadinessRow() {
  const { status, statusError, signalsError, talkKey, retryConnection } = useKalVoice();
  const readiness = pushToTalkReadiness(status, statusError, signalsError, talkKey);
  return (
    <div
      className={styles.readiness}
      role="status"
      aria-label="Push-to-talk readiness"
      data-attention={!readiness.ready && readiness.attention}
    >
      <p>
        {readiness.ready ? "Ready. " : `${readiness.label}. `}
        {readiness.message}
      </p>
      {readiness.code === "talk_key_inactive" ? (
        // Re-subscribing makes native report the key's current registration.
        <Button size="sm" variant="ghost" onClick={() => void retryConnection()}>
          Check again
        </Button>
      ) : readiness.fix === "retry" ? (
        <Button size="sm" variant="ghost" onClick={() => void retryConnection()}>
          Try again
        </Button>
      ) : null}
    </div>
  );
}

function TalkKeyRow() {
  const { status, updatePreferences } = useKalVoice();
  const [capturing, setCapturing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const errorId = useId();
  if (!status) return null;
  const current = status.preferences.talkKey;

  const onKeyDown = async (event: KeyboardEvent<HTMLButtonElement>) => {
    if (!capturing) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.key === "Escape") {
      setCapturing(false);
      return;
    }
    // A modifier alone may be the start of a chord: wait for the next key (or its release).
    if (isModifierOnly(event)) return;
    setCapturing(false);
    // Whatever the keyboard actually delivers: Fn is only ever offered if it arrives.
    const pressed = talkKeyFromEvent(event, status.talkKeys);
    const checked = pressed.ok ? checkReserved(pressed.value, status.reservedShortcuts) : pressed;
    if (!checked.ok) {
      setError(checked.message);
      return;
    }
    setSaving(true);
    try {
      await updatePreferences({ talkKey: checked.value });
      setError(null);
    } catch (e) {
      setError(toKalCodeError(e).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className={styles.shortcutBlock}>
      <Row
        id="kalvoice-talk-key"
        label="Push-to-talk key"
        help="Hold it, speak, release. KalVoice runs local workspace commands or types into the box you're in. It works only while KalCode is in front, so other apps keep the key."
      >
        <span className={styles.keys}>
          <kbd>{displayKey(current)}</kbd>
        </span>
        <Button
          size="sm"
          busy={saving}
          aria-describedby={error ? errorId : undefined}
          aria-label={capturing ? "Press the key you want to use, or Escape to cancel" : "Change the push-to-talk key"}
          onClick={() => {
            setError(null);
            setCapturing((c) => !c);
          }}
          onKeyDown={(e) => void onKeyDown(e)}
          onKeyUp={(e) => {
            if (!capturing || !isModifierOnly(e)) return;
            const pressed = talkKeyFromEvent(e, status.talkKeys);
            setCapturing(false);
            if (!pressed.ok) setError(pressed.message);
          }}
          onBlur={() => setCapturing(false)}
        >
          {capturing ? "Press the key you want to use…" : "Change"}
        </Button>
      </Row>
      {error ? (
        <p id={errorId} className={styles.fieldError} role="alert">
          {error}
        </p>
      ) : (
        <p className={styles.conflictNote}>
          {talkKeyChoiceHint(status.talkKeys)} Fn isn't offered because macOS and many keyboards handle it specially;
          Caps Lock would switch on and off while held.
        </p>
      )}
    </div>
  );
}

function TalkEnabledRow() {
  const { status, updatePreferences } = useKalVoice();
  if (!status) return null;
  const on = status.preferences.talkEnabled;
  return (
    <Row
      id="kalvoice-talk-enabled"
      label="Push to talk"
      help="On by default, including while the widget is hidden. Turn it off to free the key."
    >
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-labelledby="kalvoice-talk-enabled-label"
        className={styles.switch}
        onClick={() => void updatePreferences({ talkEnabled: !on })}
      >
        <span className={styles.switchThumb} />
      </button>
    </Row>
  );
}

function IntelligenceRow() {
  const { status, prepareReasoning, retryReasoning, downloadModel, downloads, cancelDownload } = useKalVoice();
  const [quote, setQuote] = useState<LocalReasoningDownload | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const progress = downloads["local-reasoning"];
  const readiness = status?.localReasoning ?? "unavailable";
  const view = localIntelligence(status);
  const review = async () => {
    setLoading(true);
    setError(null);
    try {
      setQuote(await prepareReasoning());
    } catch (error) {
      setError(toKalCodeError(error).message);
    } finally {
      setLoading(false);
    }
  };
  const retry = async () => {
    setError(null);
    try {
      await retryReasoning();
    } catch (error) {
      setError(toKalCodeError(error).message);
    }
  };
  return (
    <div>
      <Row
        id="kalvoice-intelligence"
        label="KalVoice intelligence"
        help="Simple commands run locally immediately. The optional on-device interpreter handles supported phrasing outside the command grammar. Local dictation is unlimited on every plan and needs only a speech model."
      >
        <span>
          {progress ? `Downloading ${formatBytes(progress.received)} / ${formatBytes(progress.total)}` : view.label}
        </span>
        {progress ? (
          <Button size="sm" onClick={() => void cancelDownload("local-reasoning")}>
            Cancel
          </Button>
        ) : readiness === "not_installed" ? (
          <Button size="sm" busy={loading} onClick={() => void review()}>
            Review download
          </Button>
        ) : view.retry ? (
          <Button size="sm" variant="ghost" onClick={() => void retry()}>
            Retry local startup
          </Button>
        ) : null}
      </Row>
      {readiness === "waiting" ? (
        <p className={styles.note} role="note">
          {view.detail}
        </p>
      ) : readiness === "failed" ? (
        <p className={styles.issue} role="status">
          {view.detail}
        </p>
      ) : null}
      {error ? (
        <p className={styles.fieldError} role="alert">
          {error}
        </p>
      ) : null}
      <AlertDialog.Root open={quote !== null} onOpenChange={(open) => !open && setQuote(null)}>
        <AlertDialog.Portal>
          <AlertDialog.Overlay className={styles.overlay} />
          <AlertDialog.Content className={styles.dialog}>
            <AlertDialog.Title className={styles.dialogTitle}>
              Download the local KalVoice interpreter?
            </AlertDialog.Title>
            <AlertDialog.Description className={styles.dialogBody}>
              {quote ? formatBytes(quote.sizeBytes) : ""} from KalCode's signed component catalog. Runtime{" "}
              {quote?.runtimeVersion}; model {quote?.modelVersion}. KalCode verifies signatures and checksums before
              installation. The interpreter runs on this computer and does not use a connected provider. This download
              is separate from your speech model.
            </AlertDialog.Description>
            <div className={styles.dialogActions}>
              <AlertDialog.Cancel asChild>
                <Button variant="ghost">Cancel</Button>
              </AlertDialog.Cancel>
              <AlertDialog.Action asChild>
                <Button
                  variant="primary"
                  onClick={() => {
                    if (quote) void downloadModel("local-reasoning", quote);
                    setQuote(null);
                  }}
                >
                  Download
                </Button>
              </AlertDialog.Action>
            </div>
          </AlertDialog.Content>
        </AlertDialog.Portal>
      </AlertDialog.Root>
    </div>
  );
}

function ModelsRow() {
  const { status, downloads, downloadModel, cancelDownload, deleteModel, updatePreferences } = useKalVoice();
  const [consent, setConsent] = useState<SpeechModelInfo | null>(null);
  if (!status) return null;
  const engineNote = !status.speechEngine
    ? "This build doesn't include the on-device speech engine, so dictation isn't available. Models can still be managed."
    : !status.microphoneSupported
      ? "Microphone capture isn't supported on this platform in this build."
      : null;

  return (
    <div className={styles.models}>
      <div className={styles.rowText}>
        <p className={styles.rowLabel} id="kalvoice-models-label">
          Speech model
        </p>
        <p className={styles.rowHelp}>
          Downloaded only when you choose to, from the official whisper.cpp models, checked against their published
          SHA-256, and kept in KalCode's data folder.
        </p>
        {engineNote ? (
          <p className={styles.note} role="note">
            {engineNote}
          </p>
        ) : null}
      </div>
      <ul className={styles.modelList} aria-labelledby="kalvoice-models-label">
        {status.models.map((model) => {
          const progress = downloads[model.id];
          const state = progress ? "downloading" : model.state.kind;
          const active = status.activeModel === model.id;
          const percent = progress && progress.total > 0 ? Math.floor((progress.received / progress.total) * 100) : 0;
          return (
            <li key={model.id} className={styles.model} data-state={state} data-active={active || undefined}>
              <div className={styles.modelText}>
                <p className={styles.modelName}>
                  {model.displayName}
                  {active ? <Badge tone="accent">In use</Badge> : null}
                </p>
                <p className={styles.modelMeta}>
                  {model.summary} {formatBytes(model.sizeBytes)}.
                </p>
                {state === "downloading" ? (
                  <div
                    className={styles.progress}
                    role="progressbar"
                    aria-label={`Downloading ${model.displayName}`}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={percent}
                  >
                    <span style={{ transform: `scaleX(${percent / 100})` }} />
                  </div>
                ) : null}
                {model.state.kind === "paused" && !progress ? (
                  <p className={styles.modelMeta}>
                    Paused at {Math.floor((model.state.receivedBytes / model.sizeBytes) * 100)}%.
                  </p>
                ) : null}
              </div>
              <div className={styles.modelActions}>
                {state === "installed" && !active ? (
                  <Button size="sm" onClick={() => void updatePreferences({ speechModel: model.id })}>
                    Use
                  </Button>
                ) : null}
                {state === "installed" ? (
                  <Button size="sm" variant="ghost" onClick={() => void deleteModel(model.id)}>
                    Remove
                  </Button>
                ) : null}
                {state === "downloading" ? (
                  <Button size="sm" variant="ghost" onClick={() => void cancelDownload(model.id)}>
                    Cancel
                  </Button>
                ) : null}
                {state === "paused" ? (
                  <>
                    <Button size="sm" onClick={() => setConsent(model)}>
                      Resume
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => void deleteModel(model.id)}>
                      Remove
                    </Button>
                  </>
                ) : null}
                {state === "not_installed" ? (
                  <Button size="sm" onClick={() => setConsent(model)}>
                    Download
                  </Button>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>
      <ConsentDialog
        model={consent}
        onCancel={() => setConsent(null)}
        onConfirm={() => {
          if (consent) void downloadModel(consent.id);
          setConsent(null);
        }}
      />
    </div>
  );
}

function ConsentDialog({
  model,
  onCancel,
  onConfirm,
}: {
  model: SpeechModelInfo | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <AlertDialog.Root open={model !== null} onOpenChange={(open) => !open && onCancel()}>
      <AlertDialog.Portal>
        <AlertDialog.Overlay className={styles.overlay} />
        <AlertDialog.Content className={styles.dialog}>
          <AlertDialog.Title className={styles.dialogTitle}>
            Download {model?.displayName} speech model?
          </AlertDialog.Title>
          <AlertDialog.Description className={styles.dialogBody}>
            {model ? formatBytes(model.sizeBytes) : ""} from {model?.source}. KalCode checks it against the published
            SHA-256 checksum and keeps it in its data folder on this computer. Your speech never leaves this computer.
            You can remove the model at any time.
          </AlertDialog.Description>
          <div className={styles.dialogActions}>
            <AlertDialog.Cancel asChild>
              <Button variant="ghost">Cancel</Button>
            </AlertDialog.Cancel>
            <AlertDialog.Action asChild>
              <Button variant="primary" onClick={onConfirm}>
                Download
              </Button>
            </AlertDialog.Action>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}

function VoiceRepliesRow() {
  const { status, updatePreferences } = useKalVoice();
  if (!status) return null;
  const on = status.preferences.voiceReplies;
  return (
    <Row
      id="kalvoice-replies"
      label="Spoken replies"
      help={
        status.voiceOutputAvailable
          ? "Reads short results aloud with your operating system's voice. Off by default."
          : "Your system's voice isn't available, so KalVoice can't speak replies on this computer."
      }
    >
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-labelledby="kalvoice-replies-label"
        className={styles.switch}
        disabled={!status.voiceOutputAvailable}
        onClick={() => void updatePreferences({ voiceReplies: !on })}
      >
        <span className={styles.switchThumb} />
      </button>
    </Row>
  );
}

function PanelRow() {
  const { status, updatePreferences, setPanelVisible } = useKalVoice();
  if (!status) return null;
  return (
    <>
      <Row
        id="kalvoice-panel-position"
        label="Widget position"
        help="Where the KalVoice widget starts. Changing it moves the widget there in every window size."
      >
        <select
          className={styles.select}
          aria-labelledby="kalvoice-panel-position-label"
          value={status.preferences.panelDefault === "free" ? "top" : status.preferences.panelDefault}
          onChange={(e) => void updatePreferences({ panelDefault: e.target.value as PanelAnchor })}
        >
          {ANCHORS.map((a) => (
            <option key={a} value={a}>
              {ANCHOR_LABELS[a]}
            </option>
          ))}
        </select>
      </Row>
      <Row
        id="kalvoice-panel-visible"
        label="Show the widget"
        help="The floating KalVoice widget over your workspace. The push-to-talk key brings it back."
      >
        <button
          type="button"
          role="switch"
          aria-checked={status.preferences.panelVisible}
          aria-labelledby="kalvoice-panel-visible-label"
          className={styles.switch}
          onClick={() => setPanelVisible(!status.preferences.panelVisible)}
        >
          <span className={styles.switchThumb} />
        </button>
      </Row>
    </>
  );
}
