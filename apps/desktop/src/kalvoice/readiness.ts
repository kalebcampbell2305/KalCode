/**
 * Whether holding the push-to-talk key can work right now, derived only from native status.
 * "Ready" means the native key is registered, enabled, and a speech model is active; anything
 * else names the exact reason and where to fix it.
 */
import type { KalVoiceStatus } from "@kalcode/protocol";
import { displayKey } from "./shortcutModel.ts";

export type PushToTalkIssue =
  | "checking"
  | "status_unavailable"
  | "speech_engine_unavailable"
  | "microphone_unsupported"
  | "talk_disabled"
  | "talk_key_unavailable"
  | "model_not_installed"
  | "talk_key_inactive";

export type PushToTalkReadiness =
  | { ready: true; code: null; label: "Ready"; message: string; fix: null }
  | { ready: false; code: PushToTalkIssue; label: string; message: string; fix: "settings" | "retry" | null };

export function pushToTalkReadiness(
  status: KalVoiceStatus | null,
  statusError: { message: string } | null,
): PushToTalkReadiness {
  const not = (code: PushToTalkIssue, label: string, message: string, fix: "settings" | "retry" | null = null) =>
    ({ ready: false, code, label, message, fix }) as const;
  if (!status) {
    return statusError
      ? not("status_unavailable", "Unavailable", `KalVoice status couldn't be read: ${statusError.message}`, "retry")
      : not("checking", "Checking", "Checking push to talk.");
  }
  const key = displayKey(status.preferences.talkKey);
  if (!status.speechEngine) {
    return not(
      "speech_engine_unavailable",
      "Not in this build",
      "This build doesn't include the on-device speech engine.",
    );
  }
  if (!status.microphoneSupported) {
    return not("microphone_unsupported", "Unavailable", "Microphone capture isn't supported on this platform yet.");
  }
  if (!status.preferences.talkEnabled) {
    return not("talk_disabled", "Off", "Push to talk is off. Turn it on in Settings, KalVoice.", "settings");
  }
  const issue = status.shortcutIssues.find((i) => i.mode === "talk");
  if (issue) {
    return not(
      "talk_key_unavailable",
      "Key unavailable",
      `${displayKey(issue.accelerator)} unavailable: ${issue.message}`,
      "settings",
    );
  }
  if (!status.activeModel) {
    return not(
      "model_not_installed",
      "Needs a speech model",
      "Download a speech model in Settings, KalVoice, to use push to talk.",
      "settings",
    );
  }
  if (!status.talkKeyActive) {
    return not(
      "talk_key_inactive",
      "Key not active",
      `${key} isn't registered right now. KalCode registers it while its window is in front; if it stays inactive, choose a different key in Settings, KalVoice.`,
      "settings",
    );
  }
  return { ready: true, code: null, label: "Ready", message: `Hold ${key} to talk to KalVoice.`, fix: null };
}
