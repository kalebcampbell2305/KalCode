import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const workflow = readFileSync(new URL("../.github/workflows/gate.yml", import.meta.url), "utf8");
// The Windows jobs test the same SHA, all on the elastic gate pool (owner, 2026-10-08): the two-job
// "windows" matrix and the JS/web "pc2" job (its name is historical). Either PC's named runners may take any.
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

test("main reuses only an exact successful candidate on a trusted gate host", {
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
    e2e: {
      name: "Gate (Windows, native E2E)",
      conclusion: "success",
      head_sha: sha,
      runner_name: "kalcode-win-gate-2b",
      labels: ["self-hosted", "Windows", "kalcode-gate-pool"],
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
    // The second PC's second runner is equally trusted; any other name is not.
    ["split-pc2-second-runner", { pc2: { runner_name: "kalcode-win-gate-2b" } }, true],
    ["split-pc2-third-runner", { pc2: { runner_name: "kalcode-win-gate-2c" } }, true],
    ["split-pc2-unknown-runner", { pc2: { runner_name: "kalcode-win-gate-2e" } }, false],
    ["split-pc2-other-sha", { pc2: { head_sha: "b".repeat(40) } }, false],
    ["split-pc2-skipped-check", { pc2: { steps: [{ name: "Gate", conclusion: "skipped" }] } }, false],
    // A two-job build-PC half needs its native job green on a pool worker too.
    ["native-all-green", { pc2: {}, native: {} }, true],
    ["native-red", { pc2: {}, native: { conclusion: "failure" } }, false],
    ["native-on-second-pc", { pc2: {}, native: { runner_name: "kalcode-win-gate-2" } }, false],
    ["native-missing-host-label", { pc2: {}, native: { labels: ["self-hosted", "Windows", "kalcode-gate"] } }, false],
    ["native-other-sha", { pc2: {}, native: { head_sha: "b".repeat(40) } }, false],
    ["native-skipped-check", { pc2: {}, native: { steps: [{ name: "Gate", conclusion: "skipped" }] } }, false],
    // The native E2E job runs beside the Rust job; a run that has it needs it green on a trusted host too.
    ["e2e-all-green", { pc2: {}, native: {}, e2e: {} }, true],
    ["e2e-red", { pc2: {}, native: {}, e2e: { conclusion: "failure" } }, false],
    ["e2e-cancelled", { pc2: {}, native: {}, e2e: { conclusion: "cancelled" } }, false],
    ["e2e-unknown-runner", { pc2: {}, native: {}, e2e: { runner_name: "kalcode-win-gate-2e" } }, false],
    ["e2e-no-pool-label", { pc2: {}, native: {}, e2e: { labels: ["self-hosted", "Windows"] } }, false],
    ["e2e-other-sha", { pc2: {}, native: {}, e2e: { head_sha: "b".repeat(40) } }, false],
    ["e2e-skipped-check", { pc2: {}, native: {}, e2e: { steps: [{ name: "Gate", conclusion: "skipped" }] } }, false],
    ["e2e-green-native-red", { pc2: {}, native: { conclusion: "failure" }, e2e: {} }, false],
    // Owner, 2026-10-07: every gate job runs on the second PC's runners; those are trusted hosts too.
    [
      "pc2-hosted",
      { job: { runner_name: "kalcode-win-gate-2", labels: ["self-hosted", "Windows", "kalcode-gate-pc2"] } },
      true,
    ],
    [
      "pc2-hosted-all",
      {
        job: { runner_name: "kalcode-win-gate-2b", labels: ["self-hosted", "Windows", "kalcode-gate-pc2"] },
        pc2: {},
        native: { runner_name: "kalcode-win-gate-2", labels: ["self-hosted", "Windows", "kalcode-gate-pc2"] },
      },
      true,
    ],
    [
      "pc2-label-pool-name",
      { job: { runner_name: "kalcode-win-gate-w1", labels: ["self-hosted", "Windows", "kalcode-gate-pc2"] } },
      false,
    ],
    [
      "pc2-name-main-pc-label",
      {
        job: {
          runner_name: "kalcode-win-gate-2",
          labels: ["self-hosted", "Windows", "kalcode-gate-pc2", "kalcode-main-pc"],
        },
      },
      false,
    ],
    [
      "pc2-fourth-runner",
      { job: { runner_name: "kalcode-win-gate-2d", labels: ["self-hosted", "Windows", "kalcode-gate-pc2"] } },
      true,
    ],
    [
      "pc2-unknown-runner",
      { job: { runner_name: "kalcode-win-gate-2e", labels: ["self-hosted", "Windows", "kalcode-gate-pc2"] } },
      false,
    ],
  ];
  for (const [name, patch, expected] of cases) {
    const fixture = {
      run: { ...baseline.run, ...patch.run },
      job: { ...baseline.job, ...patch.job },
      pc2: patch.pc2 === undefined ? null : { ...baseline.pc2, ...patch.pc2 },
      native: patch.native === undefined ? null : { ...baseline.native, ...patch.native },
      e2e: patch.e2e === undefined ? null : { ...baseline.e2e, ...patch.e2e },
    };
    const output = join(root, `${name}.out`);
    const path = join(root, `${name}.ps1`);
    writeFileSync(output, "");
    writeFileSync(
      path,
      `$fixture = '${JSON.stringify(fixture).replaceAll("'", "''")}' | ConvertFrom-Json
function Invoke-RestMethod {
  param($Headers, $Uri)
  if ($Uri -match '/jobs\\?filter=latest&per_page=100$') { return @{ jobs = @(@($fixture.job) + @($fixture.pc2 | Where-Object { $_ }) + @($fixture.native | Where-Object { $_ }) + @($fixture.e2e | Where-Object { $_ })) } }
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
        // The main-push path: never the job's own event (a pull_request gate runs this suite too).
        GITHUB_EVENT_NAME: "push",
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
  // machine, python, native, browsers.
  assert.equal(outputs.length, 4);
  assert.match(outputs[0], /^"machine=\$\(\$gateHost\.Machine\)"/);
  const root = mkdtempSync(join(tmpdir(), "kalcode-gate-output-"));
  for (const [name, ids, expected] of [
    ["native", ["desktop-native-e2e"], "machine=pc2\npython=true\nnative=true\nbrowsers=true"],
    // The Rust half needs none of the native E2E's Python, CMake/libclang or browsers.
    ["rust", ["rust", "cargo-deny", "cargo-audit"], "machine=pc2\npython=false\nnative=false\nbrowsers=false"],
    ["tooling", ["tooling-unit"], "machine=pc2\npython=true\nnative=false\nbrowsers=false"],
    ["ui", ["desktop-ui"], "machine=pc2\npython=false\nnative=false\nbrowsers=true"],
  ]) {
    const output = join(root, name);
    writeFileSync(output, "");
    const result = spawnSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        `$gateHost = [pscustomobject]@{ Machine = 'pc2' }\n$ids = @('${ids.join("','")}')\n${outputs.join("\n")}`,
      ],
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

test("the JS/web job is self-contained, runs on the pool and gates the same exact candidate", () => {
  const names = pc2Steps.map((step) => step.match(/^name: (.+)$/m)?.[1] ?? step.split("\n")[0]);
  assert.match(pc2Job, /^ {4}name: Gate \(Windows, PC2\)$/m);
  assert.match(
    pc2Job,
    /^ {4}runs-on: \[self-hosted, Windows, kalcode-gate-pc2\]$/m,
    "the light JS/web job stays on the second PC",
  );
  assert.match(pc2Job, /head\.repo\.full_name == github\.repository/, "fork guard");
  assert.match(pc2Job, /persist-credentials: false/);
  assert.match(pc2Job, /clean: false/);
  // It runs on either PC, but needs none of the build PC's admission hooks or slots in its own steps: the
  // machine-specific choices all come from gate-host.ps1.
  assert.doesNotMatch(pc2Job, /KalCodeGatePool|Assert-GateWorkerHost|gate-worker-hook|kalcode-main-pc\]/);
  assert.ok(!names.includes("Admit optional gate work") && !names.includes("Release optional gate slot"));
  const plan = script(pc2Steps[names.indexOf("Plan change-based gate")]);
  assert.match(plan, /\. \.github\/scripts\/gate-host\.ps1/);
  assert.match(plan, /\$gateHost = Get-GateHost\b/);
  assert.match(plan, /Get-GateHostEnv \$gateHost/);
  assert.match(plan, /trailers:key=Merge-Train-Base,valueonly/);
  assert.match(plan, /Checkout does not match the immutable event SHA/);
  assert.match(plan, /gate-split\.mjs pc2/);
  const gate = script(pc2Steps[names.indexOf("Gate")]);
  // Below normal only on the build PC; the second PC runs its JS/web checks at normal priority.
  assert.match(
    gate,
    /if \(\$env:KALCODE_GATE_MACHINE -eq 'main-pc'\) \{ \(Get-Process -Id \$PID\)\.PriorityClass = 'BelowNormal' \}/,
  );
  // The second PC's machine lock, taken on every run (a no-op on the build PC, which has no lock folder).
  assert.match(gate, /^\s*\. \.github\/scripts\/pc2-machine-lock\.ps1$/m);
  assert.match(gate, /--only \$env:KALCODE_GATE_ONLY/);
  assert.match(gate, /nothing selected for the JS\/web job/);
  assert.equal(names.indexOf("Stop this worker's orphaned processes"), 1);
  assert.equal(names.at(-1), "Stop processes this job left behind");
  assert.ok(
    names.indexOf("Reset to the exact event SHA, keeping warm caches") < names.indexOf("Plan change-based gate"),
  );
});

const gateHostPath = fileURLToPath(new URL("../.github/scripts/gate-host.ps1", import.meta.url));
const repoRoot = fileURLToPath(new URL("..", import.meta.url));
// Dot-source gate-host.ps1 as a job does, from the repo root, and report what Get-GateHost picks.
function gateHostFor(runner, expression = "Get-GateHost | ConvertTo-Json -Compress", extraEnv = {}) {
  return spawnSync(
    "powershell.exe",
    ["-NoProfile", "-Command", `$ErrorActionPreference = 'Stop'\n. '${gateHostPath}'\n${expression}`],
    { encoding: "utf8", windowsHide: true, cwd: repoRoot, env: { ...process.env, RUNNER_NAME: runner, ...extraEnv } },
  );
}

test("gate-host.ps1 gives each second-PC runner its own port block and lock dir, and accepts no other name", {
  skip: process.platform !== "win32",
}, () => {
  const host = (runner) => {
    const result = gateHostFor(runner);
    assert.equal(result.status, 0, result.stderr + result.stdout);
    return JSON.parse(result.stdout);
  };
  for (const [runner, slot, ports] of [
    ["kalcode-win-gate-2", 0, [4691, 4692, 9701, 1791, 39333]],
    ["kalcode-win-gate-2b", 1, [4711, 4712, 9721, 1811, 39353]],
    ["kalcode-win-gate-2c", 2, [4731, 4732, 9741, 1831, 39373]],
    ["kalcode-win-gate-2d", 3, [4751, 4752, 9761, 1851, 39393]],
  ]) {
    const got = host(runner);
    assert.equal(got.Machine, "pc2", runner);
    assert.equal(got.Slot, slot, runner);
    assert.deepEqual([got.E2ePort, got.MailPort, got.InspectorPort, got.UiPort, got.CdpPort], ports, runner);
    assert.equal(got.LockDir, "C:\\ProgramData\\KalCodePC2\\locks", runner);
    assert.deepEqual([got.Env].flat().filter(Boolean), [], "PC2 has no pool slot env");
  }
  // The GITHUB_ENV lines for a PC2 job.
  const env = gateHostFor("kalcode-win-gate-2b", "Get-GateHostEnv (Get-GateHost)");
  assert.equal(env.status, 0, env.stderr);
  assert.deepEqual(env.stdout.trim().split(/\r?\n/), [
    "KALCODE_GATE_MACHINE=pc2",
    "KALCODE_E2E_PORT=4711",
    "KALCODE_E2E_MAIL_PORT=4712",
    "KALCODE_E2E_INSPECTOR_PORT=9721",
    "KALCODE_UI_TEST_PORT=1811",
    "KALCODE_E2E_CDP_PORT=39353",
    "KALCODE_GATE_LOCK_DIR=C:\\ProgramData\\KalCodePC2\\locks",
  ]);
  // No other runner name is accepted, whatever label it carries.
  for (const runner of ["kalcode-win-gate-2e", "kalcode-win-gate-w6", "kalcode-win-gate-w0", "random-runner", ""]) {
    const unknown = gateHostFor(runner);
    assert.notEqual(unknown.status, 0, `${runner || "(none)"} must be refused`);
    assert.match(unknown.stderr + unknown.stdout, /Unknown gate runner/);
  }
});

test("gate-host.ps1 maps build-PC workers to main-pc, the pool's ports and the heavy-token lock dir", () => {
  const source = readFileSync(gateHostPath, "utf8");
  assert.match(source, /\^kalcode-win-gate\(-w\[1-5\]\)\?\$/, "the original worker and w1..w5 only");
  assert.match(source, /Machine = 'main-pc'/);
  assert.match(source, /Assert-GateWorkerHost/, "build-PC resources only on the build PC");
  assert.match(source, /Get-GateWorkerPlan -Slot \$slot/);
  assert.match(source, /LockDir = 'C:\\ProgramData\\KalCodeGatePool\\heavy'/);
  assert.match(source, /LockDir = 'C:\\ProgramData\\KalCodePC2\\locks'/);
  assert.match(source, /KALCODE_GATE_SLOT=\$slot/);
  assert.match(source, /KALCODE_GATE_REPORT_DIR=C:\\ProgramData\\KalCodeGatePool\\reports/);
  assert.match(source, /KALCODE_GATE_EVIDENCE_DIR=C:\\ProgramData\\KalCodeGatePool\\evidence/);
  assert.match(source, /throw "Unknown gate runner: \$RunnerName"/);
});

// Runs on every Windows gate machine (a skipped test is outside test-suites' reviewed bounds): on the build PC
// the pool workers resolve; anywhere else a build-PC worker name is refused by the pool's host check.
test("gate-host.ps1 resolves build-PC workers only on the build PC", {
  skip: process.platform !== "win32",
}, () => {
  if (hostname() !== "DESKTOP-KOOB7VV") {
    const elsewhere = gateHostFor("kalcode-win-gate-w1");
    assert.notEqual(elsewhere.status, 0);
    assert.match(elsewhere.stderr + elsewhere.stdout, /Gate workers belong only on the main 64 GB Windows PC/);
    return;
  }
  for (const [runner, slot] of [
    ["kalcode-win-gate", 0],
    ["kalcode-win-gate-w1", 1],
    ["kalcode-win-gate-w2", 2],
    ["kalcode-win-gate-w5", 5],
  ]) {
    const result = gateHostFor(runner);
    assert.equal(result.status, 0, result.stderr + result.stdout);
    const got = JSON.parse(result.stdout);
    assert.equal(got.Machine, "main-pc", runner);
    assert.equal(got.Slot, slot, runner);
    assert.equal(got.E2ePort, 4491 + slot * 20, runner);
    assert.equal(got.LockDir, "C:\\ProgramData\\KalCodeGatePool\\heavy", runner);
    assert.ok([got.Env].flat().includes(`KALCODE_GATE_SLOT=${slot}`), runner);
  }
  // A slot mismatch between the runner name and its configured slot is refused.
  const mismatch = gateHostFor("kalcode-win-gate-w2", "Get-GateHost", { KALCODE_GATE_SLOT: "3" });
  assert.notEqual(mismatch.status, 0);
  assert.match(mismatch.stderr + mismatch.stdout, /does not match its configured slot/);
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

test("the gate split runs every selected check exactly once across the four jobs", async () => {
  const { E2E_GATES, NATIVE_GATES, PC2_GATES, splitGateIds } = await import("./release/lifecycle/gate-split.mjs");
  const policy = JSON.parse(readFileSync(new URL("./release/lifecycle/policy.json", import.meta.url), "utf8"));
  const all = policy.gates.map((gate) => gate.id);
  for (const id of [...PC2_GATES, ...NATIVE_GATES, ...E2E_GATES]) assert.ok(all.includes(id), `${id} is a real gate`);
  const { main, native, e2e, pc2 } = splitGateIds(all);
  assert.deepEqual([...main, ...native, ...e2e, ...pc2].sort(), [...all].sort());
  assert.equal(new Set([...main, ...native, ...e2e, ...pc2]).size, all.length);
  // The Rust checks and the Cargo tools run in the native job, the native E2E alone in its own job, in
  // parallel (rust then native E2E in one job was the gate's critical path).
  assert.deepEqual([...native].sort(), ["cargo-audit", "cargo-deny", "rust"]);
  assert.deepEqual(e2e, ["desktop-native-e2e"]);
  // The desktop readers run in the main job, in parallel with both native chains.
  for (const id of ["desktop-frontend", "desktop-ui"]) assert.ok(main.includes(id), `${id} stays in the main job`);
  assert.deepEqual(splitGateIds(["a-check-added-later"]).main, ["a-check-added-later"], "new checks default to main");
  assert.deepEqual(splitGateIds([]), { main: [], native: [], e2e: [], pc2: [] });
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
  const mixed = "rust,desktop-native-e2e,cargo-deny,desktop-ui,biome";
  assert.equal(cli("main", mixed).stdout, "desktop-ui");
  assert.equal(cli("native", mixed).stdout, "rust,cargo-deny");
  assert.equal(cli("e2e", mixed).stdout, "desktop-native-e2e");
  assert.equal(cli("pc2", mixed).stdout, "biome");
  assert.equal(cli("e2e", "rust,cargo-audit").stdout, "", "a plan without the native E2E leaves its job empty");
  assert.equal(cli("pc2", "").stdout, "");
  assert.equal(cli("elsewhere", "rust").status, 2);
});

test("the Windows gate runs as three matrix jobs that never cancel each other", async () => {
  const { E2E_GATE_JOB, NATIVE_GATE_JOB } = await import("./merge-train/github.mjs");
  const { GATE_JOB } = await import("./merge-train/train.mjs");
  const header = windows.split(/\n {4}steps:/)[0];
  assert.match(header, /fail-fast: false/);
  assert.match(header, /^ {8}half: \[main, native, e2e\]$/m);
  assert.match(header, /^ {4}runs-on: \[self-hosted, Windows, kalcode-gate-pool\]$/m, "every half on the pool");
  // Evaluate the job-name and artifact-prefix expressions per half (&& and || read the same on strings in JS).
  const expression = (text) => {
    const body = text.match(/\$\{\{ (matrix\.half == .+?) \}\}/)[1];
    return (half) => Function("matrix", `return ${body.replaceAll("==", "===")};`)({ half });
  };
  const name = expression(header.match(/^ {4}name: (.+)$/m)[1]);
  // Exactly the names the merge train judges (merge-train/train.mjs and github.mjs).
  assert.equal(name("main"), "Gate (Windows)");
  assert.equal(name("main"), GATE_JOB);
  assert.equal(name("native"), "Gate (Windows, native)");
  assert.equal(name("native"), NATIVE_GATE_JOB);
  assert.equal(name("e2e"), "Gate (Windows, native E2E)");
  assert.equal(name("e2e"), E2E_GATE_JOB);
  const names = steps.map((step) => step.match(/^name: (.+)$/m)?.[1] ?? "");
  for (const artifact of ["Preserve exact candidate evidence", "Preserve Playwright failure evidence"]) {
    const prefix = expression(steps[names.indexOf(artifact)]);
    assert.deepEqual(["main", "native", "e2e"].map(prefix), ["", "native-", "e2e-"], `${artifact}: one per job`);
  }
  const plan = script(steps[names.indexOf("Plan change-based gate")]);
  assert.match(plan, /gate-split\.mjs \$env:GATE_HALF/);
  assert.match(plan, /if \(\$env:GATE_HALF -notin @\('main', 'native', 'e2e'\)\) \{ throw "Unknown Windows gate half/);
  assert.match(
    plan,
    /"KALCODE_GATE_HEAVY=\$\(\$ids -contains 'rust' -or \$ids -contains 'desktop-native-e2e'\)"/,
    "both Rust-compiling halves are heavy",
  );
});

test("the native and native E2E halves both take the heavy Rust slot; the main half does not", {
  skip: process.platform !== "win32",
}, async () => {
  const { splitGateIds } = await import("./release/lifecycle/gate-split.mjs");
  const policy = JSON.parse(readFileSync(new URL("./release/lifecycle/policy.json", import.meta.url), "utf8"));
  const split = splitGateIds(policy.gates.map((gate) => gate.id));
  const names = steps.map((step) => step.match(/^name: (.+)$/m)?.[1] ?? "");
  const heavyLine = script(steps[names.indexOf("Plan change-based gate")])
    .split("\n")
    .find((line) => line.includes("KALCODE_GATE_HEAVY="))
    .trim();
  const heavy = (ids) => {
    const list = ids.map((id) => `'${id}'`).join(",");
    const result = spawnSync(
      "powershell.exe",
      ["-NoProfile", "-Command", `$base = 'b'; $only = 'o'; $ids = @(${list})\n${heavyLine}`],
      { encoding: "utf8", windowsHide: true },
    );
    assert.equal(result.status, 0, result.stdout + result.stderr);
    return result.stdout.match(/KALCODE_GATE_HEAVY=(\w+)/)[1];
  };
  assert.equal(heavy(split.native), "True", "the Rust half");
  assert.equal(heavy(split.e2e), "True", "the native E2E half compiles build:e2e");
  assert.equal(heavy(split.main), "False", "the desktop readers");
  // The Gate step turns a heavy half into a Rust slot: a build-PC heavy token or the second PC's rust.lock.
  const gate = script(steps[names.indexOf("Gate")]);
  assert.match(gate, /if \(\$env:KALCODE_GATE_HEAVY -eq 'True' -and \$env:KALCODE_GATE_MACHINE -eq 'main-pc'\)/);
  assert.match(gate, /elseif \(\$env:KALCODE_GATE_HEAVY -eq 'True'\)/);
});

test("every gate job keeps bounded Playwright failure evidence, on failure only", () => {
  for (const [job, jobSteps, prefix] of [
    ["windows", steps, "$" + "{{ matrix.half == 'native' && 'native-' || matrix.half == 'e2e' && 'e2e-' || '' }}"],
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

test("the desktop gate jobs request the elastic pool, the JS/web job the second PC; build-PC hooks run only on the build PC", () => {
  // Owner, 2026-10-08: build PC first (gate-pool-governor.ps1), the second PC for overflow and the JS/web job.
  const header = windows.split(/\n {4}steps:/)[0];
  assert.match(header, /^ {4}runs-on: \[self-hosted, Windows, kalcode-gate-pool\]$/m);
  assert.match(
    pc2Job,
    /^ {4}runs-on: \[self-hosted, Windows, kalcode-gate-pc2\]$/m,
    "the light JS/web job stays on the second PC",
  );
  assert.doesNotMatch(header, /kalcode-(?:main-pc|gate-pc2)\]/, "the desktop halves stay on the pool");
  assert.doesNotMatch(workflow, /runs-on: \[self-hosted, Windows, kalcode-main-pc\]/);
  assert.doesNotMatch(workflow, /kalcode-main-pc\]/, "no job targets the build PC's pool label alone");
  const names = steps.map((step) => step.match(/^name: (.+)$/m)?.[1] ?? "");
  const plan = script(steps[names.indexOf("Plan change-based gate")]);
  assert.match(plan, /\. \.github\/scripts\/gate-host\.ps1/);
  assert.match(plan, /\$gateHost = Get-GateHost\b/);
  assert.match(plan, /\(Get-GateHostEnv \$gateHost\) \| Add-Content -Path \$env:GITHUB_ENV/);
  assert.match(plan, /"machine=\$\(\$gateHost\.Machine\)" \| Add-Content -Path \$env:GITHUB_OUTPUT/);
  // The pool's admission and its release are the build PC's alone.
  const admit = steps[names.indexOf("Admit optional gate work")];
  assert.ok(admit, "admission exists in the Windows job");
  assert.match(admit, /^ {8}if: .*steps\.plan\.outputs\.machine == 'main-pc'$/m, "admission only on main-pc");
  assert.match(script(admit), /gate-worker-hook\.ps1' -Phase Before/);
  // Release runs only for a job that was admitted, which only the build PC ever is.
  const release = steps[names.indexOf("Release optional gate slot")];
  assert.ok(release, "release exists in the Windows job");
  assert.match(release, /^ {8}if: .*steps\.admission\.outcome == 'success'/m, "release only after an admission");
  assert.match(script(release), /gate-worker-hook\.ps1' -Phase After/);
  assert.ok(names.indexOf("Admit optional gate work") < names.indexOf("Install"), "admission precedes the build");
  // The Gate step: three heavy tokens on the build PC, the second PC's rust.lock there, and the machine lock
  // on every run (a no-op where its folder is absent).
  const gate = script(steps[names.indexOf("Gate")]);
  // Below normal on the build PC and for the Rust/native half; the second PC's timed halves stay normal.
  assert.match(
    gate,
    /if \(\$env:KALCODE_GATE_MACHINE -eq 'main-pc' -or \$env:KALCODE_GATE_HEAVY -eq 'True'\) \{ \(Get-Process -Id \$PID\)\.PriorityClass = 'BelowNormal' \}/,
  );
  assert.match(gate, /\$env:KALCODE_GATE_HEAVY -eq 'True' -and \$env:KALCODE_GATE_MACHINE -eq 'main-pc'/);
  assert.match(gate, /KalCodeGatePool\\heavy/);
  assert.match(gate, /heavy-\$index\.lock/);
  assert.match(gate, /elseif \(\$env:KALCODE_GATE_HEAVY -eq 'True'\)[\s\S]*KalCodePC2\\locks\\rust\.lock/);
  assert.match(gate, /^\s*\. \.github\/scripts\/pc2-machine-lock\.ps1$/m);
  assert.match(gate, /Enter-Pc2MachineLock -Mode Shared/);
  assert.match(gate, /Exit-Pc2MachineLock \$lock/);
  const pc2Names = pc2Steps.map((step) => step.match(/^name: (.+)$/m)?.[1] ?? "");
  const pc2Gate = script(pc2Steps[pc2Names.indexOf("Gate")]);
  assert.match(pc2Gate, /^\s*\. \.github\/scripts\/pc2-machine-lock\.ps1$/m);
  assert.match(pc2Gate, /Enter-Pc2MachineLock -Mode Shared/);
  // The JS/web job takes no build-PC admission, whichever PC it lands on.
  assert.ok(!pc2Names.includes("Admit optional gate work") && !pc2Names.includes("Release optional gate slot"));
});

test("both Windows jobs take their machine and ports from the same gate-host.ps1", () => {
  const planOf = (list) => {
    const names = list.map((step) => step.match(/^name: (.+)$/m)?.[1] ?? "");
    return script(list[names.indexOf("Plan change-based gate")]);
  };
  const lines = (plan) =>
    plan
      .split("\n")
      .filter((line) => /gate-host\.ps1|Get-GateHost\b/.test(line))
      .map((l) => l.trim());
  const main = lines(planOf(steps));
  assert.ok(main.length >= 2, "dot-source and Get-GateHost");
  assert.deepEqual(main, lines(planOf(pc2Steps)));
  for (const plan of [planOf(steps), planOf(pc2Steps)])
    assert.doesNotMatch(plan, /\$pc2Slot|\$portOffset|KALCODE_E2E_PORT=/, "no per-job port tables");
});
