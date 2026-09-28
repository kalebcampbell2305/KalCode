import type { SessionCandidate } from "@kalcode/protocol";
import { describe, expect, it } from "vitest";
import { choiceIsLive, isChoiceAnswer, pickSpokenChoice } from "./sessionChoice.ts";

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

  it("matches numbered choices", () => {
    expect(pickSpokenChoice("number two", [releaseWindows, releaseMac])).toBe(releaseMac);
    expect(pickSpokenChoice("the number 1", [releaseWindows, releaseMac])).toBe(releaseWindows);
    expect(pickSpokenChoice("number four", [releaseWindows, releaseMac])).toBeNull();
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

describe("isChoiceAnswer", () => {
  it("takes short answers and choice forms as answers", () => {
    expect(isChoiceAnswer("the Mac one")).toBe(true);
    expect(isChoiceAnswer("Hey Kal, Release Mac please")).toBe(true);
    expect(isChoiceAnswer("the second one")).toBe(true);
    expect(isChoiceAnswer("number two")).toBe(true);
    expect(isChoiceAnswer("Release Windows Claude Code Work")).toBe(true);
    expect(isChoiceAnswer("Release Windows on Claude Code Work")).toBe(false);
  });

  it("treats longer utterances as new requests", () => {
    expect(isChoiceAnswer("tell the parser module to add a test for tabs")).toBe(false);
    expect(isChoiceAnswer("open the dashboard and show me what is running")).toBe(false);
    expect(isChoiceAnswer("")).toBe(false);
    expect(isChoiceAnswer("the one")).toBe(false);
  });
});
