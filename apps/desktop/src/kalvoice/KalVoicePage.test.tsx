import type { KalVoiceStatus } from "@kalcode/protocol";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryKalVoice } from "../ipc/memoryKalVoice.ts";
import { KalVoicePage } from "./KalVoicePage.tsx";
import { KalVoiceSettings } from "./KalVoiceSettings.tsx";

const seams = vi.hoisted(() => ({ value: {} as Record<string, unknown>, navigate: vi.fn() }));
vi.mock("./KalVoiceProvider.tsx", () => ({
  useKalVoice: () => seams.value,
  useOptionalKalVoice: () => seams.value,
}));
vi.mock("../shell/navigation.tsx", () => ({ useNavigation: () => ({ navigate: seams.navigate }) }));
vi.mock("../runtime/RuntimeProvider.tsx", () => ({
  useRuntime: () => ({ info: { channel: "stable", flags: { surfaces: [], features: [] } } }),
}));

const quote = {
  catalogIdentity: "a".repeat(64),
  runtimeVersion: "runtime-test",
  modelVersion: "model-test",
  sizeBytes: 850_000_000,
};
const prepare = vi.fn();
const download = vi.fn();
const retry = vi.fn();

beforeEach(() => {
  seams.navigate.mockReset();
  prepare.mockReset().mockResolvedValue(quote);
  download.mockReset().mockResolvedValue(undefined);
  retry.mockReset().mockResolvedValue(undefined);
  const voice = createMemoryKalVoice(() => undefined, "");
  seams.value = {
    status: { ...(voice.handlers.kalvoice_status?.({}) as object), localReasoning: "not_installed", providers: [] },
    state: { phase: "idle" },
    levelRef: { current: 0 },
    history: [],
    submit: vi.fn(),
    setPanelVisible: vi.fn(),
    downloads: {},
    prepareReasoning: prepare,
    downloadModel: download,
    retryReasoning: retry,
    updatePreferences: vi.fn(),
    cancelDownload: vi.fn(),
    deleteModel: vi.fn(),
    refreshStatus: vi.fn(),
  };
});

function intelligenceCard() {
  const card = screen.getByText("Intelligence").closest("li");
  if (!card) throw new Error("Intelligence card missing");
  return within(card);
}

