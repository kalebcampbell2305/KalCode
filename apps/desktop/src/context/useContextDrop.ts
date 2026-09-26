import type { ContextPreview, ThreadSummary } from "@kalcode/protocol";
import { useEffect, useRef, useState } from "react";
import type { ContextInput, ContextSendResult } from "../ipc/context.ts";
import { useRuntime } from "../runtime/RuntimeProvider.tsx";

export function useContextDrop(thread: ThreadSummary, onMutation?: () => void) {
  const { client } = useRuntime();
  const [inputs, setInputs] = useState<ContextInput[]>([]);
  const [preview, setPreview] = useState<ContextPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const previewRef = useRef<ContextPreview | null>(null);
  const targetKey = [thread.id, thread.workspaceId, thread.providerId, thread.providerAccountId ?? ""].join(":");
  // Async file pickers/native previews may resolve after navigation. Only the effect generation
  // that owns this exact target may publish state; every late preview is discarded natively.
  const targetRef = useRef(targetKey);
  const generationRef = useRef(0);
  const onMutationRef = useRef(onMutation);
  targetRef.current = targetKey;
  onMutationRef.current = onMutation;

  useEffect(() => {
    previewRef.current = preview;
  }, [preview]);

  useEffect(() => {
    // Bind this effect generation to the same target used by the render-time async fence above.
    targetRef.current = targetKey;
    const generation = ++generationRef.current;
    const previous = previewRef.current;
    previewRef.current = null;
    setInputs([]);
    setPreview(null);
    setBusy(false);
    if (previous) void client.discardContext(previous.packageId).catch(() => undefined);
    return () => {
      if (generationRef.current === generation) generationRef.current += 1;
      const current = previewRef.current;
      previewRef.current = null;
      if (current) void client.discardContext(current.packageId).catch(() => undefined);
    };
  }, [client, targetKey]);

  const rebuild = async (next: ContextInput[]) => {
    const generation = generationRef.current;
    const requestedTarget = targetKey;
    setBusy(true);
    try {
      const nextPreview = await client.createContextPreview(thread.id, next);
      if (generation !== generationRef.current || requestedTarget !== targetRef.current) {
        void client.discardContext(nextPreview.packageId).catch(() => undefined);
        return null;
      }
      const previous = previewRef.current;
      previewRef.current = nextPreview;
      setInputs(next);
      setPreview(nextPreview);
      if (previous) void client.discardContext(previous.packageId).catch(() => undefined);
      return nextPreview;
    } catch (error) {
      if (generation !== generationRef.current || requestedTarget !== targetRef.current) return null;
      throw error;
    } finally {
      if (generation === generationRef.current && requestedTarget === targetRef.current) setBusy(false);
    }
  };

  const addInput = (input: ContextInput) => {
    onMutationRef.current?.();
    return rebuild([...inputs, input]);
  };

  const addFiles = async () => {
    onMutationRef.current?.();
    const generation = generationRef.current;
    const requestedTarget = targetKey;
    setBusy(true);
    try {
      const picked = await client.pickContextFiles(thread.id);
      if (generation !== generationRef.current || requestedTarget !== targetRef.current) return 0;
      if (picked.length === 0) return 0;
      await rebuild([...inputs, ...picked.map(({ handle }) => ({ kind: "file", handle }) as const)]);
      return picked.length;
    } catch (error) {
      if (generation !== generationRef.current || requestedTarget !== targetRef.current) return 0;
      throw error;
    } finally {
      if (generation === generationRef.current && requestedTarget === targetRef.current) setBusy(false);
    }
  };

  const setIncluded = async (position: number, included: boolean) => {
    if (!preview) return;
    onMutationRef.current?.();
    const generation = generationRef.current;
    const requestedTarget = targetKey;
    setBusy(true);
    try {
      const next = await client.setContextItem(preview.packageId, position, included);
      if (generation !== generationRef.current || requestedTarget !== targetRef.current) return;
      previewRef.current = next;
      setPreview(next);
    } catch (error) {
      if (generation !== generationRef.current || requestedTarget !== targetRef.current) return;
      throw error;
    } finally {
      if (generation === generationRef.current && requestedTarget === targetRef.current) setBusy(false);
    }
  };

  const confirm = async (position: number) => {
    if (!preview) return;
    onMutationRef.current?.();
    const generation = generationRef.current;
    const requestedTarget = targetKey;
    setBusy(true);
    try {
      const next = await client.confirmContextItem(preview.packageId, position);
      if (generation !== generationRef.current || requestedTarget !== targetRef.current) return;
      previewRef.current = next;
      setPreview(next);
    } catch (error) {
      if (generation !== generationRef.current || requestedTarget !== targetRef.current) return;
      throw error;
    } finally {
      if (generation === generationRef.current && requestedTarget === targetRef.current) setBusy(false);
    }
  };

  const discard = async () => {
    onMutationRef.current?.();
    const current = previewRef.current;
    previewRef.current = null;
    setInputs([]);
    setPreview(null);
    if (current) await client.discardContext(current.packageId);
  };

  const send = async (text: string, promptReviewId?: string | null): Promise<ContextSendResult | null> => {
    const current = previewRef.current;
    if (!current) return null;
    const generation = generationRef.current;
    const requestedTarget = targetKey;
    setBusy(true);
    try {
      const result = await client.sendWithContext(
        current.packageId,
        thread.id,
        current.contentSha256,
        text,
        promptReviewId,
      );
      if (generation !== generationRef.current || requestedTarget !== targetRef.current) return null;
      if (result.kind === "stale") {
        previewRef.current = result.preview;
        setPreview(result.preview);
      } else {
        previewRef.current = null;
        setInputs([]);
        setPreview(null);
      }
      return result;
    } catch (error) {
      if (generation !== generationRef.current || requestedTarget !== targetRef.current) return null;
      throw error;
    } finally {
      if (generation === generationRef.current && requestedTarget === targetRef.current) setBusy(false);
    }
  };

  return { preview, busy, addInput, addFiles, setIncluded, confirm, discard, send };
}
