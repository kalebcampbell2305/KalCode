import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type ComposerHandle,
  composerForElement,
  composerForThread,
  registerComposer,
  resetComposerRegistryForTests,
  voiceTargetLabel,
  waitForComposer,
} from "./composerRegistry.ts";
import { insertTranscript, reconnectTarget, resolveDictationTarget, targetIsAlive } from "./dictation.ts";

const A = "0192f3c4-0000-7000-8000-00000000c0a1";
const B = "0192f3c4-0000-7000-8000-00000000c0b2";

/** A thread composer's text box as ThreadDetail renders it: every thread uses the same DOM id. */
function mountComposer(threadId: string, name: string) {
  const element = document.createElement("textarea");
  element.id = "thread-composer";
  document.body.append(element);
  const handle: ComposerHandle = {
    threadId,
    identity: () => ({
      threadId,
      threadName: name,
      providerId: "claude-code",
      providerName: "Claude Code",
      accountLabel: "Work",
    }),
    element: () => element,
    mode: () => "send",
    blockedReason: () => null,
    hasText: () => element.value.trim() !== "",
    submit: vi.fn(async () => "sent" as const),
    clear: () => {
      element.value = "";
    },
  };
  const unregister = registerComposer(handle);
  return {
    element,
    handle,
    unmount: () => {
      unregister();
      element.remove();
    },
  };
}

afterEach(() => {
  resetComposerRegistryForTests();
  document.body.replaceChildren();
});

describe("composer registry (TK-2)", () => {
  it("resolves a focused composer as a target bound to its thread, not a plain field", () => {
    const a = mountComposer(A, "Authentication");
    const target = resolveDictationTarget(a.element);
    expect(target?.kind).toBe("composer");
    expect(target?.kind === "composer" && target.composer.handle.threadId).toBe(A);
    expect(composerForElement(a.element)?.handle.threadId).toBe(A);
    expect(composerForThread(A)?.handle).toBe(a.handle);
  });

  it("inserts at the caret of that composer only", async () => {
    const a = mountComposer(A, "Authentication");
    a.element.value = "Review";
    a.element.setSelectionRange(6, 6);
    const target = resolveDictationTarget(a.element);
    if (!target) throw new Error("no target");
    await expect(insertTranscript(target, "the login failure")).resolves.toBe(18);
    expect(a.element.value).toBe("Review the login failure");
  });

  it("never reconnects a composer target to another thread's composer with the same DOM id (Type it instead)", () => {
    const a = mountComposer(A, "Authentication");
    const target = resolveDictationTarget(a.element);
    if (!target) throw new Error("no target");
    // Navigation: thread A's composer unmounts and thread B's (same id) is on screen now.
    a.unmount();
    const b = mountComposer(B, "Billing");
    expect(targetIsAlive(target)).toBe(false);
    expect(document.getElementById("thread-composer")).toBe(b.element);
    expect(reconnectTarget(target)).toBeNull();

    // Thread A shown again: the target follows A's own registration.
    const again = mountComposer(A, "Authentication");
    const reconnected = reconnectTarget(target);
    expect(reconnected?.element).toBe(again.element);
    expect(reconnected?.element).not.toBe(b.element);
  });

  it("never lets a plain field target stand in for a composer found by id", () => {
    const field = document.createElement("textarea");
    field.id = "thread-composer";
    document.body.append(field);
    const target = resolveDictationTarget(field);
    expect(target?.kind).toBe("field");
    field.remove();
    mountComposer(B, "Billing");
    if (!target) throw new Error("no target");
    expect(reconnectTarget(target)).toBeNull();
  });

  it("a remount of the same thread is a new registration; the old one is dead", () => {
    const first = mountComposer(A, "Authentication");
    const target = resolveDictationTarget(first.element);
    if (!target) throw new Error("no target");
    first.unmount();
    mountComposer(A, "Authentication");
    expect(targetIsAlive(target)).toBe(false);
  });

  it("waits for a thread's composer to mount, and gives up after the timeout", async () => {
    const waiting = waitForComposer(A, { timeoutMs: 1000 });
    setTimeout(() => mountComposer(A, "Authentication"), 10);
    expect((await waiting)?.handle.threadId).toBe(A);
    await expect(waitForComposer(B, { timeoutMs: 30 })).resolves.toBeNull();
  });

  it("labels the target as text: provider, thread, then the account when there is one", () => {
    const identity = {
      threadId: A,
      threadName: "Authentication",
      providerId: "claude-code",
      providerName: "Claude Code",
    };
    expect(voiceTargetLabel({ ...identity, accountLabel: "Work" })).toBe(
      "KALVOICE TARGET · Claude Code · Authentication · Work",
    );
    expect(voiceTargetLabel({ ...identity, accountLabel: null })).toBe(
      "KALVOICE TARGET · Claude Code · Authentication",
    );
  });
});
