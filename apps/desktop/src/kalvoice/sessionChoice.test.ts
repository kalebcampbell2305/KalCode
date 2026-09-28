import type { SessionCandidate } from "@kalcode/protocol";
import { describe, expect, it } from "vitest";
import { choiceIsLive, pickSpokenChoice } from "./sessionChoice.ts";

function candidate(
  threadId: string,
  name: string,
  providerName: string,
  accountLabel: string | null,
): SessionCandidate {
  return {
    threadId,
    name,
    providerId: providerName === "Gemini CLI" ? "gemini-cli" : "claude-code",
    providerName,
    accountLabel,
    workspaceId: "w",
    workspaceName: "kalcode",
    status: "idle",
    label: accountLabel ? `${name} · ${providerName} · ${accountLabel}` : `${name} · ${providerName}`,
  };
}

const releaseWindows = candidate("1", "Release Windows", "Claude Code", "Work");
const releaseMac = candidate("2", "Release Mac", "Claude Code", "Work");
const researchA = candidate("3", "Research", "Gemini CLI", "Gemini A");
const researchB = candidate("4", "Research", "Gemini CLI", "Gemini B");

describe("pickSpokenChoice", () => {
  it("matches the full name or label", () => {
    expect(pickSpokenChoice("Release Mac", [releaseWindows, releaseMac])).toBe(releaseMac);
    expect(pickSpokenChoice("release windows · claude code · work", [releaseWindows, releaseMac])).toBe(releaseWindows);
  });

  it("matches a distinguishing word with filler around it", () => {
    expect(pickSpokenChoice("the Mac one", [releaseWindows, releaseMac])).toBe(releaseMac);
    expect(pickSpokenChoice("use Gemini B", [researchA, researchB])).toBe(researchB);
  });

  it("matches ordinals", () => {
    expect(pickSpokenChoice("the second one", [releaseWindows, releaseMac])).toBe(releaseMac);
    expect(pickSpokenChoice("last", [releaseWindows, releaseMac])).toBe(releaseMac);
  });

  it("never guesses: words shared by every choice or naming none pick nothing", () => {
    expect(pickSpokenChoice("release", [releaseWindows, releaseMac])).toBeNull();
    expect(pickSpokenChoice("research", [researchA, researchB])).toBeNull();
    expect(pickSpokenChoice("add a test for tabs", [releaseWindows, releaseMac])).toBeNull();
    expect(pickSpokenChoice("", [releaseWindows, releaseMac])).toBeNull();
    expect(pickSpokenChoice("the one", [releaseWindows, releaseMac])).toBeNull();
  });

  it("a clarification is live until it expires", () => {
    const state = { id: 1, question: "Which one?", choices: [], followUp: { kind: "open" as const }, expiresAt: 1000 };
    expect(choiceIsLive(state, 999)).toBe(true);
    expect(choiceIsLive(state, 1000)).toBe(false);
    expect(choiceIsLive(null)).toBe(false);
  });
});
