/**
 * Whether holding the push-to-talk key can work right now, derived only from native state:
 * status, the live signal channel and the native `talk_key` registration signal. "Ready" means
 * the native key is registered, enabled, and a speech model is active; anything else names the
 * exact reason and where to fix it.
 */
import type { ComponentProvisioning, KalVoiceSignal, KalVoiceStatus, ShortcutIssue } from "@kalcode/protocol";
import { formatBytes } from "./assistantState.ts";
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
  | "model_preparing"
  | "model_unavailable"
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

export type LocalReasoningState = Omit<Extract<KalVoiceSignal, { kind: "local_reasoning_status" }>, "kind">;

/**
 * Applies the latest native `local_reasoning_status`. Native publishes every transition as it
 * happens and answers each subscribe with the current state, so the signal is newer than a status
 * read that was computed before it (such a read can resolve after the signal and would otherwise
 * leave the interpreter shown as starting or not running after it became ready).
 */
export function withReasoningState(
  status: KalVoiceStatus | null,
  update: LocalReasoningState | null,
): KalVoiceStatus | null {
  if (!status || !update) return status;
  const { localReasoningIssue: _previous, ...rest } = status;
  return {
    ...rest,
    localReasoning: update.status,
    ...(update.issue === undefined ? {} : { localReasoningIssue: update.issue }),
  };
}

/** Applies the latest native `provisioning` list (newer than a status read computed before it). */
export function withProvisioning(
  status: KalVoiceStatus | null,
  items: ComponentProvisioning[] | null,
): KalVoiceStatus | null {
  if (!status || !items) return status;
  return { ...status, provisioning: items };
}

/** The local-intelligence download id; every other provisioning item is a speech model. */
export const LOCAL_REASONING_ID = "local-reasoning";

/** A component download for `modelId`, if one is pending or running. */
export function provisioningFor(
  status: Pick<KalVoiceStatus, "provisioning"> | null | undefined,
  modelId: string,
): ComponentProvisioning | null {
  return status?.provisioning?.find((item) => item.modelId === modelId) ?? null;
}

/** The speech model download that push to talk is waiting for (automatic first, then manual). */
function speechProvisioning(status: KalVoiceStatus): ComponentProvisioning | null {
  const speech = (status.provisioning ?? []).filter((item) => item.modelId !== LOCAL_REASONING_ID);
  return speech.find((item) => item.automatic) ?? speech[0] ?? null;
}

/** What KalCode is waiting for, in owner terms, from a safe reason code. */
export function waitingReason(reason: string | undefined): string {
  switch (reason) {
    case "cpu":
      return "the CPU is less busy";
    case "memory":
    case "kalcode_memory":
      return "enough memory is free";
    case "disk_space":
      return "enough disk space is free";
    case "workload_limit":
      return "other KalCode work finishes";
    case "push_to_talk":
      return "push to talk is released";
    default:
      return "current resource readings are available";
  }
}

/** When the next automatic attempt runs, from `retryInSeconds`. */
export function retryWhen(seconds: number | undefined): string {
  if (seconds === undefined) return "automatically";
  if (seconds < 90) return "automatically in about a minute";
  return `automatically in about ${Math.round(seconds / 60)} minutes`;
}

/** Why automatic provisioning stopped for good (until KalCode restarts), in owner terms. */
export function stoppedReason(reason: string | undefined): string {
  switch (reason) {
    case "components_unsupported":
      return "KalVoice components aren't available for this system";
    case "consent_required":
      return "Downloading this component needs your permission first";
    default:
      return "Couldn't verify KalVoice components. Try again later";
  }
}

/** Where every automatic download comes from (disclosed while it runs). */
export const SIGNED_CATALOG = "KalCode's signed component catalog";

/** "English (fastest)" → "English": the language, for disclosure sentences. */
function modelLanguage(displayName: string): string {
  return displayName.replace(/\s*\(.*\)\s*$/u, "");
}

