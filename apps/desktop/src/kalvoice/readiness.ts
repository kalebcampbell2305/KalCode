/**
 * Whether holding the push-to-talk key can work right now, derived only from native state:
 * status, the live signal channel and the native `talk_key` registration signal. "Ready" means
 * the native key is registered, enabled, and a speech model is active; anything else names the
 * exact reason and where to fix it.
 */
import type { KalVoiceSignal, KalVoiceStatus, ShortcutIssue } from "@kalcode/protocol";
import { displayKey } from "./shortcutModel.ts";

export type PushToTalkIssue =
  | "checking"
  | "signals_unavailable"
  | "status_unavailable"
  | "status_unverified"
  | "speech_engine_unavailable"
  | "microphone_unsupported"
  | "talk_disabled"
  | "talk_key_unavailable"
  | "talk_key_unregistered"
  | "shutting_down"
  | "model_not_installed"
  | "talk_key_not_focused"
  | "talk_key_connecting"
  | "talk_key_inactive";

export type PushToTalkReadiness =
  | { ready: true; code: null; label: "Ready"; message: string; fix: null; attention: false }
  | {
      ready: false;
      code: PushToTalkIssue;
      label: string;
      message: string;
      fix: "settings" | "retry" | null;
      /** A problem to show (red); false for expected, self-resolving states. */
      attention: boolean;
    };

/** The native push-to-talk key registration, from the `talk_key` signal. */
export type TalkKeyState = Omit<Extract<KalVoiceSignal, { kind: "talk_key" }>, "kind">;

/** User copy for a key the OS or KalCode couldn't register (shown as a shortcut issue). */
function refusal(update: TalkKeyState): string | null {
  const key = displayKey(update.accelerator);
  if (update.reason === "os_refused") return "Another app is using this key. Choose a different one.";
  if (update.reason === "unparseable") return `KalCode couldn't read ${key}. Choose a different key.`;
  return null;
}

/**
 * Applies native talk-key registration to a status. Native sends `talk_key` on every change and on
 * each subscribe, so it is newer than (and overrides) whatever a status read said about the key.
 */
export function withTalkKeyState(status: KalVoiceStatus | null, update: TalkKeyState | null): KalVoiceStatus | null {
  if (!status || !update) return status;
  const refused = refusal(update);
  const others = status.shortcutIssues.filter((issue) => issue.mode !== "talk");
  const issues: ShortcutIssue[] = refused
    ? [...others, { mode: "talk", accelerator: update.accelerator, message: refused }]
    : others;
  return { ...status, talkKeyActive: update.active, shortcutIssues: issues };
}

/**
 * `signalsError`: the window has no live KalVoice signal channel, so Listening, Processing and
 * results could never be shown. `statusError`: the latest status read failed; an older status
 * is no longer proof of readiness. `talkKey`: the latest native `talk_key` signal, if any.
 */
export function pushToTalkReadiness(
  status: KalVoiceStatus | null,
  statusError: { message: string } | null,
  signalsError: { message: string } | null = null,
  talkKey: TalkKeyState | null = null,
): PushToTalkReadiness {
  const not = (
    code: PushToTalkIssue,
    label: string,
    message: string,
    fix: "settings" | "retry" | null = null,
    attention = true,
  ) => ({ ready: false, code, label, message, fix, attention }) as const;
  if (signalsError) {
    return not(
      "signals_unavailable",
      "Not connected",
      `KalVoice can't show push-to-talk progress in this window: ${signalsError.message}`,
      "retry",
    );
  }
  if (status && statusError) {
    return not(
      "status_unverified",
      "Unverified",
      `KalVoice status couldn't be refreshed: ${statusError.message}`,
      "retry",
    );
  }
  if (!status) {
    return statusError
      ? not("status_unavailable", "Unavailable", `KalVoice status couldn't be read: ${statusError.message}`, "retry")
      : not("checking", "Checking", "Checking push to talk.", null, false);
  }
  const current = withTalkKeyState(status, talkKey) ?? status;
  const key = displayKey(talkKey?.accelerator ?? current.preferences.talkKey);
  if (!current.speechEngine) {
    return not(
      "speech_engine_unavailable",
      "Not in this build",
      "This build doesn't include the on-device speech engine.",
    );
  }
  if (!current.microphoneSupported) {
    return not("microphone_unsupported", "Unavailable", "Microphone capture isn't supported on this platform yet.");
  }
  const reason = talkKey && !talkKey.active ? talkKey.reason : null;
  if (!current.preferences.talkEnabled || reason === "disabled") {
    return not("talk_disabled", "Off", "Push to talk is off. Turn it on in Settings, KalVoice.", "settings");
  }
  if (reason === "shutting_down") {
    return not("shutting_down", "Stopping", "KalCode is closing, so push to talk is off.", null, false);
  }
  const issue = current.shortcutIssues.find((i) => i.mode === "talk");
  if (issue) {
    return not(
      "talk_key_unavailable",
      "Key unavailable",
      `${displayKey(issue.accelerator)} unavailable: ${issue.message}`,
      "settings",
    );
  }
  if (reason === "prefs_error") {
    return not(
      "talk_key_unregistered",
      "Key not registered",
      `KalVoice settings couldn't be read, so ${key} wasn't registered.`,
      "retry",
    );
  }
  if (!current.activeModel) {
    return not(
      "model_not_installed",
      "Needs a speech model",
      "Download a speech model in Settings, KalVoice, to use push to talk.",
      "settings",
    );
  }
  if (reason === "not_connected") {
    // Transient: native holds the key only once a KalCode page is subscribed to its signals.
    return not("talk_key_connecting", "Connecting", `${key} works once KalVoice finishes connecting.`, null, false);
  }
  if (reason === "not_focused") {
    // Expected while KalCode is in the background: native registers the key again on focus.
    return not(
      "talk_key_not_focused",
      "Ready when in front",
      `${key} works while KalCode is the active window.`,
      null,
      false,
    );
  }
  if (!current.talkKeyActive) {
    return not(
      "talk_key_inactive",
      "Key not active",
      `${key} isn't registered right now. If KalCode is in front and it stays inactive, choose a different key in Settings, KalVoice.`,
      "settings",
    );
  }
  return {
    ready: true,
    code: null,
    label: "Ready",
    message: `Hold ${key} to talk to KalVoice.`,
    fix: null,
    attention: false,
  };
}
