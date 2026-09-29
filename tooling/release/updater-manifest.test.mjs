import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign as signBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { parseUpdaterDescriptor } from "../../apps/website/worker/updater-descriptor.ts";
import {
  baselineWaiverCandidateProblems,
  createPlatformUpdaterManifest,
  createUpdaterManifest,
  updaterQaProblems,
} from "./updater-manifest.mjs";
import { assembleRelease } from "./updater-qa-stage-assembly.mjs";

const commit = "a".repeat(40);
const artifactBytes = Buffer.from("updater artifact");
const artifactSha256 = createHash("sha256").update(artifactBytes).digest("hex");
const guardianSha256 = "c".repeat(64);
const baselineCommit = "b".repeat(40);
const baselineSha256 = "d".repeat(64);

function qaEvidence(target, version = "1.2.3", candidateCommit = commit, candidateSha256 = artifactSha256) {
  const baseline = { version: "1.2.2", commit: baselineCommit, sha256: baselineSha256 };
  const candidate = { version, commit: candidateCommit, sha256: candidateSha256 };
  return {
    schemaVersion: 2,
    status: "passed",
    target,
    channel: "stable",
    release: candidate,
    safeguards: {
      testHooks: false,
      cacheSeeded: false,
      authenticationBypassed: false,
      tlsBypassed: false,
      fixtureOnly: false,
    },
    checks: Object.fromEntries(
      [
        "install",
        "cleanInstall",
        "launch",
        "auth",
        "providers",
        "accountIsolation",
        "kalvoice",
        "browser",
        "workspace",
        "sleepWake",
      ].map((key) => [key, true]),
    ),
    updateTrial: {
      method: "public-unlisted-immutable-version-v1",
      baseline,
      candidate,
      outcomes: [
        { step: "update", from: baseline, to: candidate, passed: true },
        { step: "rollback", from: candidate, to: baseline, passed: true },
        { step: "reupdate", from: baseline, to: candidate, passed: true },
      ],
    },
  };
}

function unavailableBaselineQa(target) {
  const sha256 =
    target === "windows-x86_64"
      ? "4d4d8897ab376b5532e3940d79c13a2a2674614ade729ace211dba7f662ebb70"
      : "918646e4b26f39463a6bd841c2f705ed7a18b42ec271668932a97b7d65c8c987";
  const record = qaEvidence(target, "0.1.4", "0ee34938d6543bba3679cb008174231d0e9544ec", sha256);
  record.status = "preliminary-passed";
  record.updateTrial = null;
  record.checks.kalvoice = false;
  record.kalvoiceUnavailable = {
    release: { ...record.release },
    target,
    reason: "stable-surface-hidden",
    observation: {
      release: { ...record.release },
      target,
      profile: "kalcodeqa2",
      receiptSha256: "f".repeat(64),
      observedAt: "2026-09-28T01:00:00.000Z",
      surfaceAbsent: true,
      activationUnavailable: true,
    },
  };
  return record;
}

function baselineAuthority(record) {
  return { release: { ...record.release }, target: record.target, reason: "stable-surface-hidden" };
}

test("baseline preliminary QA preserves observed, exact-bound KalVoice unavailability as false", () => {
  for (const target of ["windows-x86_64", "darwin-aarch64"]) {
    const record = unavailableBaselineQa(target);
    const expected = { target, channel: "stable", release: { ...record.release } };
    const before = structuredClone(record);
    assert.deepEqual(updaterQaProblems(record, expected, "baseline-preliminary", baselineAuthority(record)), []);
    assert.deepEqual(record, before, "validation must never normalize unavailable into a passed check");
  }
});

test("unavailable baseline evidence cannot authorize candidate preliminary or final QA", () => {
  const record = unavailableBaselineQa("windows-x86_64");
  const expected = { target: record.target, channel: "stable", release: { ...record.release } };
  for (const phase of ["preliminary", "final"]) {
    assert.notDeepEqual(updaterQaProblems(record, expected, phase), []);
  }
});

test("baseline unavailability requires complete exact-bound source and physical absence evidence", () => {
  for (const mutate of [
    (r) => delete r.kalvoiceUnavailable,
    (r) => (r.kalvoiceUnavailable.target = "darwin-aarch64"),
    (r) => (r.kalvoiceUnavailable.release.commit = "e".repeat(40)),
    (r) => (r.kalvoiceUnavailable.release.sha256 = "e".repeat(64)),
    (r) => (r.kalvoiceUnavailable.release.version = "1.2.1"),
    (r) => (r.kalvoiceUnavailable.reason = "not-tested"),
    (r) => delete r.kalvoiceUnavailable.observation,
    (r) => (r.kalvoiceUnavailable.observation.release.sha256 = "e".repeat(64)),
    (r) => (r.kalvoiceUnavailable.observation.release.commit = "e".repeat(40)),
    (r) => (r.kalvoiceUnavailable.observation.release.version = "0.1.3"),
    (r) => (r.kalvoiceUnavailable.observation.target = "darwin-aarch64"),
    (r) => (r.kalvoiceUnavailable.observation.profile = ""),
    (r) => (r.kalvoiceUnavailable.observation.receiptSha256 = "not-a-hash"),
    (r) => (r.kalvoiceUnavailable.observation.observedAt = "invalid"),
    (r) => (r.kalvoiceUnavailable.observation.surfaceAbsent = false),
    (r) => (r.kalvoiceUnavailable.observation.activationUnavailable = false),
    (r) => (r.kalvoiceUnavailable.observation.unreviewed = true),
    (r) => (r.checks.kalvoice = true),
    (r) => (r.checks.kalvoice = null),
    (r) => (r.channel = "beta"),
    (r) => (r.status = "passed"),
    (r) => (r.updateTrial = {}),
  ]) {
    const record = unavailableBaselineQa("windows-x86_64");
    const expected = { target: record.target, channel: "stable", release: { ...record.release } };
    mutate(record);
    assert.notDeepEqual(updaterQaProblems(record, expected, "baseline-preliminary", baselineAuthority(record)), []);
  }
});

test("baseline role never waives authentication, another product check, or a safeguard", () => {
  const original = unavailableBaselineQa("windows-x86_64");
  const expected = { target: original.target, channel: "stable", release: { ...original.release } };
  for (const key of Object.keys(original.checks).filter((key) => key !== "kalvoice")) {
    const record = structuredClone(original);
    record.checks[key] = false;
    assert.notDeepEqual(
      updaterQaProblems(record, expected, "baseline-preliminary", baselineAuthority(record)),
      [],
      key,
    );
  }
  for (const key of Object.keys(original.safeguards)) {
    const record = structuredClone(original);
    record.safeguards[key] = true;
    assert.notDeepEqual(
      updaterQaProblems(record, expected, "baseline-preliminary", baselineAuthority(record)),
      [],
      key,
    );
  }
});

test("baseline capability authority is mandatory and limited to reviewed source and platform bytes", () => {
  for (const target of ["windows-x86_64", "darwin-aarch64"]) {
    const record = unavailableBaselineQa(target);
    const expected = { target, channel: "stable", release: { ...record.release } };
    assert.notDeepEqual(updaterQaProblems(record, expected, "baseline-preliminary"), []);
    for (const mutate of [
      (r) => (r.release.commit = "a".repeat(40)),
      (r) => (r.release.sha256 = "a".repeat(64)),
      (r) => (r.release.version = "0.1.5"),
    ]) {
      const substituted = structuredClone(record);
      mutate(substituted);
      substituted.kalvoiceUnavailable.release = { ...substituted.release };
      substituted.kalvoiceUnavailable.observation.release = { ...substituted.release };
      assert.notDeepEqual(
        updaterQaProblems(
          substituted,
          { ...expected, release: substituted.release },
          "baseline-preliminary",
          baselineAuthority(substituted),
        ),
        [],
      );
    }
    const wrongTarget = baselineAuthority(record);
    wrongTarget.target = target === "windows-x86_64" ? "darwin-aarch64" : "windows-x86_64";
    assert.notDeepEqual(updaterQaProblems(record, expected, "baseline-preliminary", wrongTarget), []);
    for (const phase of ["preliminary", "final"]) {
      assert.notDeepEqual(updaterQaProblems(record, expected, phase, baselineAuthority(record)), []);
    }
  }
});

