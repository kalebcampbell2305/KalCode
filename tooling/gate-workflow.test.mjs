import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const workflow = readFileSync(new URL("../.github/workflows/gate.yml", import.meta.url), "utf8");
// Two Windows jobs test the same SHA: the build PC's pool ("windows") and the second PC ("pc2").
const windows = workflow.split("\n  pc2:")[0];
const pc2Job = workflow.split("\n  pc2:")[1].split("\n  macos:")[0];
const steps = windows.split(/\n {6}- /).slice(1);
const pc2Steps = pc2Job.split(/\n {6}- /).slice(1);
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
    pc2: {
      name: "Gate (Windows, PC2)",
      conclusion: "success",
      head_sha: sha,
      runner_name: "kalcode-win-gate-2",
      labels: ["self-hosted", "Windows", "kalcode-gate-pc2"],
      steps: [{ name: "Gate", conclusion: "success" }],
    },
    native: {
      name: "Gate (Windows, native)",
      conclusion: "success",
      head_sha: sha,
      runner_name: "kalcode-win-gate-w2",
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
    // A split gate needs the second PC's half green too; a legacy run without it keeps single-job reuse.
    ["split-both-green", { pc2: {} }, true],
    ["split-pc2-red", { pc2: { conclusion: "failure" } }, false],
    ["split-pc2-wrong-runner", { pc2: { runner_name: "kalcode-win-gate-w1" } }, false],
    ["split-pc2-other-sha", { pc2: { head_sha: "b".repeat(40) } }, false],
    ["split-pc2-skipped-check", { pc2: { steps: [{ name: "Gate", conclusion: "skipped" }] } }, false],
    // A two-job build-PC half needs its native job green on a pool worker too.
    ["native-all-green", { pc2: {}, native: {} }, true],
    ["native-red", { pc2: {}, native: { conclusion: "failure" } }, false],
    ["native-on-second-pc", { pc2: {}, native: { runner_name: "kalcode-win-gate-2" } }, false],
    ["native-missing-host-label", { pc2: {}, native: { labels: ["self-hosted", "Windows", "kalcode-gate"] } }, false],
    ["native-other-sha", { pc2: {}, native: { head_sha: "b".repeat(40) } }, false],
    ["native-skipped-check", { pc2: {}, native: { steps: [{ name: "Gate", conclusion: "skipped" }] } }, false],
  ];
  for (const [name, patch, expected] of cases) {
    const fixture = {
      run: { ...baseline.run, ...patch.run },
      job: { ...baseline.job, ...patch.job },
      pc2: patch.pc2 === undefined ? null : { ...baseline.pc2, ...patch.pc2 },
      native: patch.native === undefined ? null : { ...baseline.native, ...patch.native },
    };
    const output = join(root, `${name}.out`);
    const path = join(root, `${name}.ps1`);
    writeFileSync(output, "");
    writeFileSync(
      path,
      `$fixture = '${JSON.stringify(fixture).replaceAll("'", "''")}' | ConvertFrom-Json
function Invoke-RestMethod {
  param($Headers, $Uri)
  if ($Uri -match '/jobs\\?filter=latest&per_page=100$') { return @{ jobs = @(@($fixture.job) + @($fixture.pc2 | Where-Object { $_ }) + @($fixture.native | Where-Object { $_ })) } }
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

test("a release kit PR that changes only the release record and notes skips both gate halves", {
  skip: process.platform !== "win32",
}, () => {
  const record = "apps/website/src/data/releases.json";
  const notes = "docs/releases/0.1.9+1908.md";
  const cases = [
    ["record-and-notes", [{ filename: record }, { filename: notes }], true],
    ["notes-only", [{ filename: notes }], true],
    ["plus-code", [{ filename: record }, { filename: "apps/desktop/src/main.tsx" }], false],
    ["other-website-file", [{ filename: record }, { filename: "apps/website/src/pages/updates.astro" }], false],
    ["renamed-from-code", [{ filename: notes, previous_filename: "tooling/merge-train/train.mjs" }], false],
    ["renamed-within-notes", [{ filename: notes, previous_filename: "docs/releases/old.md" }], true],
    ["no-files", [], false],
    ["api-error", null, false],
  ];
  const root = mkdtempSync(join(tmpdir(), "kalcode-gate-records-"));
  for (const [job, jobSteps] of [
    ["windows", steps],
    ["pc2", pc2Steps],
  ]) {
    const step = jobSteps.find((s) => s.startsWith("name: Reuse the merge-train"));
    assert.match(step, /startsWith\(github\.head_ref, 'release\/website-'\)/, `${job}: only kit branches qualify`);
    const reuse = script(step);
    for (const [name, files, expected] of cases) {
      const output = join(root, `${job}-${name}.out`);
      const path = join(root, `${job}-${name}.ps1`);
      writeFileSync(output, "");
      writeFileSync(
        path,
        `$fixtureFiles = '${JSON.stringify(files).replaceAll("'", "''")}' | ConvertFrom-Json
function Invoke-RestMethod {
  param($Headers, $Uri)
  if ($Uri -match '/pulls/304/files\\?per_page=100&page=1$') { if ($null -eq $fixtureFiles) { throw 'HTTP 502' }; return $fixtureFiles }
  throw "Unexpected request $Uri"
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
          GITHUB_EVENT_NAME: "pull_request",
          PR_NUMBER: "304",
          GITHUB_OUTPUT: output,
        },
      });
      assert.equal(result.status, 0, `${job} ${name}: ${result.stdout}${result.stderr}`);
      assert.equal(
        readFileSync(output, "utf8").trim() === "reused=true",
        expected,
        `${job} ${name}: ${result.stdout}${result.stderr}`,
      );
    }
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

