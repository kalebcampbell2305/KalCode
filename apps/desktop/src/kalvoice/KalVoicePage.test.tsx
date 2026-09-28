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
    // A connected provider cannot replace the local interpreter installation.
    seams.value.status = {
      ...(seams.value.status as object),
      providers: [{ id: "codex", displayName: "Codex", available: true }],
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

  it("shows starting without premature readiness while speech setup stays available", () => {
    seams.value.status = { ...(seams.value.status as object), localReasoning: "warming", activeModel: null };
    render(<KalVoicePage />);
    expect(intelligenceCard().getByText("Starting")).toBeInTheDocument();
    expect(intelligenceCard().queryByRole("button")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Set up speech" }));
    expect(seams.navigate).toHaveBeenCalledExactlyOnceWith("settings");
    expect(screen.getByText("Commands").closest("li")).toHaveTextContent("Available");
    expect(screen.getByText("Commands").closest("li")).not.toHaveTextContent("Ready");
  });
});