describe("KalVoice local intelligence first use", () => {
  it("routes missing local components to Settings and the signed download consent flow", async () => {
    // A connected provider cannot replace the local interpreter installation. Automatic
    // preparation is off, so the owner's review dialog is the path.
    const current = seams.value.status as KalVoiceStatus;
    seams.value.status = {
      ...current,
      providers: [{ id: "codex", displayName: "Codex", available: true }],
      preferences: { ...current.preferences, localIntelligenceAuto: false },
    };
    const page = render(<KalVoicePage />);
    expect(intelligenceCard().getByText("Not installed")).toBeInTheDocument();
    fireEvent.click(intelligenceCard().getByRole("button", { name: "Set up local intelligence" }));
    expect(seams.navigate).toHaveBeenCalledExactlyOnceWith("settings");
    expect(download).not.toHaveBeenCalled();
    page.unmount();
    render(<KalVoiceSettings />);
    fireEvent.click(screen.getByRole("button", { name: "Review download" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("runtime-test");
    expect(dialog).toHaveTextContent("model-test");
    expect(download).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Download" }));
    expect(download).toHaveBeenCalledExactlyOnceWith("local-reasoning", quote);
  });

  it("shows ready local interpretation with no provider connected", () => {
    seams.value.status = { ...(seams.value.status as object), localReasoning: "ready" };
    render(<KalVoicePage />);
    expect(intelligenceCard().getByText("Ready")).toBeInTheDocument();
    expect(intelligenceCard().queryByRole("button")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Open Providers" })).not.toBeInTheDocument();
    expect(screen.getByText(/Command interpretation runs on this computer/)).toBeInTheDocument();
  });

  it.each(["installed", "unavailable", undefined])(
    "routes %s readiness to the existing local startup recovery",
    (localReasoning) => {
      seams.value.status = { ...(seams.value.status as object), localReasoning };
      const page = render(<KalVoicePage />);
      expect(intelligenceCard().queryByText("Ready")).not.toBeInTheDocument();
      fireEvent.click(intelligenceCard().getByRole("button", { name: "Open KalVoice settings" }));
      expect(seams.navigate).toHaveBeenCalledExactlyOnceWith("settings");
      page.unmount();
      render(<KalVoiceSettings />);
      fireEvent.click(screen.getByRole("button", { name: "Retry local startup" }));
      expect(retry).toHaveBeenCalledOnce();
      expect(prepare).not.toHaveBeenCalled();
      expect(download).not.toHaveBeenCalled();
    },
  );

  it("never points at KalVoice settings from inside KalVoice settings", () => {
    seams.value.status = { ...(seams.value.status as object), localReasoning: "unavailable" };
    const page = render(<KalVoicePage />);
    expect(
      intelligenceCard().getByText("The local interpreter didn't start. Direct commands remain available."),
    ).toBeInTheDocument();
    page.unmount();
    render(<KalVoiceSettings />);
    expect(screen.queryByText(/in KalVoice settings/)).not.toBeInTheDocument();
  });

  it("prepares local intelligence and speech on its own with no setup click", () => {
    seams.value.status = { ...(seams.value.status as object), activeModel: null };
    render(<KalVoicePage />);
    expect(intelligenceCard().getByText("Waiting for speech")).toBeInTheDocument();
    expect(intelligenceCard().queryByRole("button")).not.toBeInTheDocument();
    expect(screen.getByText("Preparing speech")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Set up speech" })).not.toBeInTheDocument();
  });

  it("shows starting without premature readiness while speech setup stays available", () => {
    const current = seams.value.status as KalVoiceStatus;
    seams.value.status = {
      ...current,
      localReasoning: "warming",
      activeModel: null,
      // The owner removed the speech model: setup stays one click away.
      preferences: { ...current.preferences, speechModelAutoDownload: false },
    };
    render(<KalVoicePage />);
    expect(intelligenceCard().getByText("Starting")).toBeInTheDocument();
    expect(intelligenceCard().queryByRole("button")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Set up speech" }));
    expect(seams.navigate).toHaveBeenCalledExactlyOnceWith("settings");
    expect(screen.getByText("Commands").closest("li")).toHaveTextContent("Available");
    expect(screen.getByText("Commands").closest("li")).not.toHaveTextContent("Ready");
  });
});

describe("KalVoice usage", () => {
  function usage(used: number, allowance: number | null) {
    const current = seams.value.status as KalVoiceStatus;
    seams.value.status = {
      ...current,
      localReasoning: "ready",
      usage: { ...current.usage, used, allowance, resetsAt: "2030-10-01T00:00:00.000Z" },
    };
  }

  it("shows the usage line once, in the This month card", () => {
    usage(3, 75);
    render(<KalVoicePage />);
    expect(screen.getAllByText(/3 \/ 75 used/)).toHaveLength(1);
    expect(screen.queryByText("Limit reached")).not.toBeInTheDocument();
    expect(screen.queryByText(/Monthly limit reached/)).not.toBeInTheDocument();
  });

  it("says the monthly limit is reached, when it renews, and that dictation keeps working", () => {
    usage(75, 75);
    render(<KalVoicePage />);
    const month = screen.getByText("This month").closest("li");
    if (!month) throw new Error("This month card missing");
    expect(within(month).getByText("Limit reached")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(
      "Monthly limit reached. KalVoice Requests renew Oct 1. Dictation keeps working.",
    );
  });

  it("never shows a limit on an unlimited plan", () => {
    usage(9000, null);
    render(<KalVoicePage />);
    expect(screen.queryByText("Limit reached")).not.toBeInTheDocument();
    expect(screen.queryByText(/Monthly limit reached/)).not.toBeInTheDocument();
  });
});
