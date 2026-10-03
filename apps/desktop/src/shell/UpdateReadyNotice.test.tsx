import type { TerminalInfo, ThreadSummary } from "@kalcode/protocol";
import { ToastProvider } from "@kalcode/ui/components";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UpdatePhase, UpdateStatus } from "../ipc/updater.ts";
import { thread } from "../surfaces/dashboard/data/testing.ts";
import { UpdateReadyNotice, type UpdateReadyNoticeClient, workIsRunning } from "./UpdateReadyNotice.tsx";

const base: UpdateStatus = {
  channel: "stable",
  phase: "idle",
  currentVersion: "0.1.5",
  availableVersion: null,
  downloadedBytes: 0,
  totalBytes: null,
  lastError: null,
  recoveryAvailable: false,
  installOnQuit: false,
};

const ready: UpdateStatus = { ...base, phase: "ready", availableVersion: "0.1.6", downloadedBytes: 10, totalBytes: 10 };

const RUNNING_TERMINAL: TerminalInfo = {
  id: "t1",
  workspaceId: "w1",
  shellId: "sh",
  title: "Shell",
  position: 0,
  status: "running",
  startedAt: null,
  endedAt: null,
  exitCode: null,
};

/** By default a terminal is running, so "Restart to update" confirms first. */
function fakeClient(status: () => Promise<UpdateStatus>, work: { terminals?: TerminalInfo[] } = {}) {
  return {
    updaterStatus: vi.fn(status),
    updaterInstall: vi.fn(async () => undefined),
    runningTerminals: vi.fn(async () => work.terminals ?? [RUNNING_TERMINAL]),
    listThreads: vi.fn(async () => [] as ThreadSummary[]),
  } satisfies UpdateReadyNoticeClient;
}

function renderNotice(client: UpdateReadyNoticeClient, onOpenDetails = vi.fn()) {
  const view = render(
    <ToastProvider>
      <UpdateReadyNotice client={client} onOpenDetails={onOpenDetails} />
    </ToastProvider>,
  );
  return { ...view, onOpenDetails };
}