const otherTarget = (target) => (target === "windows-x86_64" ? "darwin-aarch64" : "windows-x86_64");
const ISOLATION_DEFECT =
  "0ee3493:crates/providers/src/gemini/managed_policy.rs:130 --ignore-env rejected by Gemini CLI 0.61.0";

function isolationWaivedBaselineQa(target) {
  const record = unavailableBaselineQa(target);
  record.checks.accountIsolation = false;
  record.accountIsolationUnavailable = {
    release: { ...record.release },
    target,
    reason: "baseline-provider-cli-incompatible",
    defectReference: ISOLATION_DEFECT,
    candidateProofRequired: true,
    observation: {
      release: { ...record.release },
      target,
      profile: "kalcodeqa2",
      receiptSha256: "e".repeat(64),
      observedAt: "2026-09-28T02:00:00.000Z",
      storageIsolationProven: true,
    },
  };
  return record;
}

test("baseline preliminary QA accepts the exact-bound account isolation waiver, with and without KalVoice", () => {
  for (const target of ["windows-x86_64", "darwin-aarch64"]) {
    const record = isolationWaivedBaselineQa(target);
    const expected = { target, channel: "stable", release: { ...record.release } };
    const before = structuredClone(record);
    assert.deepEqual(updaterQaProblems(record, expected, "baseline-preliminary", baselineAuthority(record)), []);
    assert.deepEqual(record, before, "validation must never normalize the waiver into a passed check");
    const kalvoicePassed = structuredClone(record);
    delete kalvoicePassed.kalvoiceUnavailable;
    kalvoicePassed.checks.kalvoice = true;
    assert.deepEqual(
      updaterQaProblems(kalvoicePassed, expected, "baseline-preliminary", baselineAuthority(record)),
      [],
    );
  }
});

test("account isolation waiver never authorizes a candidate preliminary or final record", () => {
  for (const target of ["windows-x86_64", "darwin-aarch64"]) {
    const record = isolationWaivedBaselineQa(target);
    const expected = { target, channel: "stable", release: { ...record.release } };
    for (const phase of ["preliminary", "final"]) {
      assert.deepEqual(updaterQaProblems(record, expected, phase, baselineAuthority(record)), [
        "updater QA record has unexpected fields",
      ]);
    }
    // A candidate-shaped record (all checks true) carrying only the waiver is still refused.
    const candidate = qaEvidence(target);
    candidate.status = "preliminary-passed";
    candidate.updateTrial = null;
    candidate.accountIsolationUnavailable = structuredClone(record.accountIsolationUnavailable);
    const candidateExpected = { target, channel: "stable", release: { ...candidate.release } };
    assert.notDeepEqual(updaterQaProblems(candidate, candidateExpected, "preliminary"), []);
    assert.notDeepEqual(
      updaterQaProblems(candidate, candidateExpected, "baseline-preliminary", baselineAuthority(candidate)),
      [],
    );
  }
});

test("account isolation waiver requires every exact field and nothing more", () => {
  const mutations = [
    (r) => delete r.accountIsolationUnavailable,
    (r) => (r.accountIsolationUnavailable = null),
    (r) => (r.accountIsolationUnavailable.extra = true),
    (r) => (r.accountIsolationUnavailable.target = otherTarget(r.target)),
    (r) => (r.accountIsolationUnavailable.release.commit = "e".repeat(40)),
    (r) => (r.accountIsolationUnavailable.release.sha256 = "e".repeat(64)),
    (r) => (r.accountIsolationUnavailable.release.version = "0.1.5"),
    (r) => (r.accountIsolationUnavailable.release.extra = "x"),
    (r) => (r.accountIsolationUnavailable.reason = "stable-surface-hidden"),
    (r) => (r.accountIsolationUnavailable.reason = "not-tested"),
    (r) => (r.accountIsolationUnavailable.defectReference = ISOLATION_DEFECT.replace(":130", ":634")),
    (r) => (r.accountIsolationUnavailable.defectReference = `${ISOLATION_DEFECT} `),
    (r) => (r.accountIsolationUnavailable.candidateProofRequired = false),
    (r) => (r.accountIsolationUnavailable.candidateProofRequired = "true"),
    (r) => (r.accountIsolationUnavailable.observation.storageIsolationProven = false),
    (r) => (r.accountIsolationUnavailable.observation.release.sha256 = "e".repeat(64)),
    (r) => (r.accountIsolationUnavailable.observation.release.commit = "e".repeat(40)),
    (r) => (r.accountIsolationUnavailable.observation.release.version = "0.1.3"),
    (r) => (r.accountIsolationUnavailable.observation.target = otherTarget(r.target)),
    (r) => (r.accountIsolationUnavailable.observation.profile = ""),
    (r) => (r.accountIsolationUnavailable.observation.profile = "bad profile"),
    (r) => (r.accountIsolationUnavailable.observation.receiptSha256 = "not-a-hash"),
    (r) => (r.accountIsolationUnavailable.observation.observedAt = "invalid"),
    (r) => (r.accountIsolationUnavailable.observation.observedAt = "2026-09-28T02:00:00Z"),
    (r) => (r.accountIsolationUnavailable.observation.unreviewed = true),
    (r) => (r.accountIsolationUnavailable.observation.surfaceAbsent = true),
    (r) => (r.checks.accountIsolation = true),
    (r) => (r.checks.accountIsolation = null),
    (r) => (r.checks.auth = false),
    (r) => (r.safeguards.fixtureOnly = true),
    (r) => (r.channel = "beta"),
    (r) => (r.status = "passed"),
    (r) => (r.updateTrial = {}),
  ];
  for (const field of ["release", "target", "reason", "defectReference", "candidateProofRequired", "observation"]) {
    mutations.push((r) => delete r.accountIsolationUnavailable[field]);
  }
  for (const field of ["release", "target", "profile", "receiptSha256", "observedAt", "storageIsolationProven"]) {
    mutations.push((r) => delete r.accountIsolationUnavailable.observation[field]);
  }
  for (const target of ["windows-x86_64", "darwin-aarch64"]) {
    for (const mutate of mutations) {
      const record = isolationWaivedBaselineQa(target);
      const expected = { target, channel: "stable", release: { ...record.release } };
      mutate(record);
      assert.notDeepEqual(
        updaterQaProblems(record, expected, "baseline-preliminary", baselineAuthority(record)),
        [],
        mutate.toString(),
      );
    }
  }
});

test("account isolation waiver requires the tool baseline context and the two pinned baseline artifacts", () => {
  for (const target of ["windows-x86_64", "darwin-aarch64"]) {
    const record = isolationWaivedBaselineQa(target);
    const expected = { target, channel: "stable", release: { ...record.release } };
    assert.notDeepEqual(updaterQaProblems(record, expected, "baseline-preliminary"), []);
    const wrongTarget = baselineAuthority(record);
    wrongTarget.target = target === "windows-x86_64" ? "darwin-aarch64" : "windows-x86_64";
    assert.notDeepEqual(updaterQaProblems(record, expected, "baseline-preliminary", wrongTarget), []);
    for (const mutate of [
      (r) => (r.release.commit = "a".repeat(40)),
      (r) => (r.release.sha256 = "a".repeat(64)),
      (r) => (r.release.version = "0.1.5"),
    ]) {
      const substituted = structuredClone(record);
      mutate(substituted);
      for (const proof of [substituted.kalvoiceUnavailable, substituted.accountIsolationUnavailable]) {
        proof.release = { ...substituted.release };
        proof.observation.release = { ...substituted.release };
      }
      assert.notDeepEqual(
        updaterQaProblems(
          substituted,
          { ...expected, release: substituted.release },
          "baseline-preliminary",
          baselineAuthority(substituted),
        ),
        [],
      );
    }
  }
});

