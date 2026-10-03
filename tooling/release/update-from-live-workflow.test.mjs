import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const workflowPath = fileURLToPath(new URL("../../.github/workflows/update-from-live-verify.yml", import.meta.url));
const workflow = readFileSync(workflowPath, "utf8").replaceAll("\r", "");
const proofStep = workflow.split("      - name: Copy the pinned packet and run the update-from-live check\n")[1];

assert.ok(proofStep, "update-from-live proof step exists");

test("Windows PowerShell wrapper preserves both zero and nonzero child exits", {
  skip: process.platform !== "win32",
}, () => {
  const block = proofStep.slice(proofStep.indexOf("$processTimeoutMs ="), proofStep.indexOf("$r = Get-Content"));
  const script = `
$ErrorActionPreference = 'Stop'
foreach ($expected in @(0, 7)) {
  $a = @('-NoProfile', '-NonInteractive', '-Command', ('Start-Sleep -Milliseconds 100; exit ' + $expected))
  ${block}
  [pscustomobject]@{ expected = $expected; actual = $exitCode } | ConvertTo-Json -Compress
  $p.Dispose()
}`;
  const shell = join(
    process.env.SystemRoot ?? "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  const result = spawnSync(shell, ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 20_000,
  });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  const rows = result.stdout
    .trim()
    .split(/\r?\n/u)
    .map((line) => JSON.parse(line));
  assert.deepEqual(rows, [
    { expected: 0, actual: 0 },
    { expected: 7, actual: 7 },
  ]);
});

test("Windows update proof waits only for its wrapper process with a bounded timeout", () => {
  assert.match(workflow, /runs-on: \[self-hosted, Windows, kalcode-gate\]/u);
  assert.match(workflow, /timeout-minutes: 45/u);

  assert.match(proofStep, /\$processTimeoutMs = 40 \* 60 \* 1000/u);
  assert.match(proofStep, /\$p = Start-Process -FilePath powershell\.exe -ArgumentList \$a -NoNewWindow -PassThru/u);
  assert.doesNotMatch(proofStep, /Start-Process[^\n]*-Wait/u);
  assert.match(proofStep, /if \(-not \$p\.WaitForExit\(\$processTimeoutMs\)\) \{ throw [^\n]+ \}/u);
  assert.match(proofStep, /\$p\.Refresh\(\)\n\s+\$exitCode = \$p\.ExitCode/u);
  assert.doesNotMatch(proofStep, /Stop-Process|taskkill|\.Kill\(/iu);

  const start = proofStep.indexOf("$p = Start-Process");
  const wait = proofStep.indexOf("$p.WaitForExit($processTimeoutMs)");
  const refresh = proofStep.indexOf("$p.Refresh()");
  const exitCode = proofStep.indexOf("$exitCode = $p.ExitCode");
  const receipt = proofStep.indexOf("update-from-live-receipt.json");
  const augment = proofStep.indexOf("Add-Member -NotePropertyName github");
  const persist = proofStep.lastIndexOf("update-from-live-receipt.json");
  const validate = proofStep.indexOf("$exitCode -ne 0");

  assert.ok(
    start < wait && wait < refresh && refresh < exitCode,
    "capture the exact wrapper exit after the bounded wait",
  );
  assert.ok(
    exitCode < receipt && receipt < augment && augment < persist && persist < validate,
    "preserve receipt evidence before validation",
  );
});
