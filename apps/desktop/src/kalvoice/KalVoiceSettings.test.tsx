import type { ComponentProvisioning, KalVoiceStatus } from "@kalcode/protocol";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryKalVoice } from "../ipc/memoryKalVoice.ts";
import { KalVoiceSettings } from "./KalVoiceSettings.tsx";

const seams = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
const platform = vi.hoisted(() => ({ value: "unknown" }));
vi.mock("../platform/keyboard.ts", () => ({
  get DESKTOP_PLATFORM() {
    return platform.value;
  },
}));
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
const setPaused = vi.fn();
const updatePreferences = vi.fn();

beforeEach(() => {
  platform.value = "unknown";
  prepare.mockReset().mockResolvedValue(quote);
  download.mockReset().mockResolvedValue(undefined);
  retry.mockReset().mockResolvedValue(undefined);
  setPaused.mockReset().mockResolvedValue(undefined);
  updatePreferences.mockReset().mockResolvedValue(undefined);
  const voice = createMemoryKalVoice(() => undefined, "");
  const status = voice.handlers.kalvoice_status?.({}) as KalVoiceStatus;
  seams.value = {
    // The review dialog is the manual path: automatic preparation is off here.
    status: {
      ...status,
      localReasoning: "not_installed",
      preferences: { ...status.preferences, localIntelligenceAuto: false },
    },
    downloads: {},
    prepareReasoning: prepare,
    retryReasoning: retry,
    downloadModel: download,
    setIntelligencePaused: setPaused,
    updatePreferences,
    cancelDownload: vi.fn(),
    deleteModel: vi.fn(),
    refreshStatus: vi.fn(),
    setPanelVisible: vi.fn(),
  };
});

