import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createDraftStore,
  DRAFT_STORAGE_KEY,
  type DraftClearResult,
  type DraftScope,
  draftStorageKey,
  usePersistentDraft,
} from "./drafts.ts";

const thread = (viewerId: string, workspaceId: string, threadId: string): DraftScope => ({
  kind: "thread",
  viewerId,
  workspaceId,
  threadId,
});

const newThread = (viewerId: string, workspaceId: string): DraftScope => ({
  kind: "new-thread",
  viewerId,
  workspaceId,
});

function clearDraftStorage() {
  for (let index = localStorage.length - 1; index >= 0; index -= 1) {
    const key = localStorage.key(index);
    if (key?.startsWith(DRAFT_STORAGE_KEY)) localStorage.removeItem(key);
  }
}

beforeEach(clearDraftStorage);
afterEach(clearDraftStorage);

describe("restart-safe drafts", () => {
  it("reloads text while isolating accounts, workspaces, thread composers and the new-thread form", () => {
    const first = createDraftStore(() => localStorage);
    expect(first.write(thread("viewer-a", "workspace-a", "thread-a"), "unsent reply").ok).toBe(true);
    expect(first.write(newThread("viewer-a", "workspace-a"), "new task").ok).toBe(true);

    const afterRestart = createDraftStore(() => localStorage);
    expect(afterRestart.read(thread("viewer-a", "workspace-a", "thread-a")).text).toBe("unsent reply");
    expect(afterRestart.read(newThread("viewer-a", "workspace-a")).text).toBe("new task");
    expect(afterRestart.read(thread("viewer-b", "workspace-a", "thread-a")).text).toBe("");
    expect(afterRestart.read(thread("viewer-a", "workspace-b", "thread-a")).text).toBe("");
    expect(afterRestart.read(thread("viewer-a", "workspace-a", "thread-b")).text).toBe("");
    expect(localStorage.getItem(draftStorageKey("viewer-a"))).not.toBeNull();
    expect(localStorage.getItem(draftStorageKey("viewer-b"))).toBeNull();
  });

  it("drops corrupted records, removes empty drafts and keeps the app usable when profile storage fails", () => {
    localStorage.setItem(draftStorageKey("viewer"), "{broken");
    const store = createDraftStore(() => localStorage);
    const scope = thread("viewer", "workspace", "thread");
    expect(store.read(scope)).toEqual({ text: "", problem: expect.objectContaining({ code: "corrupt" }) });
    expect(store.write(scope, "retry this").ok).toBe(true);
    expect(store.write(scope, "").ok).toBe(true);
    expect(store.read(scope)).toEqual({ text: "", problem: null });

    const unavailable = createDraftStore(() => {
      throw new Error("profile unavailable");
    });
    expect(unavailable.read(scope)).toEqual({ text: "", problem: expect.objectContaining({ code: "unavailable" }) });
    expect(unavailable.write(scope, "still visible in React state")).toEqual({
      ok: false,
      problem: expect.objectContaining({ code: "unavailable" }),
    });
  });

  it("replaces the store with an empty envelope when removal fails and reports a total cleanup failure", () => {
    const scope = thread("viewer", "workspace", "thread");
    const values = new Map<string, string>();
    const removeBlocked = createDraftStore(() => ({
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: () => {
        throw new Error("removal blocked");
      },
    }));
    expect(removeBlocked.write(scope, "sent text").ok).toBe(true);
    expect(removeBlocked.write(scope, "")).toEqual({ ok: true, problem: null });
    expect(removeBlocked.read(scope)).toEqual({ text: "", problem: null });

    const cleanupBlocked = createDraftStore(() => ({
      getItem: (key: string) => values.get(key) ?? null,
      setItem: () => {
        throw new Error("write blocked");
      },
      removeItem: () => {
        throw new Error("removal blocked");
      },
    }));
    expect(cleanupBlocked.write(scope, "")).toEqual({
      ok: false,
      problem: expect.objectContaining({ code: "unavailable" }),
    });
  });

  it("bounds persisted text and total entries without throwing or retaining the oldest draft", () => {
    const store = createDraftStore(() => localStorage);
    const oldest = thread("viewer", "workspace", "thread-0");
    expect(store.write(oldest, "oldest").ok).toBe(true);
    for (let index = 1; index <= 100; index += 1) {
      expect(store.write(thread("viewer", "workspace", `thread-${index}`), `draft ${index}`).ok).toBe(true);
    }
    expect(store.read(oldest).text).toBe("");
    expect(store.read(thread("viewer", "workspace", "thread-100")).text).toBe("draft 100");
    expect(store.write(thread("viewer", "workspace", "oversized"), "x".repeat(65_537))).toEqual({
      ok: false,
      problem: expect.objectContaining({ code: "too_large" }),
    });
    expect(store.read(thread("viewer", "workspace", "oversized")).text).toBe("");

    localStorage.removeItem(draftStorageKey("viewer"));
    for (let index = 0; index < 10; index += 1) {
      expect(store.write(thread("viewer", "workspace", `large-${index}`), `${index}${"x".repeat(60_000)}`).ok).toBe(
        true,
      );
    }
    expect(localStorage.getItem(draftStorageKey("viewer"))?.length).toBeLessThanOrEqual(524_288);
    expect(store.read(thread("viewer", "workspace", "large-0")).text).toBe("");
    expect(store.read(thread("viewer", "workspace", "large-9")).text).toHaveLength(60_001);
  });

  it("hydrates on remount, follows scope changes, and clears only the text that actually submitted", () => {
    const a = thread("viewer", "workspace", "thread-a");
    const b = thread("viewer", "workspace", "thread-b");
    const seeded = createDraftStore(() => localStorage);
    seeded.write(a, "restored a");
    seeded.write(b, "restored b");

    const { result, rerender, unmount } = renderHook(({ scope }) => usePersistentDraft(scope), {
      initialProps: { scope: a },
    });
    expect(result.current.text).toBe("restored a");
    act(() => result.current.setText("sending a"));
    act(() => result.current.setText("newer edit"));
    expect(result.current.clearSubmitted("sending a")).toEqual({ cleared: false, problem: null });
    expect(result.current.text).toBe("newer edit");

    rerender({ scope: b });
    expect(result.current.text).toBe("restored b");
    let cleared: DraftClearResult = { cleared: false, problem: null };
    act(() => {
      cleared = result.current.clearSubmitted("restored b");
    });
    expect(cleared).toEqual({ cleared: true, problem: null });
    expect(result.current.text).toBe("");

    unmount();
    const restored = renderHook(() => usePersistentDraft(a));
    expect(restored.result.current.text).toBe("newer edit");
  });

  it("keeps oversized text in the editor, explains that it is not restart-safe, and retries after an edit", () => {
    const scope = thread("viewer", "workspace", "thread-a");
    const { result } = renderHook(() => usePersistentDraft(scope));

    act(() => result.current.setText("x".repeat(65_537)));
    expect(result.current.text).toHaveLength(65_537);
    expect(result.current.problem).toEqual(expect.objectContaining({ code: "too_large" }));

    act(() => result.current.setText("safe to persist"));
    expect(result.current.problem).toBeNull();
    expect(createDraftStore(() => localStorage).read(scope).text).toBe("safe to persist");
  });
});
