import type { KalVoiceStatus } from "@kalcode/protocol";
import { describe, expect, it } from "vitest";
import { createMemoryKalVoice } from "../ipc/memoryKalVoice.ts";
import { pushToTalkReadiness } from "./readiness.ts";

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
    expect(pushToTalkReadiness(status({ activeModel: null }), null)).toMatchObject({
      ready: false,
      code: "model_not_installed",
      fix: "settings",
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
});
