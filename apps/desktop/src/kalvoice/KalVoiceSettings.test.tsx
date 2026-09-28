import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryKalVoice } from "../ipc/memoryKalVoice.ts";
import { KalVoiceSettings } from "./KalVoiceSettings.tsx";

const seams = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
vi.mock("./KalVoiceProvider.tsx", () => ({
  useKalVoice: () => seams.value,
  useOptionalKalVoice: () => seams.value,
}));

const quote = {
  catalogIdentity: "a".repeat(64),
  runtimeVersion: "0.5.0-test",
  modelVersion: "synthetic-q8",
  sizeBytes: 850_000_000,
};
const prepare = vi.fn();
const download = vi.fn();
const retry = vi.fn();

beforeEach(() => {
  prepare.mockReset().mockResolvedValue(quote);
  download.mockReset().mockResolvedValue(undefined);
  retry.mockReset().mockResolvedValue(undefined);
  const voice = createMemoryKalVoice(() => undefined, "");
  seams.value = {
    status: { ...(voice.handlers.kalvoice_status?.({}) as object), localReasoning: "not_installed" },
    downloads: {},
    prepareReasoning: prepare,
    retryReasoning: retry,
    downloadModel: download,
    updatePreferences: vi.fn(),
    cancelDownload: vi.fn(),
    deleteModel: vi.fn(),
    refreshStatus: vi.fn(),
    setPanelVisible: vi.fn(),
  };
});

describe("signed local interpreter download consent", () => {
  it("retries installed runtime startup without fetching a catalog or consenting again", () => {
    seams.value.status = { ...(seams.value.status as object), localReasoning: "installed" };
    render(<KalVoiceSettings />);
    fireEvent.click(screen.getByRole("button", { name: "Retry local startup" }));
    expect(retry).toHaveBeenCalledOnce();
    expect(prepare).not.toHaveBeenCalled();
    expect(download).not.toHaveBeenCalled();
  });
  it("shows exact verified versions and size before downloading the quoted catalog", async () => {
    render(<KalVoiceSettings />);
    expect(download).not.toHaveBeenCalled();
    expect(screen.getByText(/Local dictation is unlimited on every plan/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Review download" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("0.5.0-test");
    expect(dialog).toHaveTextContent("synthetic-q8");
    expect(dialog).toHaveTextContent(/850\s*MB/);
    expect(download).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /^Download$/ }));
    expect(download).toHaveBeenCalledExactlyOnceWith("local-reasoning", quote);
  });

  it("canceling metadata review never downloads a component", async () => {
    render(<KalVoiceSettings />);
    fireEvent.click(screen.getByRole("button", { name: "Review download" }));
    await screen.findByRole("alertdialog");
    fireEvent.click(screen.getByRole("button", { name: /^Cancel$/ }));
    expect(download).not.toHaveBeenCalled();
  });

  it("an unavailable catalog leaves commands and speech controls visible without claiming readiness", async () => {
    prepare.mockRejectedValue({
      code: "component_catalog_unavailable",
      message: "The signed component catalog is unavailable.",
      category: "validation",
      retryable: true,
    });
    render(<KalVoiceSettings />);
    fireEvent.click(screen.getByRole("button", { name: "Review download" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("catalog is unavailable"));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(screen.getByText("Speech model")).toBeInTheDocument();
    expect(download).not.toHaveBeenCalled();
  });
});

describe("automatic local startup status", () => {
  it("says what a held start is waiting for and needs no retry", () => {
    seams.value.status = {
      ...(seams.value.status as object),
      localReasoning: "waiting",
      localReasoningIssue: "cpu_headroom",
    };
    render(<KalVoiceSettings />);
    expect(screen.getByText("Waiting for CPU headroom")).toBeInTheDocument();
    expect(screen.getByRole("note")).toHaveTextContent(/starts the on-device interpreter automatically/);
    expect(screen.queryByRole("button", { name: "Retry local startup" })).not.toBeInTheDocument();
  });

  it("shows why startup gave up and keeps retry available", () => {
    seams.value.status = {
      ...(seams.value.status as object),
      localReasoning: "failed",
      localReasoningIssue: "worker_health_timeout",
    };
    render(<KalVoiceSettings />);
    expect(screen.getByText("Couldn't start: worker_health_timeout")).toBeInTheDocument();
    expect(screen.getByText(/The interpreter didn't become ready in time\./)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry local startup" }));
    expect(retry).toHaveBeenCalledOnce();
    expect(download).not.toHaveBeenCalled();
  });
});