test("both halves reuse with the identical evidence rule", () => {
  const reuse = (list) => script(list.find((step) => step.startsWith("name: Reuse the merge-train")));
  assert.ok(reuse(steps));
  assert.equal(reuse(pc2Steps), reuse(steps));
});

test("the second PC's half is self-contained and gates the same exact candidate", () => {
  const names = pc2Steps.map((step) => step.match(/^name: (.+)$/m)?.[1] ?? step.split("\n")[0]);
  assert.match(pc2Job, /^ {4}name: Gate \(Windows, PC2\)$/m);
  assert.match(pc2Job, /^ {4}runs-on: \[self-hosted, Windows, kalcode-gate-pc2\]$/m);
  assert.match(pc2Job, /head\.repo\.full_name == github\.repository/, "fork guard");
  assert.match(pc2Job, /persist-credentials: false/);
  assert.match(pc2Job, /clean: false/);
  assert.doesNotMatch(pc2Job, /KalCodeGatePool|Assert-GateWorkerHost|gate-worker-hook|kalcode-main-pc\]/);
  const plan = script(pc2Steps[names.indexOf("Plan change-based gate")]);
  assert.match(plan, /RUNNER_NAME -ne 'kalcode-win-gate-2'/);
  assert.match(plan, /trailers:key=Merge-Train-Base,valueonly/);
  assert.match(plan, /Checkout does not match the immutable event SHA/);
  assert.match(plan, /gate-split\.mjs pc2/);
  for (const port of ["4691", "4692", "9701", "1791", "39333"]) assert.ok(plan.includes(port), `fixed port ${port}`);
  const gate = script(pc2Steps[names.indexOf("Gate")]);
  assert.match(gate, /BelowNormal/);
  assert.match(gate, /--only \$env:KALCODE_GATE_ONLY/);
  assert.match(gate, /nothing selected for the second PC/);
  assert.equal(names.indexOf("Stop this worker's orphaned processes"), 1);
  assert.equal(names.at(-1), "Stop processes this job left behind");
  assert.ok(
    names.indexOf("Reset to the exact event SHA, keeping warm caches") < names.indexOf("Plan change-based gate"),
  );
});

test("the second PC's plan outputs pick Python and browsers for its own checks", {
  skip: process.platform !== "win32",
}, () => {
  const names = pc2Steps.map((step) => step.match(/^name: (.+)$/m)?.[1] ?? "");
  const plan = script(pc2Steps[names.indexOf("Plan change-based gate")]);
  const outputs = plan.split("\n").filter((line) => line.includes("$env:GITHUB_OUTPUT"));
  assert.equal(outputs.length, 2);
  const root = mkdtempSync(join(tmpdir(), "kalcode-gate-pc2-output-"));
  for (const [name, ids, expected] of [
    ["tooling", ["tooling-unit"], "python=true\nbrowsers=false"],
    ["website", ["website-e2e"], "python=false\nbrowsers=true"],
    ["none", [], "python=false\nbrowsers=false"],
  ]) {
    const output = join(root, name);
    writeFileSync(output, "");
    const result = spawnSync(
      "powershell.exe",
      ["-NoProfile", "-Command", `$ids = @(${ids.map((id) => `'${id}'`).join(",")})\n${outputs.join("\n")}`],
      { encoding: "utf8", windowsHide: true, env: { ...process.env, GITHUB_OUTPUT: output } },
    );
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(readFileSync(output, "utf8").trim().replaceAll("\r\n", "\n"), expected);
  }
});

