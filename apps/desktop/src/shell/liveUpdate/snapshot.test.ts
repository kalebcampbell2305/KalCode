import { afterEach, describe, expect, it } from "vitest";
import { holdLiveReload, liveReloadHeld, resetLiveReloadHolds, whileHoldingLiveReload } from "./hold.ts";
import { pageLoadKind, resetPageLoadKind, windowSet } from "./pageLoad.ts";
import {
  captureSnapshot,
  HANDOFF_KEY,
  RELOAD_KEY,
  restoreDrafts,
  SNAPSHOT_MAX_AGE_MS,
  saveSnapshot,
  takeSnapshot,
} from "./snapshot.ts";

const ALICE = "acct_alice";
const BOB = "acct_bob";

afterEach(() => {
  document.body.innerHTML = "";
  sessionStorage.clear();
  localStorage.clear();
  resetLiveReloadHolds();
  resetPageLoadKind();
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
    const snapshot = captureSnapshot(ALICE, "code");
    expect(snapshot.viewer).toBe(ALICE);
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
    saveSnapshot(RELOAD_KEY, { version: 2, viewer: ALICE, savedAt: Date.now(), destination: "settings", drafts: [] });
    expect(takeSnapshot(ALICE)?.destination).toBe("settings");
    expect(takeSnapshot(ALICE)).toBeNull();

    saveSnapshot(HANDOFF_KEY, {
      version: 2,
      viewer: ALICE,
      savedAt: Date.now() - SNAPSHOT_MAX_AGE_MS - 1,
      destination: "code",
      drafts: [],
    });
    expect(takeSnapshot(ALICE)).toBeNull();

    localStorage.setItem(HANDOFF_KEY, "{oops");
    expect(takeSnapshot(ALICE)).toBeNull();
  });

  it("never restores one account's drafts into another account (A to B after a handoff)", () => {
    // A handoff saved Alice's unsent text; her session expired and Bob signed in within minutes.
    saveSnapshot(HANDOFF_KEY, {
      version: 2,
      viewer: ALICE,
      savedAt: Date.now(),
      destination: "threads",
      drafts: [{ key: "textarea:Message the agent#0", value: "alice's private draft" }],
    });
    expect(takeSnapshot(BOB)).toBeNull();
    // Discarded, not kept for later: Alice signing back in doesn't resurrect it either.
    expect(takeSnapshot(ALICE)).toBeNull();
  });

  it("discards snapshots saved before drafts were bound to an account", () => {
    localStorage.setItem(
      HANDOFF_KEY,
      JSON.stringify({ version: 1, savedAt: Date.now(), destination: "code", drafts: [{ key: "k#0", value: "v" }] }),
    );
    expect(takeSnapshot(ALICE)).toBeNull();
    expect(localStorage.getItem(HANDOFF_KEY)).toBeNull();
  });

  it("prefers the newest of a reload and a handoff snapshot", () => {
    const now = Date.now();
    saveSnapshot(HANDOFF_KEY, { version: 2, viewer: ALICE, savedAt: now - 5000, destination: "code", drafts: [] });
    saveSnapshot(RELOAD_KEY, { version: 2, viewer: ALICE, savedAt: now, destination: "dashboard", drafts: [] });
    expect(takeSnapshot(ALICE, now)?.destination).toBe("dashboard");
  });
});

describe("live reload hold", () => {
  it("holds while any submission is in flight and releases once each settles", async () => {
    expect(liveReloadHeld()).toBe(false);
    const release = holdLiveReload();
    let finish: () => void = () => undefined;
    const create = whileHoldingLiveReload(() => new Promise<void>((resolve) => (finish = resolve)));
    release();
    release(); // idempotent
    expect(liveReloadHeld()).toBe(true);
    finish();
    await create;
    expect(liveReloadHeld()).toBe(false);
  });

  it("releases when the submission fails", async () => {
    await expect(whileHoldingLiveReload(() => Promise.reject(new Error("offline")))).rejects.toThrow("offline");
    expect(liveReloadHeld()).toBe(false);
  });
});

describe("page load kind", () => {
  it("is cold on the first load of a window and a reload afterwards", () => {
    expect(pageLoadKind()).toBe("cold");
    expect(pageLoadKind()).toBe("cold"); // decided once per page
    resetPageLoadKind(); // the page reloads; sessionStorage survives
    expect(pageLoadKind()).toBe("reload");
    sessionStorage.clear(); // a new KalCode process starts with empty sessionStorage
    resetPageLoadKind();
    expect(pageLoadKind()).toBe("cold");
  });
});

describe("window set", () => {
  it("survives a renderer reload and is empty in a new process", () => {
    const attempted = windowSet("restore-attempted");
    attempted.add("thread_1");
    attempted.add("thread_2");
    attempted.delete("thread_2");
    // The page reloads: a new set reads what this window already tried.
    const afterReload = windowSet("restore-attempted");
    expect(afterReload.has("thread_1")).toBe(true);
    expect(afterReload.has("thread_2")).toBe(false);
    sessionStorage.clear(); // a new KalCode process
    expect(windowSet("restore-attempted").has("thread_1")).toBe(false);
  });

  it("keeps only the newest ids up to its limit", () => {
    const set = windowSet("bounded", 2);
    for (const id of ["a", "b", "c"]) set.add(id);
    const reread = windowSet("bounded", 2);
    expect(["a", "b", "c"].filter((id) => reread.has(id))).toEqual(["b", "c"]);
  });
});
