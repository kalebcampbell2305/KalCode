// The canonical KalCode release phases, in order. The ORDER, the dependencies, the effect class and the
// approval requirement of every phase are fixed here in code: a kit (the per-release set of proven scripts)
// only supplies HOW a phase runs, never whether it may touch production or needs a person.
//
// Effects:
//   read        local, read-only (git reads, hashing, credential status probes)
//   local       local writes only (builds, signing, local branches/commits, files under target/ or .worktrees/)
//   mac         writes on the release Mac over ssh (bundles, gates, package job)
//   prod-read   read-only requests to production (D1 SELECTs, public GETs, R2 reads)
//   prod-write  production writes (R2 objects, D1 rows/pointer, Worker deploy); always one explicit phase per invocation
//   human       a person does it (OAuth/2FA, physical checks, review, merge); recorded with `ship.mjs attest`

export const EFFECTS = Object.freeze(["read", "local", "mac", "prod-read", "prod-write", "human"]);

export const GROUPS = Object.freeze(["test", "build", "certify", "qa", "stage", "publish", "feed", "verify"]);

const phase = (id, group, effect, needs, title, extra = {}) =>
  Object.freeze({ id, group, effect, needs: Object.freeze(needs), title, ...extra });

export const PHASES = Object.freeze([
  // test
  phase(
    "identity",
    "test",
    "read",
    [],
    "Release identity: the exact commit declares --version in every version authority",
    {
      builtin: "identity",
    },
  ),
  phase(
    "prereqs",
    "test",
    "read",
    ["identity"],
    "Toolchain and credential probes (Node, updater key, Azure signing token, Mac Developer ID, ssh)",
    {
      human:
        "If a probe fails for a credential (az login, Mac keychain unlock, ssh key), the owner renews it; nothing else is asked.",
    },
  ),
  phase(
    "branches",
    "test",
    "local",
    ["identity"],
    "Derive release branches locally: baseline, staging tool T, notes N0, website W (never pushed)",
    {
      skippable: true,
    },
  ),
  phase("gates-windows", "test", "local", ["identity"], "Windows release gates at the exact commit"),
  phase("gates-mac", "test", "mac", ["identity"], "Native Mac gates at the exact commit (over ssh)"),
  // build + sign
  phase(
    "build-windows",
    "build",
    "local",
    ["prereqs", "branches", "gates-windows"],
    "Windows build + Authenticode (Azure Artifact Signing) + updater Minisign, candidate and baseline",
  ),
  phase(
    "verify-windows",
    "build",
    "local",
    ["build-windows"],
    "Clean-machine install/upgrade/uninstall verification (disposable data root, CI runner or VM)",
    {
      human:
        "Run verify-windows on a clean Windows state (CI windows-release-verify.yml, a VM, or a disposable data root) and attest its verify.json.",
    },
  ),
  phase(
    "bundle-mac",
    "build",
    "mac",
    ["branches", "gates-mac"],
    "Transfer the exact commits to the Mac as verified git bundles",
  ),
  phase(
    "package-mac",
    "build",
    "mac",
    ["prereqs", "bundle-mac"],
    "Mac build + Developer ID signing + notarization + stapling (launchd job in the owner's GUI session)",
    {
      approval: true,
      approvalReason:
        "launches the signing and Apple notarization job with the owner's Developer ID and notary keychain profile",
    },
  ),
  // certify
  phase("certify-windows", "certify", "local", ["build-windows"], "Independent Windows artifact certification"),
  phase(
    "certify-mac",
    "certify",
    "mac",
    ["package-mac"],
    "Harvest, independent Mac certification and Mac updater signature (signed on Windows)",
  ),
  phase(
    "pins",
    "certify",
    "local",
    ["verify-windows", "certify-windows", "certify-mac"],
    "Derive every release pin from receipts and fill the kit (no hand-edited pins)",
    {
      builtin: "pins",
    },
  ),
  // qa
  phase(
    "qa-sittings",
    "qa",
    "human",
    ["pins"],
    "Human QA that no machine can do: sign-ins (OAuth/2FA), microphone, physical sleep, GUI-only rows",
    {
      human:
        "Run the release's QA sheet on a disposable data root / clean state on the main account (or a VM). Attest when the evidence roots are sealed.",
    },
  ),
  phase(
    "qa-records",
    "qa",
    "local",
    ["qa-sittings"],
    "Bind the QA evidence into the four records and validate them with the byte-pinned contract",
  ),
  phase(
    "notes",
    "qa",
    "local",
    ["pins"],
    "Fill the release notes from the certified artifacts and commit N locally (never pushed)",
  ),
  // stage
  phase(
    "preflight-prod",
    "stage",
    "prod-read",
    ["notes"],
    "Production preflight: exact D1 rows, no pointer, no pending migration (read-only)",
  ),
  phase(
    "stage-preconditions",
    "stage",
    "local",
    ["qa-records", "preflight-prod"],
    "Generate the stage-preconditions receipt from receipts (primary acceptance)",
    {
      approval: true,
      approvalReason: "primary acceptance of the four preliminary QA records and the production preflight",
    },
  ),
  phase(
    "stage",
    "stage",
    "prod-write",
    ["stage-preconditions"],
    "Stage the unlisted immutable baseline + candidate (R2 objects, D1 version rows; no pointer)",
    {
      approval: true,
      approvalReason:
        "creates immutable, write-once production R2 objects and D1 version rows (versions are burned forever)",
    },
  ),
  phase("readback", "stage", "prod-read", ["stage"], "Full byte readback of the staged objects and rows (read-only)"),
  phase(
    "lifecycle",
    "stage",
    "human",
    ["readback"],
    "Physical lifecycle on the staged versions: installer upgrade (LC-A) and in-app update/restore/reupdate (LC-B)",
    {
      human:
        "Run LC-A and LC-B on Windows and Mac against the unlisted staged descriptors; attest with both lifecycle receipts.",
    },
  ),
  // publish
  phase(
    "release-review",
    "publish",
    "human",
    ["lifecycle"],
    "Independent release review of the final records, notes and receipts",
    {
      human: "A reviewer other than the operator checks the final records, notes and receipts and attests PASS.",
    },
  ),
  phase(
    "release-preconditions",
    "publish",
    "local",
    ["release-review"],
    "Generate the release-preconditions receipt (lifecycles, final records, review) from receipts",
    {
      approval: true,
      approvalReason: "primary acceptance of the final QA records, both lifecycles and the independent review",
    },
  ),
  phase(
    "publish-dry-run",
    "publish",
    "prod-read",
    ["release-preconditions"],
    "Publisher dry run from N (every check, no upload)",
  ),
  phase(
    "publish",
    "publish",
    "prod-write",
    ["publish-dry-run"],
    "Publish: immutable upload + D1 channel pointer (first cutover: bootstrap authority)",
    {
      approval: true,
      approvalReason: "moves the production release pointer (business go/no-go)",
    },
  ),
  // update feed + website
  phase(
    "website-assemble",
    "feed",
    "local",
    ["publish"],
    "Assemble the website commit (notes + website + generated releases.json + catalog flag) and run its checks",
  ),
  phase(
    "website-merge",
    "feed",
    "human",
    ["website-assemble"],
    "Push the website branch, open the PR, independent review, merge (never push to main directly)",
    {
      human: "Push the assembled branch, open the PR, get it reviewed and merged; attest with the merged commit.",
    },
  ),
  phase("deploy", "feed", "prod-write", ["website-merge"], "Deploy the merged website commit to production (Worker)", {
    approval: true,
    approvalReason: "deploys the production website/Worker that serves downloads and the update feed",
  }),
  phase(
    "confirm",
    "feed",
    "prod-write",
    ["deploy"],
    "Post-deploy publisher confirmation from a fresh N checkout (same-version pointer compare-and-set)",
    {
      approval: true,
      approvalReason: "writes the production D1 pointer (same version, compare-and-set)",
      skippable: true,
    },
  ),
  // public verification
  phase(
    "live-verify",
    "verify",
    "prod-read",
    ["confirm"],
    "Public verification: feeds, downloads, signatures, ranges, site pages (read-only)",
  ),
  phase(
    "live-human",
    "verify",
    "human",
    ["live-verify"],
    "Download and install from the public site on a clean state and confirm the update offer",
    {
      human:
        "Download from kalcoded.com on a clean state (disposable data root / VM), install, launch, confirm version and update offer; attest.",
    },
  ),
]);