async function findNotice() {
  return screen.findByRole("status", { name: "Update ready" });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("UpdateReadyNotice", () => {
  it.each<UpdatePhase>(["idle", "checking", "downloading", "up_to_date", "installing", "failed"])(
    "stays hidden while the updater is %s",
    async (phase) => {
      const client = fakeClient(async () => ({ ...base, phase, availableVersion: phase === "idle" ? null : "0.1.6" }));
      renderNotice(client);
      await waitFor(() => expect(client.updaterStatus).toHaveBeenCalled());
      await act(async () => {});
      expect(screen.queryByRole("status", { name: "Update ready" })).not.toBeInTheDocument();
      expect(screen.queryByText(/is ready to install/)).not.toBeInTheDocument();
    },
  );

  it("announces a verified ready update with its version, non-modally and politely", async () => {
    const client = fakeClient(async () => ready);
    renderNotice(client);
    const notice = await findNotice();
    expect(notice).toHaveAttribute("aria-live", "polite");
    expect(notice).toHaveTextContent("KalCode 0.1.6 is ready to install.");
    expect(notice).toHaveTextContent("Your work stays open until you restart.");
    expect(screen.getByRole("button", { name: "Restart to update" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Later" })).toBeInTheDocument();
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(client.updaterInstall).not.toHaveBeenCalled();
  });

  it.each([
    ["0.1.8", "0.1.8+780"],
    ["0.1.8+779", "0.1.8+780"],
    ["0.1.8+944", "0.1.9+1050"],
  ])("never announces a build staged to install when KalCode closes (%s to %s)", async (current, next) => {
    const client = fakeClient(async () => ({
      ...ready,
      currentVersion: current,
      availableVersion: next,
      installOnQuit: true,
    }));
    renderNotice(client);
    await waitFor(() => expect(client.updaterStatus).toHaveBeenCalled());
    await act(async () => {});
    expect(screen.queryByRole("status", { name: "Update ready" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Restart to update" })).not.toBeInTheDocument();
    expect(client.updaterInstall).not.toHaveBeenCalled();
  });

  it("offers a same-version build whose silent install failed through the restart prompt", async () => {
    const client = fakeClient(async () => ({ ...ready, currentVersion: "0.1.8+779", availableVersion: "0.1.8+780" }));
    renderNotice(client);
    expect(await findNotice()).toHaveTextContent("A new KalCode 0.1.8 build is ready (build 780).");
    await userEvent.click(screen.getByRole("button", { name: "Restart to update" }));
    expect(await screen.findByRole("alertdialog")).toHaveTextContent("restart into KalCode 0.1.8 build 780.");
    await userEvent.click(screen.getByRole("button", { name: "Restart and install 0.1.8 build 780" }));
    await waitFor(() => expect(client.updaterInstall).toHaveBeenCalledOnce());
  });

  it("offers a new public version whose silent install failed through the restart prompt", async () => {
    const client = fakeClient(async () => ({ ...ready, currentVersion: "0.1.8+780", availableVersion: "0.1.9+801" }));
    renderNotice(client);
    expect(await findNotice()).toHaveTextContent("KalCode 0.1.9 is ready to install.");
    await userEvent.click(screen.getByRole("button", { name: "Restart to update" }));
    expect(await screen.findByRole("alertdialog")).toHaveTextContent("restart into KalCode 0.1.9 build 801.");
    expect(screen.getByRole("button", { name: "Restart and install 0.1.9 build 801" })).toBeInTheDocument();
  });

  it("names only the public version when the update crosses public versions", async () => {
    const client = fakeClient(async () => ({ ...ready, currentVersion: "0.1.7+780", availableVersion: "0.1.8+900" }));
    renderNotice(client);
    expect(await findNotice()).toHaveTextContent("KalCode 0.1.8 is ready to install.");
  });

  it("Later hides the notice for this session without installing", async () => {
    const client = fakeClient(async () => ready);
    renderNotice(client);
    await findNotice();
    await userEvent.click(screen.getByRole("button", { name: "Later" }));
    expect(screen.queryByRole("status", { name: "Update ready" })).not.toBeInTheDocument();
    expect(client.updaterInstall).not.toHaveBeenCalled();
  });

  it("Details opens Settings → Updates", async () => {
    const client = fakeClient(async () => ready);
    const { onOpenDetails } = renderNotice(client);
    await findNotice();
    await userEvent.click(screen.getByRole("button", { name: "Details" }));
    expect(onOpenDetails).toHaveBeenCalledOnce();
    expect(client.updaterInstall).not.toHaveBeenCalled();
  });

  it("Restart to update asks for confirmation first and cancelling does nothing", async () => {
    const client = fakeClient(async () => ready);
    renderNotice(client);
    await findNotice();
    await userEvent.click(screen.getByRole("button", { name: "Restart to update" }));

    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent(/threads/i);
    expect(dialog).toHaveTextContent(/terminals/i);
    expect(dialog).toHaveTextContent(/KalVoice/);
    expect(dialog).toHaveTextContent(/0\.1\.6/);
    expect(client.updaterInstall).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(client.updaterInstall).not.toHaveBeenCalled();
    expect(screen.getByRole("status", { name: "Update ready" })).toBeInTheDocument();
  });

  it("confirming calls the shared install path exactly once", async () => {
    const client = fakeClient(async () => ready);
    renderNotice(client);
    await findNotice();
    await userEvent.click(screen.getByRole("button", { name: "Restart to update" }));
    await screen.findByRole("alertdialog");
    await userEvent.click(screen.getByRole("button", { name: "Restart and install 0.1.6" }));
    await waitFor(() => expect(client.updaterInstall).toHaveBeenCalledOnce());
  });

  it("restarts at once, without a confirmation, when nothing is running", async () => {
    const client = fakeClient(async () => ready, { terminals: [] });
    renderNotice(client);
    await findNotice();
    await userEvent.click(screen.getByRole("button", { name: "Restart to update" }));
    await waitFor(() => expect(client.updaterInstall).toHaveBeenCalledOnce());
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("offers Try again when the install fails", async () => {
    const client = fakeClient(async () => ready, { terminals: [] });
    client.updaterInstall.mockRejectedValueOnce({
      category: "update",
      code: "update_failed",
      message: "Install failed",
      retryable: true,
    });
    renderNotice(client);
    await findNotice();
    await userEvent.click(screen.getByRole("button", { name: "Restart to update" }));
    await userEvent.click(await screen.findByRole("button", { name: "Try again" }));
    await waitFor(() => expect(client.updaterInstall).toHaveBeenCalledTimes(2));
  });

  it("counts running terminals and working or waiting threads as running work", async () => {
    const quiet = { runningTerminals: async () => [], listThreads: async () => [thread({ status: "idle" })] };
    expect(await workIsRunning(quiet)).toBe(false);
    expect(await workIsRunning({ ...quiet, listThreads: async () => [thread({ status: "completed" })] })).toBe(false);
    expect(await workIsRunning({ ...quiet, listThreads: async () => [thread({ status: "thinking" })] })).toBe(true);
    expect(
      await workIsRunning({ ...quiet, listThreads: async () => [thread({ status: "waiting_for_permission" })] }),
    ).toBe(true);
    expect(await workIsRunning({ ...quiet, runningTerminals: async () => [RUNNING_TERMINAL] })).toBe(true);
    // When it can't tell, it asks.
    expect(
      await workIsRunning({
        ...quiet,
        runningTerminals: async () => {
          throw new Error("offline");
        },
      }),
    ).toBe(true);
  });

  it("stays hidden and quiet when the status read fails", async () => {
    const client = fakeClient(async () => {
      throw { category: "update", code: "update_unavailable", message: "Updater offline", retryable: true };
    });
    renderNotice(client);
    await waitFor(() => expect(client.updaterStatus).toHaveBeenCalled());
    await act(async () => {});
    expect(screen.queryByRole("status", { name: "Update ready" })).not.toBeInTheDocument();
    expect(screen.queryByText("Updater offline")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("notices an update that becomes ready on a later poll and stops polling once unmounted", async () => {
    vi.useFakeTimers();
    let current: UpdateStatus = { ...base, phase: "downloading", availableVersion: "0.1.6" };
    const client = fakeClient(async () => current);
    const { unmount } = renderNotice(client);
    await act(async () => {});
    expect(screen.queryByRole("status", { name: "Update ready" })).not.toBeInTheDocument();

    current = ready;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(screen.getByRole("status", { name: "Update ready" })).toHaveTextContent(
      "KalCode 0.1.6 is ready to install.",
    );

    unmount();
    const calls = client.updaterStatus.mock.calls.length;
    await vi.advanceTimersByTimeAsync(180_000);
    expect(client.updaterStatus).toHaveBeenCalledTimes(calls);
  });
});