test("a baseline isolation waiver is refused unless the same platform candidate proves isolation", () => {
  const candidateQa = (target) => {
    const record = qaEvidence(target);
    record.status = "preliminary-passed";
    record.updateTrial = null;
    return record;
  };
  for (const target of ["windows-x86_64", "darwin-aarch64"]) {
    const baseline = isolationWaivedBaselineQa(target);
    assert.deepEqual(baselineWaiverCandidateProblems(baseline, candidateQa(target)), []);
    const other = target === "windows-x86_64" ? "darwin-aarch64" : "windows-x86_64";
    for (const candidate of [
      undefined,
      null,
      [],
      {},
      Object.assign(candidateQa(target), { checks: { ...candidateQa(target).checks, accountIsolation: false } }),
      Object.assign(candidateQa(target), { checks: { ...candidateQa(target).checks, accountIsolation: null } }),
      Object.assign(candidateQa(target), { checks: { ...candidateQa(target).checks, accountIsolation: "true" } }),
      Object.assign(candidateQa(target), { accountIsolationUnavailable: baseline.accountIsolationUnavailable }),
      candidateQa(other),
    ]) {
      assert.deepEqual(baselineWaiverCandidateProblems(baseline, candidate), [
        "baseline account isolation waiver requires the candidate record for the same platform to prove accountIsolation",
      ]);
    }
    // Without a waiver the candidate is judged only by its own preliminary contract.
    assert.deepEqual(baselineWaiverCandidateProblems(unavailableBaselineQa(target), {}), []);
  }
});

const BROWSER_DEFECT =
  "0ee3493:apps/desktop/src-tauri/src/browser_commands.rs:1403 child.url() -> wry-0.55.1 wkwebview/mod.rs:1349 URL().unwrap() aborts on nil URL (macOS)";
const BROWSER_CANDIDATE_PROBLEM =
  "baseline browser waiver requires the candidate record for the same platform to prove browser";
const ISOLATION_CANDIDATE_PROBLEM =
  "baseline account isolation waiver requires the candidate record for the same platform to prove accountIsolation";

function browserUnavailableProof(record) {
  return {
    release: { ...record.release },
    target: record.target,
    reason: "baseline-webview-nil-url-abort",
    defectReference: BROWSER_DEFECT,
    candidateProofRequired: true,
    observation: {
      release: { ...record.release },
      target: record.target,
      profile: "kalcodeqa2",
      receiptSha256: "9".repeat(64),
      observedAt: "2026-09-28T19:50:11.000Z",
      crashObserved: true,
    },
  };
}

// The historical macOS 0.1.4 baseline (mac014): Browser observed crashing, recorded as false.
function browserWaivedBaselineQa(target = "darwin-aarch64") {
  const record = unavailableBaselineQa(target);
  record.checks.browser = false;
  record.browserUnavailable = browserUnavailableProof(record);
  return record;
}

test("macOS baseline preliminary QA accepts the exact-bound browser waiver and keeps browser false", () => {
  const record = browserWaivedBaselineQa();
  const expected = { target: record.target, channel: "stable", release: { ...record.release } };
  const before = structuredClone(record);
  assert.deepEqual(updaterQaProblems(record, expected, "baseline-preliminary", baselineAuthority(record)), []);
  assert.deepEqual(record, before, "validation must never normalize the observed crash into a passed check");
  assert.equal(record.checks.browser, false);
  // It composes with the account isolation waiver (the real mac014 shape) and with KalVoice passing.
  const combined = isolationWaivedBaselineQa("darwin-aarch64");
  combined.checks.browser = false;
  combined.browserUnavailable = browserUnavailableProof(combined);
  assert.deepEqual(updaterQaProblems(combined, expected, "baseline-preliminary", baselineAuthority(combined)), []);
  const kalvoicePassed = structuredClone(record);
  delete kalvoicePassed.kalvoiceUnavailable;
  kalvoicePassed.checks.kalvoice = true;
  assert.deepEqual(updaterQaProblems(kalvoicePassed, expected, "baseline-preliminary", baselineAuthority(record)), []);
});

test("browser waiver is refused on the Windows baseline, which must still prove browser", () => {
  const record = browserWaivedBaselineQa("windows-x86_64");
  const expected = { target: record.target, channel: "stable", release: { ...record.release } };
  assert.deepEqual(updaterQaProblems(record, expected, "baseline-preliminary", baselineAuthority(record)), [
    "baseline browser unavailability evidence is invalid",
    "updater QA product checks are incomplete",
  ]);
  // Even a Windows proof claiming the macOS target is refused: it cannot bind the Windows artifact.
  const retargeted = browserWaivedBaselineQa("windows-x86_64");
  retargeted.browserUnavailable.target = "darwin-aarch64";
  retargeted.browserUnavailable.observation.target = "darwin-aarch64";
  assert.notDeepEqual(
    updaterQaProblems(retargeted, expected, "baseline-preliminary", baselineAuthority(retargeted)),
    [],
  );
  // A Windows browser false without any proof stays a failed check; browser true is unchanged.
  const withoutProof = browserWaivedBaselineQa("windows-x86_64");
  delete withoutProof.browserUnavailable;
  assert.deepEqual(updaterQaProblems(withoutProof, expected, "baseline-preliminary", baselineAuthority(withoutProof)), [
    "updater QA product checks are incomplete",
  ]);
  assert.deepEqual(
    updaterQaProblems(
      unavailableBaselineQa("windows-x86_64"),
      expected,
      "baseline-preliminary",
      baselineAuthority(record),
    ),
    [],
  );
});

test("browser waiver never authorizes a candidate preliminary or final record", () => {
  for (const target of ["windows-x86_64", "darwin-aarch64"]) {
    const record = browserWaivedBaselineQa(target);
    const expected = { target, channel: "stable", release: { ...record.release } };
    for (const phase of ["preliminary", "final"]) {
      assert.deepEqual(updaterQaProblems(record, expected, phase, baselineAuthority(record)), [
        "updater QA record has unexpected fields",
      ]);
    }
    // A 0.1.5 candidate-shaped record with browser false and a proof is refused in every phase.
    const candidate = qaEvidence(target);
    candidate.status = "preliminary-passed";
    candidate.updateTrial = null;
    candidate.checks.browser = false;
    candidate.browserUnavailable = browserUnavailableProof(candidate);
    const candidateExpected = { target, channel: "stable", release: { ...candidate.release } };
    for (const phase of ["preliminary", "final"]) {
      assert.deepEqual(updaterQaProblems(candidate, candidateExpected, phase), [
        "updater QA record has unexpected fields",
      ]);
    }
    assert.notDeepEqual(
      updaterQaProblems(candidate, candidateExpected, "baseline-preliminary", baselineAuthority(candidate)),
      [],
    );
    // Nor does a candidate that proves browser but carries the baseline's proof alongside.
    const carrying = qaEvidence(target);
    carrying.status = "preliminary-passed";
    carrying.updateTrial = null;
    carrying.browserUnavailable = structuredClone(record.browserUnavailable);
    assert.deepEqual(updaterQaProblems(carrying, candidateExpected, "preliminary"), [
      "updater QA record has unexpected fields",
    ]);
  }
});

