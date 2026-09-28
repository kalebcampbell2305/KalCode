import type { ComponentProvisioning, KalVoiceStatus } from "@kalcode/protocol";
import { describe, expect, it } from "vitest";
import { createMemoryKalVoice } from "../ipc/memoryKalVoice.ts";
import { pushToTalkReadiness, withTalkKeyState } from "./readiness.ts";

function status(patch: Partial<KalVoiceStatus> = {}): KalVoiceStatus {
  const voice = createMemoryKalVoice(() => undefined, "");
  return { ...(voice.handlers.kalvoice_status?.({}) as KalVoiceStatus), ...patch };
}

describe("push-to-talk readiness is derived only from native status", () => {
  it("is Ready only when the key is registered, enabled, and a speech model is active", () => {
    const ready = pushToTalkReadiness(status(), null);
    expect(ready).toMatchObject({ ready: true, label: "Ready" });
    expect(ready.message).toBe("Hold F8 to talk to KalVoice.");
  });

  it("never claims Ready while the talk key is not registered", () => {
    const r = pushToTalkReadiness(status({ talkKeyActive: false }), null);
    expect(r.ready).toBe(false);
    expect(r.label).not.toBe("Ready");
    expect(r.code).toBe("talk_key_inactive");
    expect(r.message).toContain("F8");
    expect(r.message).toMatch(/isn't registered/);
  });

  it("shows the exact OS registration failure for the talk key", () => {
    const r = pushToTalkReadiness(
      status({
        talkKeyActive: false,
        shortcutIssues: [
          { mode: "talk", accelerator: "F8", message: "Another app is using this key. Choose a different one." },
        ],
      }),
      null,
    );
    expect(r).toMatchObject({ ready: false, code: "talk_key_unavailable", fix: "settings" });
    expect(r.message).toBe("F8 unavailable: Another app is using this key. Choose a different one.");
  });

  it("reports push to talk switched off, a missing model, missing engine and unsupported microphone", () => {
    const base = status();
    expect(
      pushToTalkReadiness(status({ preferences: { ...base.preferences, talkEnabled: false } }), null),
    ).toMatchObject({ ready: false, code: "talk_disabled", fix: "settings" });
    // The owner removed the model (opt-out): Settings keeps the manual download.
    expect(
      pushToTalkReadiness(
        status({ activeModel: null, preferences: { ...base.preferences, speechModelAutoDownload: false } }),
        null,
      ),
    ).toMatchObject({
      ready: false,
      code: "model_not_installed",
      fix: "settings",
    });
    // Zero setup: with no opt-out, a missing model is being prepared, not a setup chore.
    expect(pushToTalkReadiness(status({ activeModel: null }), null)).toMatchObject({
      ready: false,
      code: "model_preparing",
      label: "Preparing speech",
      fix: null,
      attention: false,
    });
    expect(pushToTalkReadiness(status({ speechEngine: false }), null)).toMatchObject({
      ready: false,
      code: "speech_engine_unavailable",
    });
    expect(pushToTalkReadiness(status({ microphoneSupported: false }), null)).toMatchObject({
      ready: false,
      code: "microphone_unsupported",
    });
  });

  it("does not claim readiness when status could not be read", () => {
    const r = pushToTalkReadiness(null, { message: "KalVoice is starting." });
    expect(r).toMatchObject({ ready: false, code: "status_unavailable", fix: "retry" });
    expect(r.message).toContain("KalVoice is starting.");
    expect(pushToTalkReadiness(null, null)).toMatchObject({ ready: false, code: "checking" });
  });

  it("is not Ready while signals aren't connected, even with a perfect status", () => {
    const r = pushToTalkReadiness(status(), null, { message: "KalVoice is starting." });
    expect(r).toMatchObject({ ready: false, code: "signals_unavailable", label: "Not connected", fix: "retry" });
    expect(r.message).toContain("KalVoice is starting.");
  });

  it("an older Ready status is Unverified once a refresh fails", () => {
    const r = pushToTalkReadiness(status(), { message: "Runtime restarting." });
    expect(r).toMatchObject({ ready: false, code: "status_unverified", label: "Unverified", fix: "retry" });
  });
});

describe("native talk_key signal", () => {
  const key = (active: boolean, reason: string | null) => ({ active, reason, accelerator: "F8" });

  it("overrides what an older status read said about the key", () => {
    const before = status({ talkKeyActive: false });
    const after = withTalkKeyState(before, key(true, null));
    expect(after).toMatchObject({ talkKeyActive: true, shortcutIssues: [], usage: before.usage });
    expect(pushToTalkReadiness(before, null, null, key(true, null))).toMatchObject({ ready: true, label: "Ready" });
    expect(withTalkKeyState(null, key(true, null))).toBeNull();
  });

  it("maps every native reason to exact copy, a fix, and whether it is a problem", () => {
    const r = (reason: string) => pushToTalkReadiness(status(), null, null, key(false, reason));
    expect(r("os_refused")).toMatchObject({
      code: "talk_key_unavailable",
      message: "F8 unavailable: Another app is using this key. Choose a different one.",
      fix: "settings",
      attention: true,
    });
    expect(r("unparseable")).toMatchObject({
      code: "talk_key_unavailable",
      message: "F8 unavailable: KalCode couldn't read F8. Choose a different key.",
      fix: "settings",
      attention: true,
    });
    expect(r("disabled")).toMatchObject({ code: "talk_disabled", label: "Off", fix: "settings" });
    expect(r("prefs_error")).toMatchObject({ code: "talk_key_unregistered", fix: "retry", attention: true });
    expect(r("shutting_down")).toMatchObject({ code: "shutting_down", attention: false });
    expect(r("not_connected")).toMatchObject({
      code: "talk_key_connecting",
      label: "Connecting",
      fix: null,
      attention: false,
    });
    expect(r("mystery")).toMatchObject({ code: "talk_key_inactive", attention: true });
  });

  it("KalCode in the background is expected: not an error, and never claimed Ready", () => {
    const r = pushToTalkReadiness(status(), null, null, key(false, "not_focused"));
    expect(r).toMatchObject({
      ready: false,
      code: "talk_key_not_focused",
      label: "Ready when in front",
      message: "F8 works while KalCode is the active window.",
      fix: null,
      attention: false,
    });
  });

  it("an OS refusal keeps other modes' issues and replaces only the talk key's", () => {
    const other = { mode: "command" as const, accelerator: "F9", message: "Taken." };
    const after = withTalkKeyState(
      status({ shortcutIssues: [other, { mode: "talk", accelerator: "F8", message: "old" }] }),
      key(true, null),
    );
    expect(after?.shortcutIssues).toEqual([other]);
  });
});

describe("push to talk while its speech model is prepared automatically", () => {
  const item = (patch: Partial<ComponentProvisioning>): ComponentProvisioning => ({
    modelId: "tiny.en",
    automatic: true,
    phase: "downloading",
    receivedBytes: 31_000_000,
    totalBytes: 77_704_715,
    ...patch,
  });
  const preparing = (patch: Partial<ComponentProvisioning>) =>
    pushToTalkReadiness(status({ activeModel: null, provisioning: [item(patch)] }), null);

  it("shows download progress, then verification, and never Ready before the model is active", () => {
    const downloading = preparing({});
    expect(downloading).toMatchObject({ ready: false, code: "model_preparing", label: "Preparing speech 39%" });
    // First-run disclosure: what is downloading, its size, and where it comes from.
    expect(downloading.message).toMatch(
      /^Downloading the English speech model \(78 MB\) from KalCode's signed component catalog… 31 MB so far\./,
    );
    expect(downloading.attention).toBe(false);
    expect(preparing({ phase: "verifying", receivedBytes: 77_704_715 })).toMatchObject({
      ready: false,
      label: "Verifying speech",
    });
    expect(preparing({ phase: "preparing", receivedBytes: 0 }).label).toBe("Preparing speech");
    // Even with the key registered, no active model is never Ready.
    const registered = pushToTalkReadiness(
      status({ activeModel: null, talkKeyActive: true, provisioning: [item({ phase: "verifying" })] }),
      null,
      null,
      { active: true, reason: null, accelerator: "F8" },
    );
    expect(registered.ready).toBe(false);
  });

  it("says when it is waiting for system resources or for push to talk", () => {
    expect(preparing({ phase: "waiting_for_resources", reason: "disk_space" })).toMatchObject({
      label: "Waiting for system resources",
      message: "The English (fastest) speech model downloads when enough disk space is free.",
      attention: false,
    });
    expect(preparing({ phase: "waiting_for_talk", reason: "push_to_talk" }).message).toMatch(
      /continues when push to talk is released/,
    );
  });

  it("reports an unavailable download with its reason and the automatic retry", () => {
    const failed = preparing({
      phase: "retry_scheduled",
      reason: "component_catalog_unavailable",
      retryInSeconds: 300,
    });
    expect(failed).toMatchObject({
      ready: false,
      code: "model_unavailable",
      label: "Speech unavailable",
      fix: "settings",
      attention: true,
    });
    expect(failed.message).toMatch(/catalog couldn't be reached/);
    expect(failed.message).toMatch(/retries automatically in about 5 minutes, and when you return to KalCode/);
  });

  it("is Ready once the model is installed and active", () => {
    expect(pushToTalkReadiness(status({ provisioning: [] }), null).ready).toBe(true);
  });
});

describe("first-run disclosure and permanent failures", () => {
  it("discloses the automatic download before it starts, with size and source", () => {
    const pending = pushToTalkReadiness(status({ activeModel: null, provisioning: [] }), null);
    expect(pending.message).toBe(
      "Downloading the English speech model (78 MB) from KalCode's signed component catalog… It is downloaded once and verified before use.",
    );
  });

  it("stops with a truthful reason instead of promising a retry", () => {
    for (const [reason, text] of [
      ["components_unsupported", "KalVoice components aren't available for this system"],
      ["components_unverified", "Couldn't verify KalVoice components. Try again later"],
      ["consent_required", "Downloading this component needs your permission first"],
    ] as const) {
      const stopped = pushToTalkReadiness(
        status({
          activeModel: null,
          provisioning: [
            { modelId: "tiny.en", automatic: true, phase: "unavailable", reason, receivedBytes: 0, totalBytes: 0 },
          ],
        }),
        null,
      );
      expect(stopped).toMatchObject({ ready: false, code: "model_unavailable", fix: "settings", attention: true });
      expect(stopped.message).toContain(text);
      expect(stopped.message).not.toMatch(/retries/);
    }
  });
});