/** Why a download attempt failed, in owner terms (the safe code otherwise). */
export function failureReason(reason: string | undefined): string {
  switch (reason) {
    case "component_catalog_unavailable":
      return "KalCode's component catalog couldn't be reached";
    case "component_acquisition_failed":
      return "the download didn't complete";
    case "resource_capacity_unavailable":
      return "this computer didn't have room for it yet";
    case "component_storage_failed":
      return "KalCode's component storage wasn't available";
    default:
      return reason ? `the download stopped (${reason})` : "the download stopped";
  }
}

/** Push to talk while its speech model is being prepared: truthful, never "Ready" early. */
function speechNotReady(status: KalVoiceStatus): {
  code: "model_preparing" | "model_unavailable";
  label: string;
  message: string;
  attention: boolean;
} | null {
  const item = speechProvisioning(status);
  const info = item ? status.models.find((m) => m.id === item.modelId) : undefined;
  const model = item ? (info?.displayName ?? item.modelId) : null;
  if (!item) {
    const fallback = status.models.find((m) => m.id === status.preferences.speechModel) ?? status.models[0];
    const size = fallback ? ` (${formatBytes(fallback.sizeBytes)})` : "";
    return status.preferences.speechModelAutoDownload
      ? {
          code: "model_preparing",
          label: "Preparing speech",
          message: `Downloading the English speech model${size} from ${SIGNED_CATALOG}… It is downloaded once and verified before use.`,
          attention: false,
        }
      : null;
  }
  const size = item.totalBytes > 0 ? formatBytes(item.totalBytes) : info ? formatBytes(info.sizeBytes) : null;
  const what = `the ${modelLanguage(model ?? "")} speech model${size ? ` (${size})` : ""}`;
  const percent = item.totalBytes > 0 ? Math.min(100, Math.floor((item.receivedBytes / item.totalBytes) * 100)) : 0;
  switch (item.phase) {
    case "preparing":
      return {
        code: "model_preparing",
        label: "Preparing speech",
        message: `Downloading ${what} from ${SIGNED_CATALOG}… It is downloaded once and verified before use.`,
        attention: false,
      };
    case "downloading":
      return {
        code: "model_preparing",
        label: `Preparing speech ${percent}%`,
        message: `Downloading ${what} from ${SIGNED_CATALOG}… ${formatBytes(item.receivedBytes)} so far. Push to talk works when it's ready.`,
        attention: false,
      };
    case "verifying":
      return {
        code: "model_preparing",
        label: "Verifying speech",
        message: `Checking the ${model} speech model's signature and checksum before using it.`,
        attention: false,
      };
    case "waiting_for_resources":
      return {
        code: "model_preparing",
        label: "Waiting for system resources",
        message: `The ${model} speech model downloads when ${waitingReason(item.reason)}.`,
        attention: false,
      };
    case "waiting_for_talk":
      return {
        code: "model_preparing",
        label: "Preparing speech",
        message: `The ${model} speech model download continues when push to talk is released.`,
        attention: false,
      };
    case "paused":
      return {
        code: "model_unavailable",
        label: "Paused",
        message: `The ${model} speech model download is paused. Resume it in Settings, KalVoice.`,
        attention: true,
      };
    case "retry_scheduled":
      return {
        code: "model_unavailable",
        label: "Speech unavailable",
        message: `Couldn't get the ${model} speech model: ${failureReason(item.reason)}. KalCode retries ${retryWhen(item.retryInSeconds)}, and when you return to KalCode.`,
        attention: true,
      };
    case "unavailable":
      return {
        code: "model_unavailable",
        label: "Speech unavailable",
        message: `${stoppedReason(item.reason)}. You can still download a speech model in Settings, KalVoice.`,
        attention: true,
      };
  }
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
    const preparing = speechNotReady(current);
    if (preparing) {
      return not(
        preparing.code,
        preparing.label,
        preparing.message,
        preparing.code === "model_unavailable" ? "settings" : null,
        preparing.attention,
      );
    }
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