test("browser waiver requires every exact field and nothing more", () => {
  const mutations = [
    (r) => delete r.browserUnavailable,
    (r) => (r.browserUnavailable = null),
    (r) => (r.browserUnavailable = []),
    (r) => (r.browserUnavailable.extra = true),
    (r) => (r.browserUnavailable.target = "windows-x86_64"),
    (r) => (r.browserUnavailable.release.commit = "e".repeat(40)),
    (r) => (r.browserUnavailable.release.sha256 = "e".repeat(64)),
    (r) => (r.browserUnavailable.release.sha256 = "4d4d8897ab376b5532e3940d79c13a2a2674614ade729ace211dba7f662ebb70"),
    (r) => (r.browserUnavailable.release.version = "0.1.5"),
    (r) => (r.browserUnavailable.release.extra = "x"),
    (r) => (r.browserUnavailable.reason = "stable-surface-hidden"),
    (r) => (r.browserUnavailable.reason = "baseline-provider-cli-incompatible"),
    (r) => (r.browserUnavailable.reason = "not-tested"),
    (r) => (r.browserUnavailable.defectReference = ISOLATION_DEFECT),
    (r) => (r.browserUnavailable.defectReference = BROWSER_DEFECT.replace(":1403", ":1402")),
    (r) => (r.browserUnavailable.defectReference = BROWSER_DEFECT.replace("mod.rs:1349", "mod.rs:1350")),
    (r) => (r.browserUnavailable.defectReference = BROWSER_DEFECT.replace(" -> ", " → ")),
    (r) => (r.browserUnavailable.defectReference = BROWSER_DEFECT.replace("0.55.1", "0.55.2")),
    (r) => (r.browserUnavailable.defectReference = `${BROWSER_DEFECT} `),
    (r) => (r.browserUnavailable.defectReference = BROWSER_DEFECT.toLowerCase()),
    (r) => (r.browserUnavailable.candidateProofRequired = false),
    (r) => (r.browserUnavailable.candidateProofRequired = "true"),
    (r) => (r.browserUnavailable.observation.crashObserved = false),
    (r) => (r.browserUnavailable.observation.crashObserved = "true"),
    (r) => (r.browserUnavailable.observation.release.sha256 = "e".repeat(64)),
    (r) => (r.browserUnavailable.observation.release.commit = "e".repeat(40)),
    (r) => (r.browserUnavailable.observation.release.version = "0.1.3"),
    (r) => (r.browserUnavailable.observation.target = "windows-x86_64"),
    (r) => (r.browserUnavailable.observation.profile = ""),
    (r) => (r.browserUnavailable.observation.profile = "bad profile"),
    (r) => (r.browserUnavailable.observation.receiptSha256 = "not-a-hash"),
    (r) => (r.browserUnavailable.observation.observedAt = "invalid"),
    (r) => (r.browserUnavailable.observation.observedAt = "2026-09-28T19:50:11Z"),
    (r) => (r.browserUnavailable.observation.unreviewed = true),
    (r) => (r.browserUnavailable.observation.storageIsolationProven = true),
    (r) => (r.checks.browser = true),
    (r) => (r.checks.browser = null),
    (r) => (r.checks.browser = "false"),
    (r) => (r.checks.workspace = false),
    (r) => (r.checks.auth = false),
    (r) => (r.safeguards.fixtureOnly = true),
    (r) => (r.channel = "beta"),
    (r) => (r.status = "passed"),
    (r) => (r.updateTrial = {}),
  ];
  for (const field of ["release", "target", "reason", "defectReference", "candidateProofRequired", "observation"]) {
    mutations.push((r) => delete r.browserUnavailable[field]);
  }
  for (const field of ["release", "target", "profile", "receiptSha256", "observedAt", "crashObserved"]) {
    mutations.push((r) => delete r.browserUnavailable.observation[field]);
  }
  for (const mutate of mutations) {
    const record = browserWaivedBaselineQa();
    const expected = { target: record.target, channel: "stable", release: { ...record.release } };
    mutate(record);
    assert.notDeepEqual(
      updaterQaProblems(record, expected, "baseline-preliminary", baselineAuthority(record)),
      [],
      mutate.toString(),
    );
  }
});

test("browser waiver requires the tool baseline context and the pinned macOS 0.1.4 artifact", () => {
  const record = browserWaivedBaselineQa();
  const expected = { target: record.target, channel: "stable", release: { ...record.release } };
  assert.notDeepEqual(updaterQaProblems(record, expected, "baseline-preliminary"), []);
  const wrongTarget = baselineAuthority(record);
  wrongTarget.target = "windows-x86_64";
  assert.notDeepEqual(updaterQaProblems(record, expected, "baseline-preliminary", wrongTarget), []);
  for (const mutate of [
    (r) => (r.release.commit = "a".repeat(40)),
    (r) => (r.release.sha256 = "a".repeat(64)),
    (r) => (r.release.sha256 = "4d4d8897ab376b5532e3940d79c13a2a2674614ade729ace211dba7f662ebb70"),
    (r) => (r.release.version = "0.1.5"),
  ]) {
    const substituted = structuredClone(record);
    mutate(substituted);
    for (const proof of [substituted.kalvoiceUnavailable, substituted.browserUnavailable]) {
      proof.release = { ...substituted.release };
      proof.observation.release = { ...substituted.release };
    }
    assert.notDeepEqual(
      updaterQaProblems(
        substituted,
        { ...expected, release: substituted.release },
        "baseline-preliminary",
        baselineAuthority(substituted),
      ),
      [],
    );
  }
});

test("a baseline browser waiver is refused unless the same platform candidate proves browser", () => {
  const candidateQa = (target) => {
    const record = qaEvidence(target);
    record.status = "preliminary-passed";
    record.updateTrial = null;
    return record;
  };
  const baseline = browserWaivedBaselineQa();
  assert.deepEqual(baselineWaiverCandidateProblems(baseline, candidateQa("darwin-aarch64")), []);
  for (const candidate of [
    undefined,
    null,
    [],
    {},
    Object.assign(candidateQa("darwin-aarch64"), {
      checks: { ...candidateQa("darwin-aarch64").checks, browser: false },
    }),
    Object.assign(candidateQa("darwin-aarch64"), {
      checks: { ...candidateQa("darwin-aarch64").checks, browser: null },
    }),
    Object.assign(candidateQa("darwin-aarch64"), {
      checks: { ...candidateQa("darwin-aarch64").checks, browser: "true" },
    }),
    Object.assign(candidateQa("darwin-aarch64"), { browserUnavailable: baseline.browserUnavailable }),
    candidateQa("windows-x86_64"),
  ]) {
    assert.deepEqual(baselineWaiverCandidateProblems(baseline, candidate), [BROWSER_CANDIDATE_PROBLEM]);
  }
  // Both waivers on the real mac014 shape: each is deferred independently to the candidate.
  const both = isolationWaivedBaselineQa("darwin-aarch64");
  both.checks.browser = false;
  both.browserUnavailable = browserUnavailableProof(both);
  assert.deepEqual(baselineWaiverCandidateProblems(both, candidateQa("darwin-aarch64")), []);
  assert.deepEqual(baselineWaiverCandidateProblems(both, null), [
    ISOLATION_CANDIDATE_PROBLEM,
    BROWSER_CANDIDATE_PROBLEM,
  ]);
  const noBrowser = candidateQa("darwin-aarch64");
  noBrowser.checks.browser = false;
  assert.deepEqual(baselineWaiverCandidateProblems(both, noBrowser), [BROWSER_CANDIDATE_PROBLEM]);
  const noIsolation = candidateQa("darwin-aarch64");
  noIsolation.checks.accountIsolation = false;
  assert.deepEqual(baselineWaiverCandidateProblems(both, noIsolation), [ISOLATION_CANDIDATE_PROBLEM]);
});

function signer() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const publicDer = publicKey.export({ format: "der", type: "spki" });
  const rawPublicKey = publicDer.subarray(publicDer.length - 32);
  const keyId = Buffer.from("0102030405060708", "hex");
  const publicRecord = Buffer.concat([Buffer.from("Ed"), keyId, rawPublicKey]);
  const publicText = ["untrusted comment: minisign public key: test fixture", publicRecord.toString("base64"), ""].join(
    "\n",
  );
  return {
    privateKey,
    keyId,
    publicKeyBase64: Buffer.from(publicText, "utf8").toString("base64"),
  };
}

const releaseSigner = signer();

function signature(
  version = "1.2.3",
  bytes = artifactBytes,
  signingKey = releaseSigner,
  trustedFields = [],
  file = "KalCode_1.2.3_x64-setup.exe",
  orderFields = (fields) => fields,
) {
  const digest = createHash("blake2b512").update(bytes).digest();
  const artifactSignature = signBytes(null, digest, signingKey.privateKey);
  const signatureRecord = Buffer.concat([Buffer.from("ED"), signingKey.keyId, artifactSignature]);
  const trustedComment = orderFields([
    `timestamp:1789992000`,
    `file:${file}`,
    `version:${version}`,
    ...trustedFields,
  ]).join("\t");
  const globalSignature = signBytes(
    null,
    Buffer.concat([artifactSignature, Buffer.from(trustedComment, "utf8")]),
    signingKey.privateKey,
  );
  const text = [
    "untrusted comment: signature from minisign secret key",
    signatureRecord.toString("base64"),
    `trusted comment: ${trustedComment}`,
    globalSignature.toString("base64"),
  ].join("\n");
  return Buffer.from(text, "utf8").toString("base64");
}

