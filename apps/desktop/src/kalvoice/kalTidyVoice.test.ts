import { describe, expect, it, vi } from "vitest";
import type { KalTidyApi } from "../surfaces/code/kaltidy/kalTidyContext.ts";
import { parseKalTidyCommand, runKalTidyCommand } from "./kalTidyVoice.ts";

describe("parseKalTidyCommand", () => {
  it.each([
    "close all idle terminals",
    "Close all idle terminals.",
    "close idle terminals",
    "stop idle terminals",
    "kill idle terminals",
    "Kill all the idle terminals",
    "shut down my idle terminals",
    "clean up terminals",
    "Clean up my terminals",
    "tidy up terminals",
    "tidy terminals",
    "Tidy up all my terminals, please",
    "KalTidy",
    "Kal Tidy",
    "kal-tidy",
    "Cal tidy.",
    "run kaltidy",
    "Run KalTidy now",
    "um, close all idle terminals",
    "Hey Kal, close all idle terminals",
    "KalVoice, stop idle terminals for me",
    "can you close idle terminals please",
    "I'd like you to kill idle terminals",
    "go ahead and close all of my idle terminals, thanks",
  ])("runs KalTidy for %j", (text) => {
    expect(parseKalTidyCommand(text)).toBe("run");
  });

  it.each([
    "review idle terminals",
    "Show idle terminals",
    "show me my idle terminals",
    "list all idle terminals",
    "Which terminals are idle?",
    "which of my terminals are idle",
    "KalTidy review",
    "Kal tidy, review",
    "review KalTidy",
    "open kaltidy",
    "hey kal, which terminals are idle",
  ])("opens the review for %j", (text) => {
    expect(parseKalTidyCommand(text)).toBe("review");
  });

  it.each([
    "close this terminal",
    "close the terminal",
    "close terminal",
    "open a terminal",
    "open terminals",
    "stop the build",
    "stop the tests",
    "kill the terminal",
    "close all terminals",
    "stop all terminals",
    "clean up",
    "tidy up",
    "tidy",
    "kal",
    "idle terminals",
    "terminals",
    "don't close idle terminals",
    "close idle terminals and run the tests",
    "close idle terminals then open the dashboard",
    "please close idle terminals after the build finishes",
    "we should close all idle terminals before we ship",
    "I think KalTidy closes idle terminals",
    "the idle terminals are fine",
    "show idle agents",
    "show the idle threads",
    "",
    "   ",
  ])("leaves %j to native routing", (text) => {
    expect(parseKalTidyCommand(text)).toBeNull();
  });
});

function api(overrides: Partial<KalTidyApi> = {}): KalTidyApi {
  return {
    openReview: vi.fn(),
    stopIdle: vi.fn().mockResolvedValue({ stopped: 3, kept: 2, failed: 0, summary: "Stopped 3 idle terminals." }),
    ...overrides,
  };
}

describe("runKalTidyCommand", () => {
  it("says KalTidy isn't available when there is no provider", async () => {
    const report = vi.fn();
    await runKalTidyCommand(null, "run", report);
    expect(report).toHaveBeenCalledExactlyOnceWith({
      ok: false,
      message: "KalTidy isn't available here. Nothing was stopped.",
    });
  });

  it("stops idle terminals and reports KalTidy's own summary", async () => {
    const kalTidy = api();
    const report = vi.fn();
    await runKalTidyCommand(kalTidy, "run", report);
    expect(kalTidy.stopIdle).toHaveBeenCalledOnce();
    expect(kalTidy.openReview).not.toHaveBeenCalled();
    expect(report).toHaveBeenCalledExactlyOnceWith({ ok: true, message: "Stopped 3 idle terminals." });
  });

  it("reports a partial failure as not ok, still in KalTidy's words", async () => {
    const kalTidy = api({
      stopIdle: vi.fn().mockResolvedValue({ stopped: 1, kept: 0, failed: 1, summary: "Stopped 1; 1 couldn't stop." }),
    });
    const report = vi.fn();
    await runKalTidyCommand(kalTidy, "run", report);
    expect(report).toHaveBeenCalledExactlyOnceWith({ ok: false, message: "Stopped 1; 1 couldn't stop." });
  });

  it("opens the review without stopping anything", async () => {
    const kalTidy = api();
    const report = vi.fn();
    await runKalTidyCommand(kalTidy, "review", report);
    expect(kalTidy.openReview).toHaveBeenCalledOnce();
    expect(kalTidy.stopIdle).not.toHaveBeenCalled();
    expect(report).toHaveBeenCalledExactlyOnceWith({
      ok: true,
      message: "Opened KalTidy review. Nothing was stopped.",
    });
  });
});
