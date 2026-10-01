import { afterEach, describe, expect, it } from "vitest";
import {
  forgetTerminalActivity,
  lineAfterInput,
  noteTerminalInput,
  noteTerminalOutput,
  resetTerminalActivityForTests,
  terminalActivity,
} from "./activity.ts";

const clean = { buffer: "", edited: false };

afterEach(() => resetTerminalActivityForTests());

describe("lineAfterInput", () => {
  it("keeps typed text until Enter", () => {
    expect(lineAfterInput(clean, "git sta")).toEqual({ buffer: "git sta", edited: false });
    expect(lineAfterInput({ buffer: "git sta", edited: false }, "tus\r")).toEqual(clean);
  });

  it("Ctrl+C starts a clean line", () => {
    expect(lineAfterInput({ buffer: "rm -rf", edited: true }, "\x03")).toEqual(clean);
  });

  it("Backspace removes typed characters, back to a clean line", () => {
    expect(lineAfterInput(clean, "ls\x7f\x7f")).toEqual(clean);
    expect(lineAfterInput(clean, "ls\b")).toEqual({ buffer: "l", edited: false });
  });

  it("history recall, completion and Alt-keys mark the line edited", () => {
    expect(lineAfterInput(clean, "\x1b[A").edited).toBe(true); // Up arrow recalls history
    expect(lineAfterInput(clean, "\x1bOA").edited).toBe(true);
    expect(lineAfterInput(clean, "\t").edited).toBe(true);
    expect(lineAfterInput(clean, "\x1bb").edited).toBe(true);
  });

  it("ignores reports the terminal emulator sends by itself", () => {
    for (const report of [
      "\x1b[12;1R", // cursor position (ConPTY asks at start)
      "\x1b[?1;2c", // device attributes
      "\x1b[>0;276;0c",
      "\x1b[0n",
      "\x1b[?2004;1$y",
      "\x1b[I",
      "\x1b[O",
      "\x1b]11;rgb:0000/0000/0000\x07",
      "\x1b]10;rgb:ffff/ffff/ffff\x1b\\",
      "\x1b[<0;10;5M",
    ]) {
      expect(lineAfterInput(clean, report)).toEqual(clean);
    }
  });

  it("counts pasted text but not the paste brackets", () => {
    expect(lineAfterInput(clean, "\x1b[200~npm test\x1b[201~")).toEqual({ buffer: "npm test", edited: false });
    expect(lineAfterInput(clean, "\x1b[200~npm test\r\x1b[201~")).toEqual(clean);
  });
});

describe("terminal activity", () => {
  it("is empty for a terminal never seen", () => {
    expect(terminalActivity("t1")).toEqual({ lastOutputAt: null, lastInputAt: null, unsent: false });
  });

  it("tracks unsent input at the prompt until Enter", () => {
    noteTerminalInput("t1", "npm run bu", 1_000);
    expect(terminalActivity("t1")).toEqual({ lastOutputAt: null, lastInputAt: 1_000, unsent: true });
    noteTerminalInput("t1", "ild\r", 2_000);
    expect(terminalActivity("t1")).toEqual({ lastOutputAt: null, lastInputAt: 2_000, unsent: false });
  });

  it("emulator reports are not use", () => {
    noteTerminalInput("t1", "\x1b[3;1R", 5_000);
    expect(terminalActivity("t1")).toEqual({ lastOutputAt: null, lastInputAt: null, unsent: false });
  });

  it("records live output and forgets a closed terminal", () => {
    noteTerminalOutput("t1", 7_000);
    expect(terminalActivity("t1").lastOutputAt).toBe(7_000);
    forgetTerminalActivity("t1");
    expect(terminalActivity("t1").lastOutputAt).toBeNull();
  });

  it("keeps terminals apart", () => {
    noteTerminalInput("t1", "echo", 1);
    expect(terminalActivity("t2").unsent).toBe(false);
  });
});
