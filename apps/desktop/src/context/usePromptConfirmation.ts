import { useCallback, useEffect, useRef, useState } from "react";
import type { PromptReview, PromptWarning } from "../ipc/context.ts";

export interface PromptConfirmationRequest<T> {
  review: () => Promise<PromptReview>;
  effect: (reviewId: string | null) => Promise<T>;
  onComplete: (value: T) => void;
  onError: (error: unknown) => void;
}

interface PendingOperation {
  generation: number;
  reviewId: string;
  cancelReview: (reviewId: string) => Promise<boolean>;
  effect: (reviewId: string | null) => Promise<unknown>;
  onComplete: (value: unknown) => void;
  onError: (error: unknown) => void;
}

export type PromptWarningView = Pick<PromptWarning, "detectors">;

export interface PromptReviewAuthority {
  cancelPromptReview(reviewId: string): Promise<boolean>;
}

function abandonReview(authority: PromptReviewAuthority, reviewId: string) {
  void authority.cancelPromptReview(reviewId).catch(() => undefined);
}

function abandonPending(pending: PendingOperation | null) {
  if (pending) void pending.cancelReview(pending.reviewId).catch(() => undefined);
}

/**
 * Keeps a native prompt review volatile and one-shot. Changing authority or the exact operation
 * scope invalidates both pending reviews and late async results.
 */
export function usePromptConfirmation(scopeKey: string, authority: PromptReviewAuthority) {
  const mountedRef = useRef(true);
  const generationRef = useRef(0);
  const activeRef = useRef(false);
  const pendingRef = useRef<PendingOperation | null>(null);
  const [warning, setWarning] = useState<PromptWarningView | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      generationRef.current += 1;
      activeRef.current = false;
      abandonPending(pendingRef.current);
      pendingRef.current = null;
    };
  }, []);

  useEffect(() => {
    // Reading both identities documents and enforces the authority/scope invalidation boundary.
    void authority;
    void scopeKey;
    generationRef.current += 1;
    activeRef.current = false;
    abandonPending(pendingRef.current);
    pendingRef.current = null;
    setWarning(null);
    setBusy(false);
  }, [authority, scopeKey]);

  const cancel = useCallback(() => {
    generationRef.current += 1;
    activeRef.current = false;
    abandonPending(pendingRef.current);
    pendingRef.current = null;
    if (mountedRef.current) {
      setWarning(null);
      setBusy(false);
    }
  }, []);

  const request = useCallback(
    async <T>(operation: PromptConfirmationRequest<T>): Promise<void> => {
      if (activeRef.current) return;
      activeRef.current = true;
      const generation = ++generationRef.current;
      pendingRef.current = null;
      setWarning(null);
      setBusy(true);
      try {
        const review = await operation.review();
        if (!mountedRef.current || generation !== generationRef.current) {
          if (review.kind === "confirmation_required") abandonReview(authority, review.warning.reviewId);
          return;
        }
        if (review.kind === "confirmation_required") {
          pendingRef.current = {
            generation,
            reviewId: review.warning.reviewId,
            cancelReview: authority.cancelPromptReview.bind(authority),
            effect: operation.effect as (reviewId: string | null) => Promise<unknown>,
            onComplete: operation.onComplete as (value: unknown) => void,
            onError: operation.onError,
          };
          setWarning({ detectors: review.warning.detectors });
          setBusy(false);
          return;
        }
        const value = await operation.effect(null);
        if (!mountedRef.current || generation !== generationRef.current) return;
        activeRef.current = false;
        setBusy(false);
        operation.onComplete(value);
      } catch (error) {
        if (!mountedRef.current || generation !== generationRef.current) return;
        activeRef.current = false;
        setBusy(false);
        operation.onError(error);
      }
    },
    [authority],
  );

  const confirm = useCallback(async (): Promise<void> => {
    const pending = pendingRef.current;
    if (!pending || pending.generation !== generationRef.current) return;
    pendingRef.current = null;
    setWarning(null);
    setBusy(true);
    try {
      const value = await pending.effect(pending.reviewId);
      if (!mountedRef.current || pending.generation !== generationRef.current) return;
      activeRef.current = false;
      setBusy(false);
      pending.onComplete(value);
    } catch (error) {
      if (!mountedRef.current || pending.generation !== generationRef.current) return;
      activeRef.current = false;
      setBusy(false);
      pending.onError(error);
    }
  }, []);

  return { warning, busy, request, confirm, cancel };
}