function evidence(channel = "stable") {
  const build = {
    version: "1.2.3",
    file: "KalCode_1.2.3_x64-setup.exe",
    commit,
    sha256: artifactSha256,
    size: artifactBytes.length,
    requestedReleaseChannel: channel,
    compiledChannel: channel,
    signed: true,
    releaseDescriptorEligible: true,
    releaseDescriptorBlockedReason: null,
    signatureStatus: "Valid",
    signing: {
      provider: "azure-artifact-signing",
      timestamped: true,
      appTimestamped: true,
      applicationVerifiedDuringBundle: true,
      publisherIdentityBound: true,
    },
    updater: {
      artifactFile: "KalCode_1.2.3_x64-setup.exe",
      signatureFile: "KalCode_1.2.3_x64-setup.exe.sig",
      signatureStatus: "Valid",
      cryptographicallyVerified: true,
      versionBound: true,
      publicKeyConfigured: true,
    },
    guardian: {
      file: "kalcode-provider-guardian.exe",
      sha256: guardianSha256,
      signed: true,
      signatureStatus: "Valid",
      timestamped: true,
      publisherIdentityBound: true,
      bundledBesideApplication: true,
    },
    compiledChannelVerification: {
      status: "verified",
      method: "build_info_probe_v1",
      schemaVersion: 1,
      version: "1.2.3",
      channel,
      testHooks: false,
    },
  };
  const installedAppSignature = { status: "Valid", timestamped: true };
  const afterUninstall = {
    uninstallEntry: false,
    installFolder: false,
    desktopShortcut: false,
    startMenuShortcut: false,
  };
  const installedGuardian = {
    file: build.guardian.file,
    sha256: guardianSha256,
    signatureStatus: "Valid",
    timestamped: true,
    signerMatchesInstaller: true,
  };
  const verify = {
    status: "passed",
    version: build.version,
    file: build.file,
    commit,
    sha256: artifactSha256,
    signatureStatus: "Valid",
    timestamped: true,
    publisherIdentityBound: true,
    updater: { signatureStatus: "Valid", exactBytes: true, versionBound: true },
    guardian: {
      file: build.guardian.file,
      sha256: guardianSha256,
      signatureStatus: "Valid",
      timestamped: true,
      publisherIdentityBound: true,
      allInstallPassesVerified: true,
    },
    launchedApp: false,
    preflight: { existingInstall: [], runningKalcode: [] },
    checks: [{ name: "all checks", ok: true }],
    passes: [
      {
        name: "no-shortcuts",
        installedAppSignature,
        installedAppSignerMatchesInstaller: true,
        installedGuardian,
        afterUninstall,
      },
      {
        name: "default",
        installedAppSignature,
        installedAppSignerMatchesInstaller: true,
        installedGuardian,
        afterUninstall,
      },
      {
        name: "upgrade",
        installedAppSignature,
        installedAppSignerMatchesInstaller: true,
        installedGuardian,
        updateModeRehearsal: true,
        afterUninstall,
      },
    ],
  };
  return { build, verify, qa: qaEvidence("windows-x86_64") };
}

function fixture(channel = "stable") {
  const dir = mkdtempSync(join(tmpdir(), "kalcode-updater-feed-"));
  const artifactPath = join(dir, "KalCode_1.2.3_x64-setup.exe");
  const signaturePath = `${artifactPath}.sig`;
  mkdirSync(dir, { recursive: true });
  writeFileSync(artifactPath, artifactBytes);
  writeFileSync(signaturePath, signature());
  return {
    ...evidence(channel),
    artifactPath,
    artifactKey: `releases/updater/${channel}/1.2.3/${artifactSha256}/KalCode_1.2.3_x64-setup.exe`,
    signaturePath,
    publicKeyBase64: releaseSigner.publicKeyBase64,
  };
}

test("emits the static Tauri feed only from complete signed and verified evidence", async () => {
  const input = fixture();
  const manifest = await createUpdaterManifest({
    ...input,
    publishedAt: "2026-09-25T12:00:00.000Z",
    notes: "Safer updates and faster workspace startup.",
  });
  assert.equal(manifest.version, "1.2.3");
  assert.equal(manifest.pub_date, "2026-09-25T12:00:00.000Z");
  assert.deepEqual(Object.keys(manifest.platforms), ["windows-x86_64"]);
  assert.equal(manifest.platforms["windows-x86_64"].signature, signature());
  assert.equal(
    manifest.platforms["windows-x86_64"].url,
    `https://kalcoded.com/releases/updater/stable/1.2.3/${artifactSha256}/KalCode_1.2.3_x64-setup.exe`,
  );
  assert.equal(manifest.kalcode.channel, "stable");
  assert.equal(manifest.kalcode.commit, commit);
  assert.equal(manifest.kalcode.size, Buffer.byteLength("updater artifact"));
  assert.match(manifest.kalcode.sha256, /^[0-9a-f]{64}$/);
});

test("the website accepts the exact updater descriptor emitted by the release generator", async () => {
  const input = fixture();
  const manifest = await createUpdaterManifest({
    ...input,
    publishedAt: "2026-09-25T12:00:00.000Z",
    notes: "Safer updates and faster workspace startup.",
  });

  const parsed = parseUpdaterDescriptor(manifest, "stable", input.build.version);
  assert.ok(parsed);
  assert.equal(parsed.artifactKey, input.artifactKey);
  assert.equal(parsed.signature, manifest.platforms["windows-x86_64"].signature);
});

test("a build of the public version publishes as X.Y.Z+N with a plus-free artifact name", async () => {
  const version = "1.2.3+41";
  const file = "KalCode_1.2.3_build41_x64-setup.exe";
  const base = evidence();
  const build = {
    ...base.build,
    version,
    file,
    updater: { ...base.build.updater, artifactFile: file, signatureFile: `${file}.sig` },
    compiledChannelVerification: { ...base.build.compiledChannelVerification, version },
  };
  const dir = mkdtempSync(join(tmpdir(), "kalcode-updater-build-"));
  const artifactPath = join(dir, file);
  writeFileSync(artifactPath, artifactBytes);
  writeFileSync(`${artifactPath}.sig`, signature(version, artifactBytes, releaseSigner, [], file));
  const manifest = await createUpdaterManifest({
    build,
    verify: { ...base.verify, version, file },
    qa: qaEvidence("windows-x86_64", version),
    artifactPath,
    artifactKey: `releases/updater/stable/${version}/${artifactSha256}/${file}`,
    signaturePath: `${artifactPath}.sig`,
    publicKeyBase64: releaseSigner.publicKeyBase64,
    publishedAt: "2026-09-30T12:00:00.000Z",
    notes: "A new build of KalCode 1.2.3.",
  });
  assert.equal(manifest.version, version);
  assert.equal(
    manifest.platforms["windows-x86_64"].url,
    `https://kalcoded.com/releases/updater/stable/${version}/${artifactSha256}/${file}`,
  );
  const parsed = parseUpdaterDescriptor(manifest, "stable", version);
  assert.ok(parsed);
  assert.equal(parsed.artifactKey, `releases/updater/stable/${version}/${artifactSha256}/${file}`);
  assert.equal(parseUpdaterDescriptor(manifest, "stable", "1.2.3"), null);
});

test("fails closed for missing updater artifact or detached signature", async () => {
  const missingArtifact = fixture();
  await assert.rejects(
    createUpdaterManifest({
      ...missingArtifact,
      artifactPath: join(missingArtifact.artifactPath, "missing", missingArtifact.build.file),
      publishedAt: "2026-09-25T12:00:00.000Z",
      notes: "Update.",
    }),
    /updater artifact is missing/,
  );
  const missingSignature = fixture();
  await assert.rejects(
    createUpdaterManifest({
      ...missingSignature,
      signaturePath: join(missingSignature.signaturePath, "missing", `${missingSignature.build.file}.sig`),
      publishedAt: "2026-09-25T12:00:00.000Z",
      notes: "Update.",
    }),
    /updater signature is missing/,
  );
});

