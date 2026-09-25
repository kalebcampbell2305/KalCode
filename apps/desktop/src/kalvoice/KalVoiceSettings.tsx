import type { PanelAnchor, SpeechModelInfo } from "@kalcode/protocol";
import { Badge, Button, Section, Skeleton } from "@kalcode/ui/components";
import { AlertDialog } from "radix-ui";
import { type KeyboardEvent, useId, useState } from "react";
import { toKalCodeError } from "../ipc/errors.ts";
import { formatBytes } from "./assistantState.ts";
import { useKalVoice, useOptionalKalVoice } from "./KalVoiceProvider.tsx";
import styles from "./KalVoiceSettings.module.css";
import { ANCHOR_LABELS } from "./panelGeometry.ts";
import { checkReserved, displayKey, isModifierOnly, talkKeyFromEvent } from "./shortcutModel.ts";

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
  return (
    <Section
      id="kalvoice"
      title="KalVoice"
      description="Speech is recognized on this computer and discarded right after. Reasoning uses a provider you connected; KalCode never pays for or sees it."
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
          <TalkKeyRow />
          {status.shortcutIssues.map((issue) => (
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
    </Section>
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
        help="Hold it, speak, release. KalVoice runs commands it recognizes, types into the box you're in, or answers with your provider. It works only while KalCode is in front, so other apps keep the key."
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
          One key on its own: F1–F24, Pause, Scroll Lock or Insert. Fn isn't offered because it doesn't reach apps on
          this system; Caps Lock would switch on and off while held.
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
  const { status, updatePreferences } = useKalVoice();
  if (!status) return null;
  const selected = status.preferences.intelligence;
  const value =
    selected === null ? "automatic" : selected.kind === "local" ? "local" : `provider:${selected.providerId}`;
  const connected = status.providers;
  return (
    <Row
      id="kalvoice-intelligence"
      label="KalVoice intelligence"
      help={
        connected.length === 0
          ? "No provider is connected yet. Commands KalCode understands directly still work; other requests need Claude Code, Codex or Gemini CLI signed in on this computer."
          : "Which of your connected providers answers requests that need reasoning. Uses your own account."
      }
    >
      <select
        className={styles.select}
        aria-labelledby="kalvoice-intelligence-label"
        value={value}
        onChange={(e) => {
          const v = e.target.value;
          void updatePreferences({
            intelligence: v.startsWith("provider:")
              ? { kind: "provider", providerId: v.slice("provider:".length) }
              : { kind: "automatic" },
          });
        }}
      >
        <option value="automatic">Automatic (the only connected provider)</option>
        {connected.map((p) => (
          <option key={p.id} value={`provider:${p.id}`}>
            {p.displayName}
            {p.available ? "" : " (signed out)"}
          </option>
        ))}
        {value.startsWith("provider:") && !connected.some((p) => `provider:${p.id}` === value) ? (
          <option value={value}>{value.slice("provider:".length)} (not connected)</option>
        ) : null}
      </select>
    </Row>
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
            <li key={model.id} className={styles.model} data-state={state}>
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
