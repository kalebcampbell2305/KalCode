import { describe, expect, it } from "vitest";
import { looksLikePrompt, screenFromOutput, screenFromReplay } from "./screen.ts";

describe("KalTidy prompt evidence", () => {
  it.each([
    ["PowerShell", "PS C:\\site> "],
    ["Command Prompt", "C:\\site>"],
    ["bash", "you@box:~/site$ "],
    ["root", "root@box:/# "],
    ["zsh", "site % "],
    ["starship / p10k", "~/site ❯ "],
    ["fish-like", "site » "],
    ["lambda", "λ "],
  ])("recognizes a %s prompt", (_, line) => {
    expect(looksLikePrompt(line)).toBe(true);
    expect(screenFromOutput(`banner\r\n${line}`)).toEqual({ line, atPrompt: true });
  });

  it.each([
    ["an empty line (a silent command)", "PS C:\\site> ./deploy.ps1\r\n"],
    ["Read-Host", "PS C:\\site> ./ask.ps1\r\nName: "],
    ["bash read", "$ read -p 'Continue? ' x\r\nContinue? "],
    ["Get-Content -Wait", "PS C:\\site> Get-Content log.txt -Wait\r\nline 1\r\nline 2\r\n"],
    ["text typed at the prompt", "PS C:\\site> git push"],
    ["nothing at all", ""],
  ])("does not count %s as a prompt", (_, output) => {
    expect(screenFromOutput(output).atPrompt).toBe(false);
  });

  it("strips colours, titles and cursor control", () => {
    const output = "\x1b]0;Windows PowerShell\x07\x1b[?25l\x1b[32mPS\x1b[0m C:\\site> \x1b[K\x1b[?25h";
    expect(screenFromOutput(output)).toEqual({ line: "PS C:\\site> ", atPrompt: true });
  });

  it("follows carriage returns, cursor moves and Backspace", () => {
    expect(screenFromOutput("Downloading 10%\rDownloading 90%").line).toBe("Downloading 90%");
    expect(screenFromOutput("PS C:\\site> \x1b[5;1HPS C:\\site> ls").atPrompt).toBe(false);
    expect(screenFromOutput("PS C:\\site> ab\b\b").atPrompt).toBe(true);
  });

  it("trusts shell-integration marks over the text", () => {
    // Prompt drawn (A … B) with nothing typed after it.
    expect(screenFromOutput("\x1b]133;A\x07~/site \x1b]133;B\x07").atPrompt).toBe(true);
    // Text typed after the prompt end.
    expect(screenFromOutput("\x1b]633;A\x07~/site \x1b]633;B\x07make").atPrompt).toBe(false);
    // A command is running (C), whatever the line looks like.
    expect(screenFromOutput("\x1b]133;A\x07$ \x1b]133;B\x07sleep 600\r\n\x1b]133;C\x07>").atPrompt).toBe(false);
  });

  it("reads only the scrollback's end", () => {
    const bytes = new TextEncoder().encode(`${"x".repeat(100_000)}\r\nPS C:\\site> `);
    expect(screenFromReplay(bytes)).toEqual({ line: "PS C:\\site> ", atPrompt: true });
  });
});