test("rejects updater URLs that are not digest-qualified for the exact artifact", async () => {
  const input = fixture();
  await assert.rejects(
    createUpdaterManifest({
      ...input,
      artifactKey: "releases/updater/stable/1.2.3/KalCode_1.2.3_x64-setup.exe",
      publishedAt: "2026-09-25T12:00:00.000Z",
      notes: "Update.",
    }),
    /content-addressed/,
  );
});

test("rejects ineligible, unsigned, mismatched-channel, and identity-bearing build evidence", async () => {
  for (const mutate of [
    (input) => ({ ...input, build: { ...input.build, releaseDescriptorEligible: false } }),
    (input) => ({ ...input, build: { ...input.build, signatureStatus: "NotSigned" } }),
    (input) => ({
      ...input,
      build: {
        ...input.build,
        signing: { ...input.build.signing, publisherIdentityBound: false },
      },
    }),
    (input) => ({ ...input, requestedChannel: "beta" }),
    (input) => ({
      ...input,
      build: { ...input.build, signing: { ...input.build.signing, certificateSubject: "private identity" } },
    }),
  ]) {
    const input = mutate(fixture());
    await assert.rejects(
      createUpdaterManifest({
        ...input,
        requestedChannel: input.requestedChannel ?? "stable",
        publishedAt: "2026-09-25T12:00:00.000Z",
        notes: "Update.",
      }),
      /not eligible|signature|channel|redacted/,
    );
  }
});

test("stable feed requires exact clean-install and upgrade verification", async () => {
  const input = fixture();
  for (const verify of [
    { ...input.verify, status: "failed" },
    { ...input.verify, commit: "f".repeat(40) },
    { ...input.verify, passes: input.verify.passes.filter((pass) => pass.name !== "upgrade") },
    {
      ...input.verify,
      passes: input.verify.passes.map((pass) =>
        pass.name === "upgrade" ? { ...pass, updateModeRehearsal: false } : pass,
      ),
    },
  ]) {
    await assert.rejects(
      createUpdaterManifest({
        ...input,
        verify,
        publishedAt: "2026-09-25T12:00:00.000Z",
        notes: "Update.",
      }),
      /verification|upgrade/,
    );
  }
});

test("signature trusted comment must bind the exact manifest version", async () => {
  const input = fixture();
  writeFileSync(input.signaturePath, signature("1.2.4"));
  await assert.rejects(
    createUpdaterManifest({
      ...input,
      publishedAt: "2026-09-25T12:00:00.000Z",
      notes: "Update.",
    }),
    /does not bind version 1.2.3/,
  );
});

test("cryptographically verifies the exact updater bytes with the configured public key", async () => {
  const tamperedArtifact = fixture();
  writeFileSync(tamperedArtifact.artifactPath, Buffer.from("tampered artifact"));
  await assert.rejects(
    createUpdaterManifest({
      ...tamperedArtifact,
      publishedAt: "2026-09-25T12:00:00.000Z",
      notes: "Update.",
    }),
    /signature is invalid/,
  );

  const wrongSigner = fixture();
  writeFileSync(wrongSigner.signaturePath, signature("1.2.3", artifactBytes, signer()));
  await assert.rejects(
    createUpdaterManifest({
      ...wrongSigner,
      publishedAt: "2026-09-25T12:00:00.000Z",
      notes: "Update.",
    }),
    /signature is invalid/,
  );
});

test("a valid signature cannot substitute bytes from a different build record", async () => {
  const input = fixture();
  const substitutedSha256 = "b".repeat(64);
  await assert.rejects(
    createUpdaterManifest({
      ...input,
      artifactKey: `releases/updater/stable/1.2.3/${substitutedSha256}/${input.build.file}`,
      build: { ...input.build, sha256: substitutedSha256 },
      verify: { ...input.verify, sha256: substitutedSha256 },
      qa: {
        ...input.qa,
        release: { ...input.qa.release, sha256: substitutedSha256 },
        updateTrial: {
          ...input.qa.updateTrial,
          candidate: { ...input.qa.updateTrial.candidate, sha256: substitutedSha256 },
          outcomes: input.qa.updateTrial.outcomes.map((outcome) => ({
            ...outcome,
            ...(outcome.step === "rollback"
              ? { from: { ...outcome.from, sha256: substitutedSha256 } }
              : { to: { ...outcome.to, sha256: substitutedSha256 } }),
          })),
        },
      },
      publishedAt: "2026-09-25T12:00:00.000Z",
      notes: "Release notes.",
    }),
    /exact build size and SHA-256/,
  );
});

test("rejects missing keys and ambiguous signed version fields", async () => {
  const missingKey = fixture();
  await assert.rejects(
    createUpdaterManifest({
      ...missingKey,
      publicKeyBase64: undefined,
      publishedAt: "2026-09-25T12:00:00.000Z",
      notes: "Update.",
    }),
    /public key/,
  );

  const duplicateVersion = fixture();
  writeFileSync(duplicateVersion.signaturePath, signature("1.2.3", artifactBytes, releaseSigner, ["version:1.2.3"]));
  await assert.rejects(
    createUpdaterManifest({
      ...duplicateVersion,
      publishedAt: "2026-09-25T12:00:00.000Z",
      notes: "Update.",
    }),
    /version field/,
  );
});

test("v2 preserves Windows gates and cryptographically binds its platform target", async () => {
  const input = fixture();
  input.signaturePath = `${input.artifactPath}.windows-x86_64.sig`;
  writeFileSync(input.signaturePath, signature());
  const options = {
    artifacts: [{ ...input, target: "windows-x86_64" }],
    requestedChannel: "stable",
    publishedAt: "2026-09-25T12:00:00.000Z",
    notes: "Update.",
  };
  await assert.rejects(createPlatformUpdaterManifest(options), /trusted comment/);
  writeFileSync(
    input.signaturePath,
    signature("1.2.3", artifactBytes, releaseSigner, ["target:windows-x86_64", "channel:stable"]),
  );
  const manifest = await createPlatformUpdaterManifest(options);
  assert.equal(manifest.kalcode.schemaVersion, 2);
  writeFileSync(
    input.signaturePath,
    signature("1.2.3", artifactBytes, releaseSigner, ["target:windows-x86_64", "channel:dev"]),
  );
  await assert.rejects(createPlatformUpdaterManifest(options), /channel/);
  assert.deepEqual(manifest.kalcode.artifacts["windows-x86_64"], {
    target: "windows-x86_64",
    format: "nsis",
    size: artifactBytes.length,
    sha256: artifactSha256,
  });
  assert.deepEqual(Object.keys(manifest.platforms), ["windows-x86_64"]);
  writeFileSync(
    input.signaturePath,
    signature("1.2.3", artifactBytes, releaseSigner, ["target:darwin-aarch64", "channel:stable"]),
  );
  await assert.rejects(createPlatformUpdaterManifest(options), /selected platform target/);
});

test("Windows Beta and Dev publication retain exact channel-bound final QA", async () => {
  for (const channel of ["beta", "dev"]) {
    const input = fixture(channel);
    if (channel === "dev") {
      input.build.compiledChannel = "development";
      input.build.compiledChannelVerification.channel = "development";
    }
    input.qa.channel = channel;
    input.qa.updateTrial.method = "signed-local-candidate-v1";
    input.signaturePath = `${input.artifactPath}.windows-x86_64.sig`;
    writeFileSync(
      input.signaturePath,
      signature("1.2.3", artifactBytes, releaseSigner, ["target:windows-x86_64", `channel:${channel}`]),
    );
    const manifest = await createPlatformUpdaterManifest({
      artifacts: [{ ...input, target: "windows-x86_64" }],
      requestedChannel: channel,
      publishedAt: "2026-09-25T12:00:00.000Z",
      notes: "Preview update.",
    });
    assert.equal(manifest.kalcode.channel, channel);
    input.qa.channel = "stable";
    await assert.rejects(
      createPlatformUpdaterManifest({
        artifacts: [{ ...input, target: "windows-x86_64" }],
        requestedChannel: channel,
        publishedAt: "2026-09-25T12:00:00.000Z",
        notes: "Preview update.",
      }),
      /channel does not match/,
    );
  }
});

