import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

const workflowPath = fileURLToPath(new URL("../../.github/workflows/windows-release-verify.yml", import.meta.url));
const workflow = readFileSync(workflowPath, "utf8");

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
