import { Button, IconButton } from "@kalcode/ui/components";
import { CircleAlert, CircleCheck, Mic, Send, ShieldQuestion, Square } from "lucide-react";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { useNavigation } from "../shell/navigation.tsx";
import { IS_MAC } from "../shell/shortcuts.ts";
import styles from "./Assistant.module.css";
import { usageLine } from "./assistantState.ts";
import { useKalVoice } from "./KalVoiceProvider.tsx";
import { displayShortcut } from "./shortcutModel.ts";

const EXAMPLES = ["Go to settings", "Open four Codex threads", "What needs permission?", "Pause every active thread"];

/** Type or speak a request. Shared by the floating panel and the KalVoice page. */
export function RequestForm({ id, autoFocusToken }: { id: string; autoFocusToken?: number }) {
  const { submit, state, startListening, stopListening, status } = useKalVoice();
  const [text, setText] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);
  const busy = state.phase === "thinking" || state.phase === "executing";
  const listeningHere = state.mode === "command" && (state.phase === "listening" || state.phase === "transcribing");
  const speechReady = Boolean(status?.speechEngine && status.activeModel && status.microphoneSupported);

  useEffect(() => {
    if (autoFocusToken) inputRef.current?.focus();
  }, [autoFocusToken]);

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (!text.trim() || busy) return;
    void submit(text, "text");
    setText("");
  };

  return (
    <form className={styles.form} onSubmit={onSubmit} aria-label="Ask KalVoice">
      <input
        ref={inputRef}
        id={id}
        className={styles.input}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Ask KalVoice or give a command"
        aria-label="Request for KalVoice"
        autoComplete="off"
        spellCheck={false}
        maxLength={4000}
      />
      {speechReady ? (
        <IconButton
          label={listeningHere ? "Stop and send" : "Speak a command"}
          aria-pressed={listeningHere}
          icon={listeningHere ? <Square /> : <Mic />}
          onClick={() => void (listeningHere ? stopListening() : startListening("command"))}
          disabled={busy || state.phase === "transcribing"}
        />
      ) : null}
      <IconButton label="Send to KalVoice" icon={<Send />} type="submit" disabled={!text.trim() || busy} />
    </form>
  );
}

export function Examples({ onPick }: { onPick: (text: string) => void }) {
  return (
    <ul className={styles.examples} aria-label="Examples">
      {EXAMPLES.map((example) => (
        <li key={example}>
          <button type="button" className={styles.example} onClick={() => onPick(example)}>
            {example}
          </button>
        </li>
      ))}
    </ul>
  );
}

/** The outcome of the latest request or listening session, with the one useful next step. */
export function ResultView() {
  const { state } = useKalVoice();
  const { navigate } = useNavigation();
  if (state.phase !== "done" && state.phase !== "error" && state.phase !== "waiting_for_permission") {
    return null;
  }
  const tone = state.phase === "done" ? "success" : state.phase === "error" ? "danger" : "waiting";
  const Icon = tone === "success" ? CircleCheck : tone === "danger" ? CircleAlert : ShieldQuestion;
  const title =
    state.phase === "done"
      ? "Done"
      : state.phase === "waiting_for_permission"
        ? "Waiting for your approval"
        : state.code === "needs_provider"
          ? "Connect a provider"
          : state.code === "limit_reached"
            ? "Monthly limit reached"
            : "Needs attention";
  return (
    <div className={styles.result} data-tone={tone}>
      <Icon className={styles.resultIcon} aria-hidden="true" />
      <div className={styles.resultText}>
        <p className={styles.resultTitle}>{title}</p>
        {state.message ? <p className={styles.resultMessage}>{state.message}</p> : null}
        {state.code === "needs_provider" ? (
          <Button size="sm" variant="secondary" onClick={() => navigate("providers")}>
            Open Providers
          </Button>
        ) : null}
        {state.code === "model_not_installed" || state.code === "speech_engine_unavailable" ? (
          <Button size="sm" variant="secondary" onClick={() => navigate("settings")}>
            Open KalVoice settings
          </Button>
        ) : null}
      </div>
    </div>
  );
}

export function UsageFooter() {
  const { status } = useKalVoice();
  if (!status) return null;
  return (
    <p className={styles.usage}>
      <span>{usageLine(status.usage)}</span>
      <span className={styles.usageNote}>Dictation is never counted</span>
    </p>
  );
}

export function ShortcutHint() {
  const { status } = useKalVoice();
  if (!status) return null;
  return (
    <p className={styles.hint}>
      Hold <kbd>{displayShortcut(status.preferences.dictationShortcut, IS_MAC)}</kbd> to dictate ·{" "}
      <kbd>{displayShortcut(status.preferences.commandShortcut, IS_MAC)}</kbd> for commands
    </p>
  );
}