test("v2 rejects missing, duplicate and unsupported platform artifacts", async () => {
  const options = { requestedChannel: "stable", publishedAt: "2026-09-25T12:00:00.000Z", notes: "Update." };
  for (const artifacts of [
    [],
    [{ target: "darwin-x86_64" }],
    [{ target: "windows-x86_64" }, { target: "windows-x86_64" }],
  ]) {
    await assert.rejects(createPlatformUpdaterManifest({ ...options, artifacts }), /platform artifacts/);
  }
});

test("v2 rejects a valid cryptographic signature with noncanonical field order", async () => {
  const input = fixture();
  input.signaturePath = `${input.artifactPath}.windows-x86_64.sig`;
  writeFileSync(
    input.signaturePath,
    signature(
      "1.2.3",
      artifactBytes,
      releaseSigner,
      ["target:windows-x86_64", "channel:stable"],
      input.build.file,
      ([timestamp, file, version, target, channel]) => [timestamp, version, file, target, channel],
    ),
  );
  await assert.rejects(
    createPlatformUpdaterManifest({
      artifacts: [{ ...input, target: "windows-x86_64" }],
      requestedChannel: "stable",
      publishedAt: "2026-09-25T12:00:00.000Z",
      notes: "Update.",
    }),
    /canonical order/,
  );
});

test("preliminary staging and final publication produce byte-identical candidate descriptors", async () => {
  const input = fixture();
  input.signaturePath = `${input.artifactPath}.windows-x86_64.sig`;
  writeFileSync(
    input.signaturePath,
    signature("1.2.3", artifactBytes, releaseSigner, ["target:windows-x86_64", "channel:stable"]),
  );
  const preliminary = {
    ...input.qa,
    status: "preliminary-passed",
    updateTrial: null,
  };
  const common = {
    requestedChannel: "stable",
    publishedAt: "2026-09-25T12:00:00.000Z",
    notes: "Update.",
  };
  const staged = await createPlatformUpdaterManifest({
    ...common,
    qaPhase: "preliminary",
    artifacts: [{ ...input, qa: preliminary, target: "windows-x86_64" }],
  });
  const final = await createPlatformUpdaterManifest({
    ...common,
    artifacts: [{ ...input, target: "windows-x86_64" }],
  });
  assert.equal(`${JSON.stringify(staged, null, 2)}\n`, `${JSON.stringify(final, null, 2)}\n`);
  await assert.rejects(
    createPlatformUpdaterManifest({
      ...common,
      artifacts: [{ ...input, qa: preliminary, target: "windows-x86_64" }],
    }),
    /completed updater QA/,
  );
});

test("an owner-waived update trial lowers only that artifact to the preliminary contract", async () => {
  const input = fixture();
  input.signaturePath = `${input.artifactPath}.windows-x86_64.sig`;
  writeFileSync(
    input.signaturePath,
    signature("1.2.3", artifactBytes, releaseSigner, ["target:windows-x86_64", "channel:stable"]),
  );
  const pending = { ...input.qa, status: "preliminary-passed", updateTrial: null };
  const common = { requestedChannel: "stable", publishedAt: "2026-09-25T12:00:00.000Z", notes: "Update." };
  const final = await createPlatformUpdaterManifest({ ...common, artifacts: [{ ...input, target: "windows-x86_64" }] });
  const waived = await createPlatformUpdaterManifest({
    ...common,
    artifacts: [{ ...input, qa: pending, target: "windows-x86_64", updateTrialWaived: true }],
  });
  assert.equal(JSON.stringify(waived), JSON.stringify(final));
  // The waiver never excuses product checks or safeguards, and is only an explicit boolean on a final publication.
  const broken = { ...pending, checks: { ...pending.checks, [Object.keys(pending.checks)[0]]: false } };
  await assert.rejects(
    createPlatformUpdaterManifest({
      ...common,
      artifacts: [{ ...input, qa: broken, target: "windows-x86_64", updateTrialWaived: true }],
    }),
    /product checks are incomplete/,
  );
  await assert.rejects(
    createPlatformUpdaterManifest({
      ...common,
      artifacts: [{ ...input, qa: pending, target: "windows-x86_64", updateTrialWaived: "yes" }],
    }),
    /waiver applies only to a final publication/,
  );
  await assert.rejects(
    createPlatformUpdaterManifest({
      ...common,
      qaPhase: "preliminary",
      artifacts: [{ ...input, qa: pending, target: "windows-x86_64", updateTrialWaived: true }],
    }),
    /waiver applies only to a final publication/,
  );
});

