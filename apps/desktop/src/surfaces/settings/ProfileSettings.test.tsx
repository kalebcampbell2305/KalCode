import type { Settings } from "@kalcode/protocol";
import { ToastProvider } from "@kalcode/ui/components";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { KalCodeClient } from "../../ipc/client.ts";
import { createMemoryTransport } from "../../ipc/memoryTransport.ts";
import { RuntimeProvider } from "../../runtime/RuntimeProvider.tsx";
import { ProfileSettings } from "./ProfileSettings.tsx";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
async function fixture(name = "Alice") {
  const client = new KalCodeClient(createMemoryTransport("default"));
  const boot = await client.boot();
  const settings = await client.updateSettings({ displayName: name });
  return { client, boot, settings };
}
function tree(runtime: Awaited<ReturnType<typeof fixture>>) {
  return (
    <ToastProvider>
      <RuntimeProvider client={runtime.client} info={runtime.boot.info} initialSettings={runtime.settings}>
        <ProfileSettings />
      </RuntimeProvider>
    </ToastProvider>
  );
}
const input = () => screen.getByRole("textbox", { name: "Display name" });
const save = () => screen.getByRole("button", { name: "Save" });
function edit(value: string) {
  fireEvent.change(input(), { target: { value } });
}
afterEach(() => vi.useRealTimers());

describe("profile persistence", () => {
  it("does not announce success after a failed write, and retains the draft for retry", async () => {
    const runtime = await fixture();
    vi.spyOn(runtime.client, "updateSettings").mockRejectedValueOnce(new Error("Disk full"));
    render(tree(runtime));
    edit("Bob");
    fireEvent.click(save());
    await screen.findByText("Settings not saved");
    await waitFor(() => expect(save()).not.toHaveAttribute("aria-busy", "true"));
    expect(screen.queryByText("Saved")).toBeNull();
    expect(input()).toHaveValue("Bob");
    expect(save()).toBeEnabled();
    fireEvent.click(save());
    await screen.findByText("Saved");
    expect((await runtime.client.getSettings()).displayName).toBe("Bob");
  });

  it("does not overwrite or mark a newer draft saved when a previous write completes", async () => {
    const runtime = await fixture();
    const pending = deferred<Settings>();
    vi.spyOn(runtime.client, "updateSettings").mockReturnValueOnce(pending.promise);
    render(tree(runtime));
    edit("  Bob  ");
    fireEvent.click(save());
    edit("Carol");
    await act(async () => {
      pending.resolve({ ...runtime.settings, displayName: "Bob" });
    });
    expect(input()).toHaveValue("Carol");
    expect(screen.queryByText("Saved")).toBeNull();
    expect(save()).toBeEnabled();
  });

  it("does not carry an unsaved draft into another runtime with the same saved name", async () => {
    const first = await fixture();
    const second = await fixture();
    const view = render(tree(first));
    edit("Private draft");
    view.rerender(tree(second));
    expect(input()).toHaveValue("Alice");
    expect(save()).toBeDisabled();
  });

  it("resets busy state on runtime replacement and ignores the old completion", async () => {
    const first = await fixture();
    const second = await fixture();
    const pending = deferred<Settings>();
    vi.spyOn(first.client, "updateSettings").mockReturnValueOnce(pending.promise);
    const view = render(tree(first));
    edit("Bob");
    fireEvent.click(save());
    view.rerender(tree(second));
    expect(save()).not.toHaveAttribute("aria-busy", "true");
    edit("Carol");
    await act(async () => {
      pending.resolve({ ...first.settings, displayName: "Bob" });
    });
    expect(input()).toHaveValue("Carol");
    expect(screen.queryByText("Saved")).toBeNull();
  });

  it("does not let an earlier confirmation timer clear a newer save confirmation", async () => {
    const runtime = await fixture();
    render(tree(runtime));
    vi.useFakeTimers();
    await act(async () => {
      edit("Bob");
      fireEvent.click(save());
    });
    expect(screen.getByText("Saved")).toBeVisible();
    act(() => vi.advanceTimersByTime(1500));
    await act(async () => {
      edit("Carol");
      fireEvent.click(save());
    });
    expect(screen.getByText("Saved")).toBeVisible();
    act(() => vi.advanceTimersByTime(600));
    expect(screen.getByText("Saved")).toBeVisible();
    act(() => vi.advanceTimersByTime(1500));
    expect(screen.queryByText("Saved")).toBeNull();
  });

  it("submits only one write before the busy render commits", async () => {
    const runtime = await fixture();
    const pending = deferred<Settings>();
    const write = vi.spyOn(runtime.client, "updateSettings").mockReturnValue(pending.promise);
    render(tree(runtime));
    edit("Bob");
    const form = input().closest("form");
    if (!form) throw new Error("Profile form missing");
    act(() => {
      fireEvent.submit(form);
      fireEvent.submit(form);
    });
    expect(write).toHaveBeenCalledTimes(1);
    await act(async () => {
      pending.resolve({ ...runtime.settings, displayName: "Bob" });
    });
  });
});
