import { Button } from "@kalcode/ui/components";
import { useState } from "react";
import { useNavigation } from "../shell/navigation.tsx";
import { STATE_LABELS } from "./assistantState.ts";
import { useKalVoice } from "./KalVoiceProvider.tsx";
import styles from "./PushToTalkActivity.module.css";

/** The in-app fix for a KalVoice error code, when KalCode has one. */
export function FixAction({ code }: { code: string | null }) {
  const { navigate } = useNavigation();
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
  const { state, panel, status, statusError, refreshStatus, dismiss } = useKalVoice();
  const [dismissedError, setDismissedError] = useState<string | null>(null);
  const widgetShowsDetail = panel.visible && status !== null && panel.view !== "orb";
  const phase = state.phase;
  if (phase === "idle" && !status && statusError) {
    // No native KalVoice status (e.g. the runtime didn't start): the widget can't render, and
    // the push-to-talk key won't work. Say why instead of showing nothing.
    if (dismissedError === statusError.message) return null;
    return (
      <section className={styles.activity} data-phase="error" role="status" aria-label="Push to talk">
        <p className={styles.state}>
          <span className={styles.dot} aria-hidden="true" />
          <span>KalVoice: Unavailable</span>
        </p>
        <p className={styles.detail}>{statusError.message}</p>
        <div className={styles.actions}>
          <Button size="sm" onClick={() => void refreshStatus()}>
            Try again
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setDismissedError(statusError.message)}>
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
      data-phase={phase}
      role={failed ? "alert" : "status"}
      aria-label="Push to talk"
    >
      <p className={styles.state}>
        <span className={styles.dot} aria-hidden="true" />
        <span>KalVoice: {STATE_LABELS[phase]}</span>
      </p>
      {detail ? <p className={styles.detail}>{detail}</p> : null}
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
