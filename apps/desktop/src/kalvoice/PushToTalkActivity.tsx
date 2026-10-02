import { Button } from "@kalcode/ui/components";
import { type CSSProperties, useState } from "react";
import { useNavigation } from "../shell/navigation.tsx";
import { useShellSlots } from "../shell/ShellSlots.tsx";
import { STATE_LABELS } from "./assistantState.ts";
import { useKalVoice, useOptionalKalVoice } from "./KalVoiceProvider.tsx";
import styles from "./PushToTalkActivity.module.css";
import { pushToTalkReadiness } from "./readiness.ts";

/** The in-app fix for a KalVoice error code, when KalCode has one. */
export function FixAction({ code }: { code: string | null }) {
  const { navigate } = useNavigation();
  const kv = useOptionalKalVoice();
  if (code === "microphone_denied" && kv) {
    // Opens only the OS microphone privacy page (Windows Settings or macOS System Settings).
    return (
      <Button size="sm" onClick={() => void kv.openMicrophoneSettings()}>
        Open privacy settings
      </Button>
    );
  }
  if (code === "needs_provider") {
    return (
      <Button size="sm" onClick={() => navigate("providers")}>
        Open Providers
      </Button>
    );
  }
  if (code === "local_reasoning_unavailable") {
    return (
      <Button size="sm" onClick={() => navigate("settings")}>
        Open KalVoice settings
      </Button>
    );
  }
  if (code === "model_not_installed" || code === "speech_engine_unavailable") {
    return (
      <Button size="sm" onClick={() => navigate("settings")}>
        Set up speech
      </Button>
    );
  }
  return null;
}

/**
 * Push-to-talk activity for whenever the floating widget can't show it (hidden, collapsed to
 * the orb, or without status). Holding the key is never silent: Listening, Processing, the result
 * or the exact failure appears here on every page. It reflects only real native signals.
 */
export function PushToTalkActivity() {
  const { state, panel, status, statusError, signalsError, talkKey, retryConnection, dismiss } = useKalVoice();
  const slots = useShellSlots();
  const [dismissed, setDismissed] = useState<string | null>(null);
  const activityStyle = {
    "--shell-bottom-inset": `${slots?.insets.bottom ?? 0}px`,
  } as CSSProperties;
  const widgetShowsDetail = panel.visible && status !== null && panel.view !== "orb";
  const phase = state.phase;
  const readiness = pushToTalkReadiness(status, statusError, signalsError, talkKey);
  const disconnected =
    readiness.code === "status_unavailable" ||
    readiness.code === "signals_unavailable" ||
    readiness.code === "status_unverified";
  if (phase === "idle" && disconnected && !widgetShowsDetail) {
    // No live signals or no verified native status (e.g. the runtime isn't up yet): the widget
    // can't show it, and the push-to-talk key may do nothing. Say why instead of showing nothing.
    if (dismissed === readiness.message) return null;
    return (
      <section
        className={styles.activity}
        style={activityStyle}
        data-phase="error"
        role="status"
        aria-label="Push to talk"
      >
        <p className={styles.state}>
          <span className={styles.dot} aria-hidden="true" />
          <span>KalVoice: {readiness.label}</span>
        </p>
        <p className={styles.detail}>{readiness.message}</p>
        <div className={styles.actions}>
          <Button size="sm" onClick={() => void retryConnection()}>
            Try again
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setDismissed(readiness.message)}>
            Dismiss
          </Button>
        </div>
      </section>
    );
  }
  if (widgetShowsDetail || phase === "idle") return null;
  const failed = phase === "error";
  const detail =
    phase === "listening" ? (state.partial ?? "Listening…") : phase === "transcribing" ? state.partial : state.message;
  return (
    <section
      className={styles.activity}
      style={activityStyle}
      data-phase={phase}
      role={failed ? "alert" : "status"}
      aria-label="Push to talk"
    >
      <p className={styles.state}>
        <span className={styles.dot} aria-hidden="true" />
        <span>KalVoice: {STATE_LABELS[phase]}</span>
      </p>
      {detail ? (
        // Live partial words are not read out one by one; the state line is.
        <p className={styles.detail} aria-live={phase === "listening" || phase === "transcribing" ? "off" : undefined}>
          {detail}
        </p>
      ) : null}
      {failed ? (
        <div className={styles.actions}>
          <FixAction code={state.code} />
          <Button size="sm" variant="ghost" onClick={dismiss}>
            Dismiss
          </Button>
        </div>
      ) : null}
    </section>
  );
}
