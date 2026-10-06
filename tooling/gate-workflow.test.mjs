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

test("the full Windows gate runs only on the main-PC pool", () => {
  assert.doesNotMatch(workflow, /^ {2}pc2:/m);
  assert.doesNotMatch(workflow, /gate-split\.mjs/);
  assert.match(workflow, /^ {4}runs-on: \[self-hosted, Windows, kalcode-gate, kalcode-main-pc\]$/m);
  const plan = script(steps.find((step) => step.startsWith("name: Plan change-based gate")));
  assert.match(plan, /\$ids = @\(\$plan \| Where-Object/);
  const gate = script(steps.find((step) => step.startsWith("name: Gate\n")));
  assert.match(gate, /ship\.mjs gate --base \$env:KALCODE_GATE_BASE --jobs/);
  assert.doesNotMatch(gate, /--only/);
});

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

test("checkout keeps the warm target: clean:false, exact-SHA reset, orphans stopped before and after", () => {
  const names = steps.map((step) => step.match(/^name: (.+)$/m)?.[1] ?? step.split("\n")[0]);
  const checkout = steps.findIndex((step) => step.startsWith("uses: actions/checkout@"));
  const before = names.indexOf("Stop this worker's orphaned processes");
  const reset = names.indexOf("Reset to the exact event SHA, keeping warm caches");
  const plan = names.indexOf("Plan change-based gate");
  const after = names.indexOf("Stop processes this job left behind");
  // Gate 37362947496: checkout's git clean -ffdx failed on DLLs an orphan held in the warm target.
  assert.match(steps[checkout], /^ {10}clean: false$/m);
  assert.ok(before >= 0 && before < checkout, "orphans stop before checkout");
  assert.ok(checkout < reset && reset < plan, "the exact-SHA reset runs before any check is planned");
  assert.equal(after, steps.length - 1, "the post-job orphan stop is the last step");
  assert.match(steps[after], /^ {8}if: always\(\)$/m);
  assert.match(script(steps[reset]), /gate-workspace-hygiene\.ps1 -Phase Reset/);
  assert.match(script(steps[after]), /gate-workspace-hygiene\.ps1 -Phase Stop/);
  // The inline pre-checkout stop is scoped to this worker's _work and never stops the live job.
  const inline = script(steps[before]);
  assert.match(inline, /RUNNER_WORKSPACE/);
  assert.match(inline, /_work/);
  assert.match(inline, /Runner\\.\(Worker\|Listener\)/);
  assert.match(inline, /taskkill\.exe \/T \/F/);
  const hygiene = readFileSync(new URL("../.github/scripts/gate-workspace-hygiene.ps1", import.meta.url), "utf8");
  assert.match(hygiene, /git reset --hard --quiet \$env:GITHUB_SHA/);
  assert.match(hygiene, /git clean -ffdxq -e target\/ -e node_modules\//);
  assert.match(hygiene, /Checkout does not match the immutable event SHA/);
  assert.match(hygiene, /gate-evidence\.json/);
});

test("the workspace hygiene script parses and refuses a non-_work root", { skip: process.platform !== "win32" }, () => {
  const path = new URL("../.github/scripts/gate-workspace-hygiene.ps1", import.meta.url);
  const parse = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-Command",
      `$e=$null; [void][System.Management.Automation.Language.Parser]::ParseFile('${decodeURIComponent(path.pathname.slice(1)).replaceAll("/", "\\")}',[ref]$null,[ref]$e); if ($e) { $e | Out-String; exit 1 }`,
    ],
    { encoding: "utf8", windowsHide: true },
  );
  assert.equal(parse.status, 0, parse.stdout + parse.stderr);
  const dir = mkdtempSync(join(tmpdir(), "kc-hygiene-"));
  const refused = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", decodeURIComponent(path.pathname.slice(1)), "-Phase", "Stop"],
    { encoding: "utf8", windowsHide: true, env: { ...process.env, RUNNER_WORKSPACE: join(dir, "repo") } },
  );
  assert.notEqual(refused.status, 0);
  assert.match(refused.stdout + refused.stderr, /Refusing to clean outside a runner _work directory/);
});
