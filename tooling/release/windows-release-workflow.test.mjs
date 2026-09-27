import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const workflowPath = fileURLToPath(new URL("../../.github/workflows/windows-release-verify.yml", import.meta.url));
const workflow = readFileSync(workflowPath, "utf8");

// Execute the real workflow step with local gh/cargo doubles. Only the remote transport and
// cryptographic subprocess are substituted; PowerShell's asset/evidence/hash gates run intact.
function candidateStep() {
  const step = workflow.split("      - name: Download and authenticate the private draft candidate\n")[1];
  assert.ok(step, "candidate authentication step exists");
  return step
    .split("        run: |\n")[1]
    .split("\n      - name:")[0]
    .replace(/^ {10}/gm, "");
}

test("Windows candidate transport carries and authenticates both updater signatures", {
  skip: process.platform !== "win32" ? "executes the Windows workflow's PowerShell step" : false,
}, () => {
  const root = mkdtempSync(join(tmpdir(), "kalcode-workflow-v2-"));
  const version = "1.2.3";
  const file = `KalCode_${version}_x64-setup.exe`;
  const bytes = Buffer.from("inert installer fixture; never executed");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const commit = "a".repeat(40);
  const stage = join(root, "dist", "release", version);
  mkdirSync(stage, { recursive: true });
  mkdirSync(join(root, "tooling", "release"), { recursive: true });
  writeFileSync(join(root, "tooling", "release", "updater-public-key.txt"), "public-fixture\n");
  const assets = ["build.json", file, `${file}.sig`, `${file}.windows-x86_64.sig`];
  const base = {
    version,
    commit,
    file,
    sha256,
    requestedReleaseChannel: "stable",
    compiledChannel: "stable",
    signed: true,
    signatureStatus: "Valid",
    releaseDescriptorEligible: true,
    releaseDescriptorBlockedReason: null,
    compiledChannelVerification: {
      status: "verified",
      method: "build_info_probe_v1",
      schemaVersion: 1,
      version,
      channel: "stable",
      testHooks: false,
    },
    signing: {
      provider: "azure-artifact-signing",
      timestamped: true,
      appTimestamped: true,
      applicationVerifiedDuringBundle: true,
      publisherIdentityBound: true,
    },
    updater: {
      artifactFile: file,
      signatureFile: `${file}.sig`,
      signatureStatus: "Valid",
      cryptographicallyVerified: true,
      versionBound: true,
      publicKeyConfigured: true,
    },
    updaterV2: {
      schemaVersion: 2,
      artifactFile: file,
      signatureFile: `${file}.windows-x86_64.sig`,
      signatureStatus: "Valid",
      cryptographicallyVerified: true,
      versionBound: true,
      publicKeyConfigured: true,
      target: "windows-x86_64",
      targetBound: true,
      channel: "stable",
      channelBound: true,
    },
  };
  const script = join(root, "workflow-step.ps1");
  writeFileSync(
    script,
    `
$ErrorActionPreference = "Stop"
function gh {
  $global:LASTEXITCODE = 0
  if ($args[1] -eq 'view') { Get-Content -LiteralPath (Join-Path $env:GITHUB_WORKSPACE 'draft.json') -Raw }
  elseif ($args[1] -eq 'download') {
    ConvertTo-Json -InputObject @($args) -Compress | Set-Content -LiteralPath (Join-Path $env:GITHUB_WORKSPACE 'download-args.json')
  } else { throw 'unexpected gh invocation' }
}
function cargo {
  ConvertTo-Json -InputObject @($args) -Compress | Add-Content -LiteralPath (Join-Path $env:GITHUB_WORKSPACE 'verify-args.jsonl')
  $global:LASTEXITCODE = 0
  if ($env:FIXTURE_BAD_V2_SIGNATURE -eq '1' -and $args -contains '--target') { $global:LASTEXITCODE = 1 }
}
${candidateStep()}
`,
  );
  try {
    for (const scenario of [
      "valid",
      "missing-v2",
      "missing-v2-file",
      "extra-asset",
      "wrong-target",
      "wrong-channel",
      "wrong-file",
      "tampered-installer",
      "bad-v2-signature",
    ]) {
      const build = structuredClone(base);
      let names = [...assets];
      if (scenario === "missing-v2") names = names.slice(0, 3);
      if (scenario === "extra-asset") names.push("unrelated.txt");
      if (scenario === "wrong-target") build.updaterV2.target = "darwin-aarch64";
      if (scenario === "wrong-channel") build.updaterV2.channel = "beta";
      if (scenario === "wrong-file") build.updaterV2.signatureFile = `${file}.sig`;
      writeFileSync(join(stage, "build.json"), JSON.stringify(build));
      writeFileSync(join(stage, file), scenario === "tampered-installer" ? "different bytes" : bytes);
      writeFileSync(join(stage, `${file}.sig`), "legacy-fixture");
      writeFileSync(join(stage, `${file}.windows-x86_64.sig`), "v2-fixture");
      if (scenario === "missing-v2-file") rmSync(join(stage, `${file}.windows-x86_64.sig`));
      writeFileSync(
        join(root, "draft.json"),
        JSON.stringify({ isDraft: true, tagName: "candidate-test", assets: names.map((name) => ({ name })) }),
      );
      rmSync(join(root, "verify-args.jsonl"), { force: true });
      const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-File", script], {
        encoding: "utf8",
        windowsHide: true,
        timeout: 15_000,
        env: {
          ...process.env,
          GITHUB_WORKSPACE: root,
          GITHUB_REPOSITORY: "fixture/private",
          CANDIDATE_TAG: "candidate-test",
          CANDIDATE_VERSION: version,
          CANDIDATE_COMMIT: commit,
          CANDIDATE_SHA256: sha256,
          FIXTURE_BAD_V2_SIGNATURE: scenario === "bad-v2-signature" ? "1" : "0",
        },
      });
      assert.ifError(result.error);
      if (scenario !== "valid") {
        assert.notEqual(result.status, 0, `${scenario} must fail before installer execution`);
        continue;
      }
      assert.equal(result.status, 0, result.stderr);
      const download = JSON.parse(readFileSync(join(root, "download-args.json"), "utf8").replace(/^\uFEFF/, ""));
      assert.ok(download.includes(`${file}.windows-x86_64.sig`));
      const checks = readFileSync(join(root, "verify-args.jsonl"), "utf8")
        .trim()
        .split(/\r?\n/)
        .map((line) => JSON.parse(line.replace(/^\uFEFF/, "")));
      assert.equal(checks.length, 2);
      const value = (args, flag) => args[args.indexOf(flag) + 1];
      assert.equal(value(checks[1], "--signature"), join(stage, `${file}.windows-x86_64.sig`));
      assert.equal(value(checks[1], "--target"), "windows-x86_64");
      assert.equal(value(checks[1], "--channel"), "stable");
      assert.equal(value(checks[1], "--version"), version);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("clean-machine release verification is manual, private and least privilege", () => {
  assert.match(workflow, /^on:\s*\r?\n\s+workflow_dispatch:/m);
  assert.doesNotMatch(workflow, /^\s+(push|pull_request|release|schedule):/m);
  assert.match(workflow, /^permissions:\s*\r?\n\s+contents: read$/m);
  assert.doesNotMatch(workflow, /^\s+(id-token|packages|actions): write$/m);
  assert.match(workflow, /-not \$release\.isDraft/);
  assert.match(workflow, /Compare-Object -ReferenceObject \$expectedAssets/);
  assert.match(workflow, /WORKFLOW_COMMIT.*github\.sha/);
});

test("clean-machine workflow pins actions and never embeds signing credentials", () => {
  const actionLines = workflow.match(/^\s+uses: .+$/gm) ?? [];
  assert.ok(actionLines.length >= 3);
  for (const line of actionLines) assert.match(line, /@[0-9a-f]{40}(?:\s+#.*)?$/);
  const forbiddenCredentialMaterial = new RegExp(
    [
      "AZURE" + "_CLIENT" + "_SECRET",
      "AZURE" + "_CLIENT_ID",
      "AZURE" + "_TENANT_ID",
      "BE" + "GIN (?:RSA |EC )?PRIVATE KEY",
      "client" + "_secret",
    ].join("|"),
    "i",
  );
  assert.doesNotMatch(workflow, forbiddenCredentialMaterial);
  assert.doesNotMatch(workflow, /^\s+run:.*\$\{\{\s*inputs\./m);
});

test("candidate bytes and redacted evidence are fail-closed before installer execution", () => {
  for (const required of [
    "CANDIDATE_COMMIT",
    "CANDIDATE_VERSION",
    "CANDIDATE_SHA256",
    "releaseDescriptorEligible",
    "build_info_probe_v1",
    "testHooks",
    "azure-artifact-signing",
    "applicationVerifiedDuringBundle",
    "publisherIdentityBound",
    "updaterSignatureName",
    "cryptographicallyVerified",
    "tooling/updater-signer/Cargo.toml",
    "updater-public-key.txt",
    "Get-FileHash",
    "node tooling/release/verify-windows.mjs",
    "verify.json",
  ]) {
    assert.ok(workflow.includes(required), `workflow is missing ${required}`);
  }
  assert.match(workflow, /subject\|thumbprint\|address\|signer/i);
  assert.match(workflow, /runs-on: windows-2022/);
  assert.match(workflow, /timeout-minutes: 20/);
});
