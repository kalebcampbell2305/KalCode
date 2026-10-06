import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { PromptReview } from "../ipc/context.ts";
import { liveReloadHeld, resetLiveReloadHolds } from "../shell/liveUpdate/hold.ts";
import { usePromptConfirmation } from "./usePromptConfirmation.ts";

const warning: PromptReview = {
  kind: "confirmation_required",
  warning: { reviewId: "opaque-review-id", detectors: { password_assignment: 1 } },
};

function operation(review: () => Promise<PromptReview>, effect = vi.fn(async () => "sent")) {
  return {
    review,
    effect,
    onComplete: vi.fn(),
    onError: vi.fn(),
  };
}

describe("usePromptConfirmation", () => {
  it("runs a clean operation immediately without manufacturing a confirmation", async () => {
    const authority = { cancelPromptReview: vi.fn(async () => true) };
    const clean = operation(async () => ({ kind: "clean" }));
    const { result } = renderHook(() => usePromptConfirmation("account:target", authority));

    await act(async () => result.current.request(clean));

    expect(clean.effect).toHaveBeenCalledWith(null);
    expect(clean.onComplete).toHaveBeenCalledWith("sent");
    expect(result.current.warning).toBeNull();
  });

  it("waits for explicit confirmation and uses the opaque review id once", async () => {
    const authority = { cancelPromptReview: vi.fn(async () => true) };
    const warned = operation(async () => warning);
    const { result } = renderHook(() => usePromptConfirmation("account:target", authority));

    await act(async () => result.current.request(warned));
    expect(result.current.warning).toEqual({ detectors: { password_assignment: 1 } });
    expect(warned.effect).not.toHaveBeenCalled();

    await act(async () => result.current.confirm());
    await act(async () => result.current.confirm());
    expect(warned.effect).toHaveBeenCalledTimes(1);
    expect(warned.effect).toHaveBeenCalledWith("opaque-review-id");
    expect(warned.onComplete).toHaveBeenCalledTimes(1);
    expect(authority.cancelPromptReview).not.toHaveBeenCalled();
  });

  it("coalesces duplicate submissions before React publishes the busy state", async () => {
    let resolveReview!: (review: PromptReview) => void;
    const review = vi.fn(
      () =>
        new Promise<PromptReview>((resolve) => {
          resolveReview = resolve;
        }),
    );
    const pending = operation(review);
    const authority = { cancelPromptReview: vi.fn(async () => true) };
    const { result } = renderHook(() => usePromptConfirmation("account:target", authority));

    let first!: Promise<void>;
    let duplicate!: Promise<void>;
    act(() => {
      first = result.current.request(pending);
      duplicate = result.current.request(pending);
    });
    resolveReview(warning);
    await act(async () => Promise.all([first, duplicate]));

    expect(review).toHaveBeenCalledTimes(1);
    expect(result.current.warning).not.toBeNull();
  });

  it("invalidates pending confirmation on cancel, scope change, and authority replacement", async () => {
    const firstAuthority = { cancelPromptReview: vi.fn(async () => true) };
    const secondAuthority = { cancelPromptReview: vi.fn(async () => true) };
    const warned = operation(async () => warning);
    const { result, rerender } = renderHook(({ scope, authority }) => usePromptConfirmation(scope, authority), {
      initialProps: { scope: "account:target", authority: firstAuthority },
    });

    await act(async () => result.current.request(warned));
    act(() => result.current.cancel());
    await waitFor(() => expect(firstAuthority.cancelPromptReview).toHaveBeenCalledTimes(1));
    await act(async () => result.current.confirm());
    expect(warned.effect).not.toHaveBeenCalled();

    await act(async () => result.current.request(warned));
    rerender({ scope: "account:other-target", authority: firstAuthority });
    await waitFor(() => expect(result.current.warning).toBeNull());
    expect(firstAuthority.cancelPromptReview).toHaveBeenCalledTimes(2);
    await act(async () => result.current.confirm());
    expect(warned.effect).not.toHaveBeenCalled();

    await act(async () => result.current.request(warned));
    rerender({ scope: "account:other-target", authority: secondAuthority });
    await waitFor(() => expect(result.current.warning).toBeNull());
    expect(firstAuthority.cancelPromptReview).toHaveBeenCalledTimes(3);
    expect(secondAuthority.cancelPromptReview).not.toHaveBeenCalled();
    await act(async () => result.current.confirm());
    expect(warned.effect).not.toHaveBeenCalled();
  });

  it("ignores a late review after its scope changes or the component unmounts", async () => {
    let resolveReview!: (review: PromptReview) => void;
    const review = new Promise<PromptReview>((resolve) => {
      resolveReview = resolve;
    });
    const delayed = operation(() => review);
    const authority = { cancelPromptReview: vi.fn(async () => true) };
    const { result, rerender, unmount } = renderHook(({ scope }) => usePromptConfirmation(scope, authority), {
      initialProps: { scope: "account:first" },
    });

    let request!: Promise<void>;
    act(() => {
      request = result.current.request(delayed);
    });
    rerender({ scope: "account:second" });
    resolveReview(warning);
    await act(async () => request);
    expect(result.current.warning).toBeNull();
    expect(delayed.effect).not.toHaveBeenCalled();
    expect(authority.cancelPromptReview).toHaveBeenCalledWith("opaque-review-id");

    let resolveUnmounted!: (review: PromptReview) => void;
    const unmountedReview = new Promise<PromptReview>((resolve) => {
      resolveUnmounted = resolve;
    });
    const afterUnmount = operation(() => unmountedReview);
    act(() => {
      request = result.current.request(afterUnmount);
    });
    unmount();
    resolveUnmounted(warning);
    await act(async () => request);
    expect(afterUnmount.effect).not.toHaveBeenCalled();
    expect(afterUnmount.onComplete).not.toHaveBeenCalled();
    expect(afterUnmount.onError).not.toHaveBeenCalled();
    expect(authority.cancelPromptReview).toHaveBeenCalledTimes(2);
  });
});

