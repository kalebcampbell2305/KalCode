import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const workflowPath = fileURLToPath(new URL("../../.github/workflows/desktop-update-verify.yml", import.meta.url));
const scriptPath = fileURLToPath(new URL("../../.github/scripts/win-desktop-update-from-feed.ps1", import.meta.url));
const workflow = readFileSync(workflowPath, "utf8").replaceAll("\r", "");
const script = readFileSync(scriptPath, "utf8").replaceAll("\r", "");

test("desktop update workflow runs only on the dedicated desktop QA runner from main", () => {
  assert.match(workflow, /runs-on: \[self-hosted, Windows, kalcode-desktop-qa\]/u);
  assert.match(workflow, /if: github\.ref == 'refs\/heads\/main'/u);
  assert.match(workflow, /^on:\n {2}workflow_dispatch:/mu);
  assert.doesNotMatch(workflow, /^ {2}(push|pull_request|schedule):/mu, "dispatch only");
  assert.match(workflow, /permissions:\n {2}contents: read/u);
  assert.match(workflow, /persist-credentials: false/u);
  assert.match(workflow, /permissions:\n {6}contents: write/u, "draft reads require job-scoped push access");
  assert.match(script, /\$env:GH_TOKEN = \$null/u, "application must not inherit the draft-read token");
});

test("desktop update script checks account, session and owner PC before any action", () => {
  assert.match(script, /\$id\.Name -ine 'KALEBSLAPTOP\\kalcode-qa'/u, "Windows identity matching is case-insensitive");
  const firstAction = script.indexOf("Invoke-RestMethod");
  for (const guard of [
    "-notmatch '\\\\kalcode-qa$'",
    "if ($elevated)",
    "if ($me -eq 0)",
    "if ($env:COMPUTERNAME -eq 'DESKTOP-KOOB7VV')",
  ]) {
    const at = script.indexOf(guard);
    assert.ok(at > 0, `guard present: ${guard}`);
    assert.ok(at < firstAction, `guard runs before the first network or install action: ${guard}`);
  }
  assert.ok(
    script.indexOf('Refuse ("Stable feed serves') < script.indexOf("Invoke-WebRequest"),
    "feed check before install",
  );
});

test("desktop update script cleans up only after every guard passed", () => {
  const passed = script.indexOf("$guardsPassed = $true");
  assert.ok(passed > script.indexOf("if ($SelfTest)"), "self-test never reaches cleanup");
  assert.ok(passed > script.indexOf("if ($env:COMPUTERNAME -eq 'DESKTOP-KOOB7VV')"), "guards run first");
  assert.ok(passed < script.indexOf("Invoke-RestMethod"), "set before the first action");
  assert.match(script, /if \(\$guardsPassed\) \{ try \{ \$receipt\.cleanupClean = Cleanup \}/u);
  const cleanupCalls = script.match(/= Cleanup\b|\(Cleanup\)/gu) ?? [];
  assert.equal(
    cleanupCalls.length,
    2,
    "cleanup runs only from the guarded finally block and the post-guard leftover check",
  );
});

test("desktop update script does not open kalcode.exe while the update is being applied", () => {
  const apply = script.slice(script.indexOf("# 4. the staged candidate"), script.indexOf("if (-not $applied)"));
  assert.ok(
    apply.indexOf("if ($busy.Count) { continue }") < apply.indexOf("Installed"),
    "waits for helper and installer first",
  );
  assert.match(apply, /try \{ \$i = Installed \} catch \{ continue \}/u, "a locked file means not done yet");
});

test("desktop update script closes KalCode by its window, never by name", () => {
  assert.match(script, /\$p\.CloseMainWindow\(\)/u);
  assert.doesNotMatch(script, /taskkill/iu);
  const forced = script.match(/Stop-Process -Force/gu) ?? [];
  assert.equal(forced.length, 1, "the only forced stop is the counted QA-account cleanup");
  assert.match(script, /forcedProcessActions \+= \$left\.Count; \$left \| Stop-Process -Force/u);
});

test("desktop update script refuses any account other than kalcode-qa", { skip: process.platform !== "win32" }, () => {
  if ((process.env.USERNAME ?? "").toLowerCase() === "kalcode-qa") return;
  const out = mkdtempSync(join(tmpdir(), "desktop-update-selftest-"));
  try {
    const shell = join(
      process.env.SystemRoot ?? "C:\\Windows",
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    );
    const result = spawnSync(
      shell,
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath, "-OutDir", out, "-SelfTest"],
      { encoding: "utf8", windowsHide: true, timeout: 30_000 },
    );
    assert.equal(result.status, 1, result.stderr);
    const receipt = JSON.parse(readFileSync(join(out, "desktop-update-receipt.json"), "utf8").replace(/^\uFEFF/u, ""));
    assert.equal(receipt.status, "FAILED");
    assert.match(receipt.error, /REFUSED: runs only as the dedicated kalcode-qa account/u);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});