test("publish.mjs carries an update-trial waiver into every platform manifest it builds or re-verifies", () => {
  // Regression (deputy R1): the final readback re-verification must use the same per-artifact waiver as the
  // first build, or a waived publication fails in Bootstrap/ConfirmAfterDeploy after the uploads.
  const source = readFileSync(new URL("./publish.mjs", import.meta.url), "utf8");
  const builds = source.match(/createPlatformUpdaterManifest\(/g) ?? [];
  const spreads = source.match(/\.\.\.packet,/g) ?? [];
  const waived =
    source.match(
      /\.\.\.packet,\s+\.\.\.\(trialWaiver\?\.target === packet\.target && \{ updateTrialWaived: true \}\),/g,
    ) ?? [];
  assert.equal(builds.length, 2);
  assert.equal(spreads.length, builds.length);
  assert.equal(waived.length, builds.length);
});

test("publish.mjs builds every updater descriptor in the staging tool's platform order", () => {
  // Regression: the staged, immutable stable/<version>.json lists windows-x86_64 before darwin-aarch64; an
  // alphabetical order produces different bytes and the frozen-file check refuses the publication.
  const source = readFileSync(new URL("./publish.mjs", import.meta.url), "utf8");
  assert.match(source, /const UPDATER_TARGET_ORDER = \["windows-x86_64", "darwin-aarch64"\];/);
  assert.equal((source.match(/createPlatformUpdaterManifest\(/g) ?? []).length, 2);
  assert.equal((source.match(/inUpdaterOrder\((?:packets|downloadedInputs)\)/g) ?? []).length, 2);
});

test("stable generators reject prerelease versions before artifact I/O", async () => {
  const input = fixture();
  input.build.version = "1.2.3-beta.1";
  const common = { requestedChannel: "stable", publishedAt: "2026-09-25T12:00:00.000Z", notes: "Update." };
  await assert.rejects(createUpdaterManifest({ ...input, ...common }), /prerelease/);
  await assert.rejects(
    createPlatformUpdaterManifest({ ...common, artifacts: [{ ...input, target: "windows-x86_64" }] }),
    /prerelease/,
  );
});

function macFixture() {
  const file = "KalCode_1.2.3_arm64.dmg";
  const dir = mkdtempSync(join(tmpdir(), "kalcode-mac-feed-"));
  const artifactPath = join(dir, file);
  const signaturePath = `${artifactPath}.sig`;
  writeFileSync(artifactPath, artifactBytes);
  writeFileSync(
    signaturePath,
    signature("1.2.3", artifactBytes, releaseSigner, ["target:darwin-aarch64", "channel:stable"], file),
  );
  const build = {
    schemaVersion: 1,
    platform: "macos",
    arch: "arm64",
    version: "1.2.3",
    file,
    size: artifactBytes.length,
    sha256: artifactSha256,
    commit,
    notarySubmissionId: "12345678-1234-4234-8234-123456789abc",
    signed: true,
    signatureStatus: "Valid",
    releaseDescriptorEligible: true,
    releaseDescriptorBlockedReason: null,
    requestedReleaseChannel: "stable",
    compiledChannel: "stable",
    compiledChannelVerification: {
      schemaVersion: 1,
      version: "1.2.3",
      channel: "stable",
      method: "build_info_probe_v1",
      testHooks: false,
    },
    helpers: [
      ["kalcode-update-helper", "com.kalcode.desktop.update-helper"],
      ["kalcode-provider-guardian", "com.kalcode.desktop.provider-guardian"],
      ["kalcode-hook", "com.kalcode.desktop.hook"],
    ].map(([name, identifier], index) => ({
      name,
      identifier,
      architecture: "arm64",
      sha256: String(index + 1).repeat(64),
      signed: true,
      expectedTeamBound: true,
      hardenedRuntime: true,
      timestamped: true,
    })),
  };
  const verify = {
    ...build,
    status: "passed",
    exactArtifact: true,
    developerIdApplication: true,
    expectedTeam: true,
    hardenedRuntime: true,
    timestamped: true,
    entitlementsExact: true,
    notaryAccepted: true,
    notaryLogIssueFree: true,
    ticketStapled: true,
    gatekeeperAccepted: true,
  };
  const qa = qaEvidence("darwin-aarch64");
  return {
    target: "darwin-aarch64",
    build,
    verify,
    qa,
    artifactPath,
    signaturePath,
    artifactKey: `releases/updater/stable/1.2.3/${artifactSha256}/${file}`,
    publicKeyBase64: releaseSigner.publicKeyBase64,
  };
}

test("v2 publishes only the verified platforms without inventing parity", async () => {
  const mac = macFixture();
  const options = {
    artifacts: [mac],
    requestedChannel: "stable",
    publishedAt: "2026-09-25T12:00:00.000Z",
    notes: "Update.",
  };
  const macOnly = await createPlatformUpdaterManifest(options);
  assert.deepEqual(Object.keys(macOnly.platforms), ["darwin-aarch64"]);
  assert.equal(macOnly.kalcode.artifacts["darwin-aarch64"].format, "dmg");
  const windows = { ...fixture(), target: "windows-x86_64" };
  windows.signaturePath = `${windows.artifactPath}.windows-x86_64.sig`;
  writeFileSync(
    windows.signaturePath,
    signature("1.2.3", artifactBytes, releaseSigner, ["target:windows-x86_64", "channel:stable"]),
  );
  const both = await createPlatformUpdaterManifest({ ...options, artifacts: [windows, mac] });
  assert.deepEqual(Object.keys(both.platforms), ["windows-x86_64", "darwin-aarch64"]);
  mac.build.commit = "b".repeat(40);
  await assert.rejects(
    createPlatformUpdaterManifest({ ...options, artifacts: [windows, mac] }),
    /exact version and source commit/,
  );
});

test("stage assembly selects baseline capability validation only for the explicit baseline role", async () => {
  const windows = { ...fixture(), target: "windows-x86_64" };
  windows.signaturePath = `${windows.artifactPath}.windows-x86_64.sig`;
  writeFileSync(
    windows.signaturePath,
    signature("1.2.3", artifactBytes, releaseSigner, ["target:windows-x86_64", "channel:stable"]),
  );
  const packets = [windows, macFixture()];
  for (const packet of packets) {
    packet.build.builtAt = "2026-01-01T00:00:00.000Z";
    packet.qa = unavailableBaselineQa(packet.target);
  }
  const staging = mkdtempSync(join(tmpdir(), "kalcode-stage-baseline-role-"));
  const options = { staging, source: staging, packets, version: "1.2.3", notes: "Private test baseline", write: false };
  // The fixtures deliberately use another signing key. Baseline selection must reach
  // real signature verification before creating any trusted capability context.
  await assert.rejects(assembleRelease({ ...options, role: "baseline" }), /updater signature is invalid/);
  await assert.rejects(assembleRelease(options), /QA record has unexpected fields/);
  await assert.rejects(assembleRelease({ ...options, role: "candidate" }), /QA record has unexpected fields/);
  await assert.rejects(assembleRelease({ ...options, role: "unknown" }), /role is invalid/);
});

test("baseline phase keeps real artifact, signature, and Mac notarization guards", async () => {
  for (const target of ["windows-x86_64", "darwin-aarch64"]) {
    const input = target === "darwin-aarch64" ? macFixture() : { ...fixture(), target };
    if (target === "windows-x86_64") {
      input.signaturePath = `${input.artifactPath}.${target}.sig`;
      writeFileSync(
        input.signaturePath,
        signature("1.2.3", artifactBytes, releaseSigner, [`target:${target}`, "channel:stable"]),
      );
    }
    input.qa = unavailableBaselineQa(target);
    const options = {
      artifacts: [input],
      requestedChannel: "stable",
      notes: "Private test baseline",
      publishedAt: "2026-01-01T00:00:00.000Z",
      qaPhase: "baseline-preliminary",
    };
    // Even correctly signed unapproved bytes/source cannot claim the pinned disposition.
    await assert.rejects(createPlatformUpdaterManifest(options), /unavailability evidence is invalid/);
    writeFileSync(input.artifactPath, Buffer.from("changed artifact"));
    await assert.rejects(createPlatformUpdaterManifest(options), /signature is invalid/);
    if (target === "darwin-aarch64") {
      input.verify.notaryAccepted = false;
      await assert.rejects(createPlatformUpdaterManifest(options), /notarization verification is incomplete/);
    } else {
      input.build.signatureStatus = "Invalid";
      await assert.rejects(createPlatformUpdaterManifest(options), /Authenticode signature is not valid/);
    }
  }
});

test("v2 Mac feed refuses incomplete signing, physical QA and channel evidence", async () => {
  for (const corrupt of [
    (input) => {
      input.build.helpers.pop();
    },
    (input) => {
      input.build.helpers[0].signed = false;
    },
    (input) => {
      input.build.releaseDescriptorEligible = false;
    },
    (input) => {
      input.build.compiledChannelVerification.method = "unverified";
    },
    (input) => {
      input.verify.notaryAccepted = false;
    },
    (input) => {
      input.verify.gatekeeperAccepted = false;
    },
    (input) => {
      input.verify.commit = "b".repeat(40);
    },
    (input) => {
      input.qa.checks.kalvoice = false;
    },
    (input) => {
      input.qa.release.sha256 = "b".repeat(64);
    },
    (input) => {
      input.build.compiledChannelVerification.testHooks = true;
    },
    (input) => {
      input.build.compiledChannel = "development";
    },
  ]) {
    const mac = macFixture();
    corrupt(mac);
    await assert.rejects(
      createPlatformUpdaterManifest({
        artifacts: [mac],
        requestedChannel: "stable",
        publishedAt: "2026-09-25T12:00:00.000Z",
        notes: "Update.",
      }),
    );
  }
});

test("Mac Beta and Dev publication retain exact channel-bound final QA", async () => {
  for (const channel of ["beta", "dev"]) {
    const mac = macFixture();
    mac.build.requestedReleaseChannel = channel;
    mac.build.compiledChannel = channel === "dev" ? "development" : channel;
    mac.build.compiledChannelVerification.channel = mac.build.compiledChannel;
    mac.artifactKey = `releases/updater/${channel}/1.2.3/${artifactSha256}/${mac.build.file}`;
    writeFileSync(
      mac.signaturePath,
      signature("1.2.3", artifactBytes, releaseSigner, ["target:darwin-aarch64", `channel:${channel}`], mac.build.file),
    );
    mac.qa.channel = channel;
    mac.qa.updateTrial.method = "signed-local-candidate-v1";
    const manifest = await createPlatformUpdaterManifest({
      artifacts: [mac],
      requestedChannel: channel,
      publishedAt: "2026-09-25T12:00:00.000Z",
      notes: "Preview update.",
    });
    assert.equal(manifest.kalcode.channel, channel);
    mac.qa.channel = "stable";
    await assert.rejects(
      createPlatformUpdaterManifest({
        artifacts: [mac],
        requestedChannel: channel,
        publishedAt: "2026-09-25T12:00:00.000Z",
        notes: "Preview update.",
      }),
      /channel does not match/,
    );
  }
});