export function phaseById(id, phases = PHASES) {
  return phases.find((p) => p.id === id);
}

// --phase accepts "all", a phase id, a group ("group:<name>", or the bare name when no phase has that id), or a
// comma list of those. A phase id always wins over a group of the same name ("stage", "publish"). Returns the
// phases in canonical order plus the set named explicitly by id (production writes must be named explicitly).
export function selectPhases(selector, phases = PHASES) {
  const tokens = String(selector ?? "all")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  const chosen = new Set();
  const explicit = new Set();
  for (const t of tokens) {
    const group = t.startsWith("group:") ? t.slice(6) : null;
    if (t === "all") {
      for (const p of phases) chosen.add(p.id);
    } else if (!group && phaseById(t, phases)) {
      chosen.add(t);
      explicit.add(t);
    } else if (GROUPS.includes(group ?? t) && phases.some((p) => p.group === (group ?? t))) {
      for (const p of phases) if (p.group === (group ?? t)) chosen.add(p.id);
    } else {
      throw new Error(
        `REFUSED: unknown phase or group "${t}" (phases: ${phases.map((p) => p.id).join(", ")}; groups: ${GROUPS.join(", ")})`,
      );
    }
  }
  return { phases: phases.filter((p) => chosen.has(p.id)), explicit };
}

export function validateRegistry(phases = PHASES) {
  const seen = new Set();
  for (const p of phases) {
    if (seen.has(p.id)) throw new Error(`duplicate phase ${p.id}`);
    if (!EFFECTS.includes(p.effect)) throw new Error(`phase ${p.id}: unknown effect ${p.effect}`);
    for (const n of p.needs)
      if (!seen.has(n)) throw new Error(`phase ${p.id} needs ${n}, which is not an earlier phase`);
    if (p.effect === "prod-write" && !p.approval)
      throw new Error(`phase ${p.id}: a production write must require approval`);
    seen.add(p.id);
  }
  return true;
}
