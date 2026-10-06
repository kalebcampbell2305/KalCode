import { afterEach, describe, expect, it } from "vitest";
import {
  captureSnapshot,
  HANDOFF_KEY,
  RELOAD_KEY,
  restoreDrafts,
  SNAPSHOT_MAX_AGE_MS,
  saveSnapshot,
  takeSnapshot,
} from "./snapshot.ts";

afterEach(() => {
  document.body.innerHTML = "";
  sessionStorage.clear();
  localStorage.clear();
});

describe("live update snapshot", () => {
  it("captures named drafts and skips terminals, secrets and empty fields", () => {
    document.body.innerHTML = `
      <textarea aria-label="Message the agent">fix the flaky test</textarea>
      <input id="search" value="needle" />
      <input type="password" id="secret" value="hunter2" />
      <div class="xterm"><textarea class="xterm-helper-textarea">ls</textarea></div>
      <textarea aria-label="Empty"></textarea>
      <textarea>no name</textarea>`;
    const snapshot = captureSnapshot("code");
    expect(snapshot.destination).toBe("code");
    expect(snapshot.drafts).toEqual([
      { key: "textarea:Message the agent#0", value: "fix the flaky test" },
      { key: "input:search#0", value: "needle" },
    ]);
  });

  it("restores drafts into fields that mount later, without overwriting new typing", async () => {
    const stop = restoreDrafts([
      { key: "textarea:Message the agent#0", value: "fix the flaky test" },
      { key: "input:search#0", value: "needle" },
    ]);
    const typed: string[] = [];
    document.body.innerHTML = `<input id="search" value="already typed" />`;
    const composer = document.createElement("textarea");
    composer.setAttribute("aria-label", "Message the agent");
    composer.addEventListener("input", () => typed.push(composer.value));
    document.body.append(composer);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(composer.value).toBe("fix the flaky test");
    expect(typed).toEqual(["fix the flaky test"]);
    expect((document.getElementById("search") as HTMLInputElement).value).toBe("already typed");
    stop();
  });

  it("round-trips through storage once and ignores stale or damaged snapshots", () => {
    saveSnapshot(RELOAD_KEY, { version: 1, savedAt: Date.now(), destination: "settings", drafts: [] });
    expect(takeSnapshot()?.destination).toBe("settings");
    expect(takeSnapshot()).toBeNull();

    saveSnapshot(HANDOFF_KEY, {
      version: 1,
      savedAt: Date.now() - SNAPSHOT_MAX_AGE_MS - 1,
      destination: "code",
      drafts: [],
    });
    expect(takeSnapshot()).toBeNull();

    localStorage.setItem(HANDOFF_KEY, "{oops");
    expect(takeSnapshot()).toBeNull();
  });

  it("prefers the newest of a reload and a handoff snapshot", () => {
    const now = Date.now();
    saveSnapshot(HANDOFF_KEY, { version: 1, savedAt: now - 5000, destination: "code", drafts: [] });
    saveSnapshot(RELOAD_KEY, { version: 1, savedAt: now, destination: "dashboard", drafts: [] });
    expect(takeSnapshot(now)?.destination).toBe("dashboard");
  });
});