describe("usePromptConfirmation holds a live UI reload through the send", () => {
  function deferred() {
    let resolve!: (value: string) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<string>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  it("holds a clean send from its effect until its completion has run", async () => {
    resetLiveReloadHolds();
    const send = deferred();
    const heldAtComplete: boolean[] = [];
    const clean = operation(
      async () => ({ kind: "clean" }),
      vi.fn(() => send.promise),
    );
    clean.onComplete = vi.fn(() => heldAtComplete.push(liveReloadHeld()));
    const authority = { cancelPromptReview: vi.fn(async () => true) };
    const { result } = renderHook(() => usePromptConfirmation("account:target", authority));

    let request!: Promise<void>;
    act(() => {
      request = result.current.request(clean);
    });
    await waitFor(() => expect(clean.effect).toHaveBeenCalled());
    expect(liveReloadHeld()).toBe(true);
    await act(async () => {
      send.resolve("sent");
      await request;
    });
    // Still held while onComplete cleared the composer; released only afterwards.
    expect(heldAtComplete).toEqual([true]);
    expect(liveReloadHeld()).toBe(false);
  });

  it("holds the confirmed send that runs after the warning closes, not just the review", async () => {
    resetLiveReloadHolds();
    const send = deferred();
    const warned = operation(
      async () => warning,
      vi.fn(() => send.promise),
    );
    const authority = { cancelPromptReview: vi.fn(async () => true) };
    const { result } = renderHook(() => usePromptConfirmation("account:target", authority));

    await act(async () => result.current.request(warned));
    // The warning is open: nothing is in flight, so a reload would only keep the unsent draft.
    expect(liveReloadHeld()).toBe(false);

    let confirming!: Promise<void>;
    act(() => {
      confirming = result.current.confirm();
    });
    expect(liveReloadHeld()).toBe(true);
    await act(async () => {
      send.resolve("sent");
      await confirming;
    });
    expect(warned.onComplete).toHaveBeenCalledWith("sent");
    expect(liveReloadHeld()).toBe(false);
  });

  it("releases the hold when the send fails", async () => {
    resetLiveReloadHolds();
    const send = deferred();
    const clean = operation(
      async () => ({ kind: "clean" }),
      vi.fn(() => send.promise),
    );
    const authority = { cancelPromptReview: vi.fn(async () => true) };
    const { result } = renderHook(() => usePromptConfirmation("account:target", authority));
    let request!: Promise<void>;
    act(() => {
      request = result.current.request(clean);
    });
    await waitFor(() => expect(liveReloadHeld()).toBe(true));
    await act(async () => {
      send.reject(new Error("offline"));
      await request;
    });
    expect(clean.onError).toHaveBeenCalled();
    expect(liveReloadHeld()).toBe(false);
  });
});
