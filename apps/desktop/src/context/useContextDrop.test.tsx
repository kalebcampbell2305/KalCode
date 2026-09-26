import type { Settings, ThreadSummary } from "@kalcode/protocol";
import { ToastProvider } from "@kalcode/ui/components";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { describe, expect, it, vi } from "vitest";
import { KalCodeClient } from "../ipc/client.ts";
import { createMemoryTransport } from "../ipc/memoryTransport.ts";
import { RuntimeProvider } from "../runtime/RuntimeProvider.tsx";
import { useContextDrop } from "./useContextDrop.ts";

const SETTINGS: Settings = {
  theme: "dark",
  motion: "system",
  density: "comfortable",
  sidebarCollapsed: false,
};

async function fixture() {
  const client = new KalCodeClient(createMemoryTransport("threads"));
  const boot = await client.boot();
  const thread = (await client.listThreads()).find(
    (candidate) =>
      !candidate.archivedAt &&
      !["waiting_for_permission", "paused", "completed", "failed", "interrupted", "offline"].includes(candidate.status),
  );
  if (!thread) throw new Error("The context hook fixture needs a sendable thread.");
  const wrapper = ({ children }: PropsWithChildren) => (
    <ToastProvider>
      <RuntimeProvider client={client} info={boot.info} initialSettings={SETTINGS}>
        {children}
      </RuntimeProvider>
    </ToastProvider>
  );
  return { client, thread, wrapper };
}

describe("useContextDrop lifecycle", () => {
  it("discards an active Draft preview when its composer unmounts", async () => {
    const { client, thread, wrapper } = await fixture();
    const discard = vi.spyOn(client, "discardContext");
    const { result, unmount } = renderHook(() => useContextDrop(thread), { wrapper });

    await act(async () => {
      await result.current.addInput({ kind: "text", label: "Build output", text: "One bounded excerpt" });
    });
    const packageId = result.current.preview?.packageId;
    expect(packageId).toBeTruthy();

    unmount();
    await waitFor(() => expect(discard).toHaveBeenCalledWith(packageId));
  });

  it("discards a preview that resolves after the selected thread changes", async () => {
    const { client, thread, wrapper } = await fixture();
    const actualCreate = client.createContextPreview.bind(client);
    const discard = vi.spyOn(client, "discardContext");
    let release!: () => void;
    let createdPackageId: string | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(client, "createContextPreview").mockImplementation(async (...args) => {
      const preview = await actualCreate(...args);
      createdPackageId = preview.packageId;
      await gate;
      return preview;
    });
    const otherThread: ThreadSummary = { ...thread, id: `${thread.id}-other` };
    const { result, rerender } = renderHook(({ selected }) => useContextDrop(selected), {
      initialProps: { selected: thread },
      wrapper,
    });

    let pending!: Promise<unknown>;
    act(() => {
      pending = result.current.addInput({ kind: "selection", label: "Selection", text: "stale selection" });
    });
    await waitFor(() => expect(createdPackageId).toBeTruthy());
    rerender({ selected: otherThread });
    release();
    await act(async () => {
      await pending;
    });

    expect(result.current.preview).toBeNull();
    await waitFor(() => expect(discard).toHaveBeenCalledWith(createdPackageId));
  });

  it("cancels a pending prompt review on context edits and forwards an explicit review id on send", async () => {
    const { client, thread, wrapper } = await fixture();
    const onMutation = vi.fn();
    const send = vi.spyOn(client, "sendWithContext").mockResolvedValue({ kind: "sent", thread });
    const { result } = renderHook(() => useContextDrop(thread, onMutation), { wrapper });

    await act(async () => {
      await result.current.addInput({ kind: "text", label: "Build output", text: "One bounded excerpt" });
    });
    expect(onMutation).toHaveBeenCalledTimes(1);

    await act(async () => {
      await result.current.send("password=reviewed-once", "0192f3c4-0000-7000-8000-000000000099");
    });
    expect(send).toHaveBeenCalledWith(
      expect.any(String),
      thread.id,
      expect.any(String),
      "password=reviewed-once",
      "0192f3c4-0000-7000-8000-000000000099",
    );
    expect(onMutation).toHaveBeenCalledTimes(1);
  });
});