test("the gate split runs every selected check exactly once across the three jobs", async () => {
  const { NATIVE_GATES, PC2_GATES, splitGateIds } = await import("./release/lifecycle/gate-split.mjs");
  const policy = JSON.parse(readFileSync(new URL("./release/lifecycle/policy.json", import.meta.url), "utf8"));
  const all = policy.gates.map((gate) => gate.id);
  for (const id of [...PC2_GATES, ...NATIVE_GATES]) assert.ok(all.includes(id), `${id} is a real gate`);
  const { main, native, pc2 } = splitGateIds(all);
  assert.deepEqual([...main, ...native, ...pc2].sort(), [...all].sort());
  assert.equal(new Set([...main, ...native, ...pc2]).size, all.length);
  // Checkout writers and the pool-only Cargo tools run in the build PC's native job.
  for (const id of ["rust", "desktop-native-e2e", "cargo-deny", "cargo-audit"])
    assert.ok(native.includes(id), `${id} runs in the build PC's native job`);
  // The desktop readers run in the build PC's main job, in parallel with the native chain.
  for (const id of ["desktop-frontend", "desktop-ui"])
    assert.ok(main.includes(id), `${id} stays in the build PC's main job`);
  assert.deepEqual(
    splitGateIds(["a-check-added-later"]).main,
    ["a-check-added-later"],
    "new checks default to the build PC's main job",
  );
  assert.deepEqual(splitGateIds([]), { main: [], native: [], pc2: [] });
  const cli = (machine, ids) =>
    spawnSync(
      process.execPath,
      [fileURLToPath(new URL("./release/lifecycle/gate-split.mjs", import.meta.url)), machine, ids],
      {
        encoding: "utf8",
      },
    );
  assert.equal(cli("main", "biome,rust,desktop-ui,website-e2e").stdout, "desktop-ui");
  assert.equal(cli("native", "biome,rust,desktop-ui,website-e2e").stdout, "rust");
  assert.equal(cli("pc2", "biome,rust,desktop-ui,website-e2e").stdout, "biome,website-e2e");
  assert.equal(cli("pc2", "").stdout, "");
  assert.equal(cli("elsewhere", "rust").status, 2);
});

test("the build PC's gate runs as two matrix jobs that never cancel each other", () => {
  const header = windows.split(/\n {4}steps:/)[0];
  assert.match(
    header,
    /name: \$\{\{ matrix\.half == 'native' && 'Gate \(Windows, native\)' \|\| 'Gate \(Windows\)' \}\}/,
  );
  assert.match(header, /fail-fast: false/);
  assert.match(header, /half: \[main, native\]/);
  const plan = script(steps.find((step) => step.startsWith("name: Plan change-based gate")));
  assert.match(plan, /gate-split\.mjs \$env:GATE_HALF/);
  assert.match(plan, /Unknown build-PC gate half/);
  const evidence = steps.find((step) => step.startsWith("name: Preserve exact candidate evidence"));
  assert.match(
    evidence,
    /gate-evidence-\$\{\{ matrix\.half == 'native' && 'native-' \|\| '' \}\}/,
    "distinct artifact per job",
  );
});

test("every gate job keeps bounded Playwright failure evidence, on failure only", () => {
  for (const [job, jobSteps, prefix] of [
    ["windows", steps, "$" + "{{ matrix.half == 'native' && 'native-' || '' }}"],
    ["pc2", pc2Steps, "pc2-"],
  ]) {
    const names = jobSteps.map((step) => step.match(/^name: (.+)$/m)?.[1] ?? "");
    const measure = jobSteps[names.indexOf("Measure Playwright failure evidence")];
    const upload = jobSteps[names.indexOf("Preserve Playwright failure evidence")];
    assert.ok(measure && upload, job);
    assert.ok(names.indexOf("Gate") < names.indexOf("Measure Playwright failure evidence"), `${job}: after the gate`);
    assert.ok(measure.includes("if: steps.reuse.outputs.reused != 'true' && failure()"), `${job}: failure only`);
    assert.ok(script(measure).includes("$limit = 200MB"), `${job}: bounded`);
    assert.ok(
      upload.includes("failure() && steps.playwright_evidence.outputs.keep == 'true'"),
      `${job}: only within the bound`,
    );
    assert.ok(upload.includes(`name: gate-playwright-${prefix}`), `${job}: distinct artifact per job`);
    assert.ok(upload.includes("apps/desktop/test-results/"));
    assert.match(upload, /retention-days: 7/);
  }
});
