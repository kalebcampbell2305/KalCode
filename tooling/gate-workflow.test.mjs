import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const workflow = readFileSync(new URL("../.github/workflows/gate.yml", import.meta.url), "utf8");
const windows = workflow.split("\n  macos:")[0];
const steps = windows.split(/\n {6}- /).slice(1);
function script(step) {
  const block = step.split("\n        run: |\n")[1];
  if (block)
    return block
      .split("\n")
      .filter((line) => line.startsWith("          "))
      .map((line) => line.slice(10))
      .join("\n");
  return step.match(/^ {8}run: (.+)$/m)?.[1];
}

test("all Windows gate scripts parse, including conditional admission and cleanup", {
  skip: process.platform !== "win32",
}, () => {
  const scripts = steps.map(script).filter(Boolean);
  assert.ok(scripts.length >= 10);
  const input = `$scripts = '${JSON.stringify(scripts).replaceAll("'", "''")}' | ConvertFrom-Json
foreach ($script in $scripts) {
  $tokens = $null; $errors = $null
  [void][System.Management.Automation.Language.Parser]::ParseInput($script, [ref]$tokens, [ref]$errors)
  if ($errors.Count) { $errors | Out-String | Write-Output; exit 1 }
}`;
  const result = spawnSync("powershell.exe", ["-NoProfile", "-Command", input], {
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test("main reuses only an exact successful candidate on a trusted pool worker", {
  skip: process.platform !== "win32",
}, () => {
  const reuse = script(steps.find((step) => step.startsWith("name: Reuse the merge-train")));
  assert.ok(reuse);
  const sha = "a".repeat(40);
  const root = mkdtempSync(join(tmpdir(), "kalcode-gate-reuse-"));
  const baseline = {
    run: {
      id: 123,
      head_sha: sha,
      event: "push",
      path: ".github/workflows/gate.yml",
      head_branch: "merge-train/aaaaaaaaaaaa-12345678",
      status: "completed",
      conclusion: "success",
      html_url: "https://example.invalid/gate/123",
    },
    job: {
      name: "Gate (Windows)",
      conclusion: "success",
      head_sha: sha,
      runner_name: "kalcode-win-gate-w5",
      labels: ["self-hosted", "Windows", "kalcode-gate", "kalcode-main-pc"],
      steps: [{ name: "Gate", conclusion: "success" }],
    },
  };
  const cases = [
    ["exact", {}, true],
    ["other-sha", { run: { head_sha: "b".repeat(40) } }, false],
    ["second-pc", { job: { runner_name: "kalcode-win-gate-2" } }, false],
    ["extra-slot", { job: { runner_name: "kalcode-win-gate-w6" } }, false],
    ["missing-host-label", { job: { labels: ["self-hosted", "Windows", "kalcode-gate"] } }, false],
    ["skipped-check", { job: { steps: [{ name: "Gate", conclusion: "skipped" }] } }, false],
    ["cancelled-run", { run: { conclusion: "cancelled" } }, false],
  ];
  for (const [name, patch, expected] of cases) {
    const fixture = { run: { ...baseline.run, ...patch.run }, job: { ...baseline.job, ...patch.job } };
    const output = join(root, `${name}.out`);
    const path = join(root, `${name}.ps1`);
    writeFileSync(output, "");
    writeFileSync(
      path,
      `$fixture = '${JSON.stringify(fixture).replaceAll("'", "''")}' | ConvertFrom-Json
function Invoke-RestMethod {
  param($Headers, $Uri)
  if ($Uri -match '/jobs\\?filter=latest&per_page=100$') { return @{ jobs = @($fixture.job) } }
  if ($Uri -match '/runs\\?head_sha=') { return @{ workflow_runs = @($fixture.run) } }
  throw 'Unexpected evidence API request'
}
${reuse}`,
    );
    const result = spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path], {
      encoding: "utf8",
      windowsHide: true,
      env: {
        ...process.env,
        GH_TOKEN: "fixture-only",
        GITHUB_API_URL: "https://example.invalid",
        GITHUB_REPOSITORY: "fixture/repo",
        GITHUB_SHA: sha,
        GITHUB_RUN_ID: "456",
        GITHUB_OUTPUT: output,
      },
    });
    assert.equal(result.status, 0, `${name}: ${result.stdout}${result.stderr}`);
    assert.equal(
      readFileSync(output, "utf8").trim() === "reused=true",
      expected,
      `${name}: ${result.stdout}${result.stderr}`,
    );
  }
});

test("selected-check outputs use Actions-compatible bytes on Windows PowerShell", {
  skip: process.platform !== "win32",
}, () => {
  const plan = script(steps.find((step) => step.startsWith("name: Plan change-based gate")));
  const outputs = plan.split("\n").filter((line) => line.includes("$env:GITHUB_OUTPUT"));
  assert.equal(outputs.length, 3);
  const root = mkdtempSync(join(tmpdir(), "kalcode-gate-output-"));
  for (const [name, ids, expected] of [
    ["native", ["desktop-native-e2e"], "python=true\nnative=true\nbrowsers=true"],
    ["tooling", ["tooling-unit"], "python=true\nnative=false\nbrowsers=false"],
    ["ui", ["desktop-ui"], "python=false\nnative=false\nbrowsers=true"],
  ]) {
    const output = join(root, name);
    writeFileSync(output, "");
    const result = spawnSync(
      "powershell.exe",
      ["-NoProfile", "-Command", `$ids = @('${ids.join("','")}')\n${outputs.join("\n")}`],
      {
        encoding: "utf8",
        windowsHide: true,
        env: { ...process.env, GITHUB_OUTPUT: output },
      },
    );
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(readFileSync(output, "utf8").trim().replaceAll("\r\n", "\n"), expected);
  }
});