describe("Fn and configured fallback guidance", () => {
  it("explains reported-only Windows Fn and keeps the configured fallback", () => {
    platform.value = "windows";
    const status = seams.value.status as KalVoiceStatus;
    seams.value.status = { ...status, preferences: { ...status.preferences, talkKey: "F9" } };
    render(<KalVoiceSettings />);
    expect(screen.getByText("Fallback push-to-talk key")).toBeInTheDocument();
    expect(screen.getByText(/most Windows keyboards handle it in firmware/)).toHaveTextContent("keep using F9");
    expect(updatePreferences).not.toHaveBeenCalled();
  });

  it("offers a Mac Fn hold with fallback and honest Globe action guidance", () => {
    platform.value = "macos";
    render(<KalVoiceSettings />);
    const hint = screen.getByText(/Hold Fn on its own/);
    expect(hint).toHaveTextContent("F8 remains your fallback");
    expect(hint).toHaveTextContent("Globe actions still work");
    expect(hint).toHaveTextContent("Do Nothing");
  });
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

function withStatus(patch: Partial<KalVoiceStatus>, preferences: Partial<KalVoiceStatus["preferences"]> = {}) {
  const current = seams.value.status as KalVoiceStatus;
  seams.value.status = { ...current, ...patch, preferences: { ...current.preferences, ...preferences } };
}

const intelligence = (patch: Partial<ComponentProvisioning>): ComponentProvisioning => ({
  modelId: "local-reasoning",
  automatic: true,
  phase: "downloading",
  receivedBytes: 212_000_000,
  totalBytes: 852_000_000,
  ...patch,
});

describe("zero-setup local intelligence", () => {
  it("prepares on its own with truthful progress and a visible Pause", () => {
    withStatus({ provisioning: [intelligence({})] }, { localIntelligenceAuto: true });
    render(<KalVoiceSettings />);
    expect(screen.getByText("Preparing local intelligence (852 MB)…")).toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: "Preparing local intelligence" })).toHaveAttribute(
      "aria-valuenow",
      "24",
    );
    expect(screen.getByRole("note")).toHaveTextContent("Downloading 212 MB of 852 MB");
    expect(screen.queryByRole("button", { name: "Review download" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    expect(setPaused).toHaveBeenCalledExactlyOnceWith(true);
    expect(download).not.toHaveBeenCalled();
  });

  it("shows a stored pause with where it stopped and resumes it", () => {
    withStatus(
      { provisioning: [intelligence({ phase: "paused" })] },
      { localIntelligenceAuto: true, localIntelligencePaused: true },
    );
    render(<KalVoiceSettings />);
    expect(screen.getByText("Paused")).toBeInTheDocument();
    expect(screen.getByRole("note")).toHaveTextContent("paused at 212 MB of 852 MB");
    fireEvent.click(screen.getByRole("button", { name: "Resume" }));
    expect(setPaused).toHaveBeenCalledExactlyOnceWith(false);
  });

  it("waits for a ready speech model before preparing local intelligence", () => {
    withStatus({ activeModel: null, provisioning: [] }, { localIntelligenceAuto: true });
    render(<KalVoiceSettings />);
    expect(screen.getByText("Waiting for speech")).toBeInTheDocument();
  });

  it("names a governor hold and a scheduled retry without asking for a click", () => {
    withStatus(
      { provisioning: [intelligence({ phase: "waiting_for_resources", reason: "memory" })] },
      { localIntelligenceAuto: true },
    );
    const view = render(<KalVoiceSettings />);
    expect(screen.getByText("Waiting for system resources")).toBeInTheDocument();
    expect(screen.getByRole("note")).toHaveTextContent("continues when enough memory is free");
    view.unmount();
    withStatus({
      provisioning: [
        intelligence({ phase: "retry_scheduled", reason: "component_catalog_unavailable", retryInSeconds: 60 }),
      ],
    });
    render(<KalVoiceSettings />);
    expect(screen.getByText("Unavailable")).toBeInTheDocument();
    expect(screen.getByText(/retries automatically in about a minute/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Review download" })).not.toBeInTheDocument();
  });

  it("offers 'Prepare local intelligence automatically', on by default", () => {
    withStatus({}, { localIntelligenceAuto: true });
    render(<KalVoiceSettings />);
    const toggle = screen.getByRole("switch", { name: "Prepare local intelligence automatically" });
    expect(toggle).toHaveAttribute("aria-checked", "true");
    fireEvent.click(toggle);
    expect(updatePreferences).toHaveBeenCalledExactlyOnceWith({ localIntelligenceAuto: false });
  });
});

describe("zero-setup speech model", () => {
  it("says the model comes from KalCode's signed catalog on kalcoded.com, not whisper.cpp", () => {
    render(<KalVoiceSettings />);
    expect(screen.getAllByText(/signed component catalog on kalcoded\.com/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/official whisper\.cpp/)).not.toBeInTheDocument();
    expect(screen.queryByText(/only when you choose/)).not.toBeInTheDocument();
  });

  it("shows the automatic download's progress and its governor wait", () => {
    withStatus({
      activeModel: null,
      models: (seams.value.status as KalVoiceStatus).models.map((m) =>
        m.id === "tiny.en" ? { ...m, state: { kind: "not_installed" } } : m,
      ),
      provisioning: [
        {
          modelId: "tiny.en",
          automatic: true,
          phase: "downloading",
          receivedBytes: 38_852_358,
          totalBytes: 77_704_715,
        },
      ],
    });
    const view = render(<KalVoiceSettings />);
    expect(screen.getByRole("progressbar", { name: "Downloading English (fastest)" })).toHaveAttribute(
      "aria-valuenow",
      "50",
    );
    expect(screen.getByRole("status", { name: "Push-to-talk readiness" })).toHaveTextContent("Preparing speech 50%");
    view.unmount();
    withStatus({
      provisioning: [
        {
          modelId: "tiny.en",
          automatic: true,
          phase: "waiting_for_resources",
          reason: "cpu",
          receivedBytes: 0,
          totalBytes: 77_704_715,
        },
      ],
    });
    render(<KalVoiceSettings />);
    expect(screen.getAllByText(/Waiting for system resources/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/^Ready\./)).not.toBeInTheDocument();
  });

  it("after the owner removed the model, Settings shows the manual download again", () => {
    withStatus(
      {
        activeModel: null,
        models: (seams.value.status as KalVoiceStatus).models.map((m) => ({ ...m, state: { kind: "not_installed" } })),
        provisioning: [],
      },
      { speechModelAutoDownload: false },
    );
    render(<KalVoiceSettings />);
    expect(screen.getByText(/Downloaded when you choose/)).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Download" }).length).toBe(5);
    expect(screen.getByRole("status", { name: "Push-to-talk readiness" })).toHaveTextContent("Needs a speech model");
  });
});

describe("first-run disclosure", () => {
  it("notes the one-time verified downloads and the automatic-preparation preference", () => {
    render(<KalVoiceSettings />);
    const note = screen.getByText(/On first use, KalCode downloads its English speech model/);
    expect(note).toHaveTextContent("about 78 MB");
    expect(note).toHaveTextContent("about 850 MB");
    expect(note).toHaveTextContent("Prepare local intelligence automatically");
    expect(note).toHaveTextContent("once from its signed component catalog on kalcoded.com");
    expect(note).toHaveTextContent("verifies each before use");
  });

  it("says where local intelligence comes from while it prepares", () => {
    withStatus(
      { provisioning: [intelligence({ phase: "preparing", receivedBytes: 0 })] },
      { localIntelligenceAuto: true },
    );
    render(<KalVoiceSettings />);
    expect(screen.getByRole("note")).toHaveTextContent(
      "Preparing local intelligence (852 MB) from KalCode's signed component catalog…",
    );
  });

  it("a permanent stop offers the owner's own reviewed download and no automatic retry", () => {
    withStatus(
      { provisioning: [intelligence({ phase: "unavailable", reason: "components_unverified", receivedBytes: 0 })] },
      { localIntelligenceAuto: true },
    );
    render(<KalVoiceSettings />);
    expect(screen.getByText(/Couldn't verify KalVoice components\. Try again later/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Pause" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Review download" }));
    expect(prepare).toHaveBeenCalledOnce();
  });
});
