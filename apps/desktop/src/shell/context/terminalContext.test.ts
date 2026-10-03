import type { Terminal } from "@xterm/xterm";
import { describe, expect, it, vi } from "vitest";
import { terminalContext } from "./terminalContext.ts";

describe("terminal context targeting", () => {
  it("uses the cursor line only for keyboard invocation, never a click on blank output", () => {
    const term = {
      getSelection: () => "",
      buffer: {
        active: { baseY: 0, cursorY: 2, getLine: vi.fn(() => ({ translateToString: () => "current cursor line" })) },
      },
    } as unknown as Terminal;
    expect(terminalContext(term, document.createElement("div"), "Agent").text).toBe("");
    expect(terminalContext(term, document.createElement("textarea"), "Agent", true).text).toBe("current cursor line");
    expect(term.buffer.active.getLine).toHaveBeenCalledOnce();
  });
});
