#!/usr/bin/env node
// The one KalCode release command: test -> build+sign -> certify -> pins -> QA -> stage -> publish -> update
// feed -> public verification, with resumable state, create-once receipts and hard gates. Dry run by default.
//
//   node tooling/release/ship.mjs [run] --version X.Y.Z[+N] --commit <sha40> [--baseline-version A.B.C[+N]]
//        [--phase all|<group>|<phase>[,...]] [--execute] [--adopt --evidence key=path ...] [--redo] [--json]
//   node tooling/release/ship.mjs status  --version ... --commit ...
//   node tooling/release/ship.mjs approve --version ... --commit ... --phase <p> --by "<name>" --confirm <p>:<version>:<sha7>
//   node tooling/release/ship.mjs attest  --version ... --commit ... --phase <p> --by "<name>" [--evidence key=path ...] [--note "..."]
//   node tooling/release/ship.mjs pins    --version ... --commit ...
//
// Options: --kit <manifest> (default: the one kit in tooling/release/ship/kits that binds this version+commit),
//          --state <dir> (default <repo>/target/release-pipeline/<version>-<sha12>), --repo <dir> (default: the
//          main checkout that owns this worktree), --channel stable.
//
// Definition of Done: ship.mjs classify --base <ref> --head <ref> [--json]; ship.mjs lifecycle status|hook;
//                     ship.mjs gate [--base origin/main] [--list] (tooling/release/lifecycle/cli.mjs).
// See docs/RELEASE-PIPELINE.md.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { ShipError, validateIdentity } from "./ship/context.mjs";
import { Pipeline } from "./ship/engine.mjs";
import { assertBinds, findKit, kitCoverage, loadKit } from "./ship/kit.mjs";
import { validateRegistry } from "./ship/phases.mjs";

const COMMANDS = new Set(["run", "plan", "status", "approve", "attest", "pins"]);
const VALUED = new Set([
  "--version",
  "--commit",
  "--baseline-version",
  "--channel",
  "--phase",
  "--kit",
  "--state",
  "--repo",
  "--by",
  "--confirm",
  "--note",
  "--evidence",
]);
const FLAGS = new Set(["--execute", "--adopt", "--redo", "--json", "--help"]);

export function parseArgs(argv) {
  const args = [...argv];
  const command = args[0] && !args[0].startsWith("--") ? args.shift() : "run";
  if (!COMMANDS.has(command)) throw new ShipError(`REFUSED: unknown command ${command} (${[...COMMANDS].join(", ")})`);
  const opts = { command, evidence: {} };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (FLAGS.has(a)) {
      opts[a.slice(2)] = true;
      continue;
    }
    if (!VALUED.has(a)) throw new ShipError(`REFUSED: unknown argument ${a}`);
    const v = args[++i];
    if (v === undefined || (v.startsWith("--") && v.length > 2)) throw new ShipError(`REFUSED: ${a} needs a value`);
    if (a === "--evidence") {
      const m = /^([A-Za-z][A-Za-z0-9]*)=(.+)$/.exec(v);
      if (!m) throw new ShipError(`REFUSED: --evidence takes key=path, got ${v}`);
      if (opts.evidence[m[1]]) throw new ShipError(`REFUSED: --evidence ${m[1]} given twice`);
      opts.evidence[m[1]] = m[2];
      continue;
    }
    const key = a.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    if (opts[key] !== undefined) throw new ShipError(`REFUSED: ${a} given twice`);
    opts[key] = v;
  }
  if (command === "plan") opts.command = "run";
  return opts;
}

export function mainRepo(from) {
  const r = spawnSync("git", ["-C", from, "rev-parse", "--path-format=absolute", "--git-common-dir"], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (r.status !== 0) throw new ShipError("REFUSED: not inside a git checkout; pass --repo");
  return dirname(r.stdout.trim());
}

export function createPipeline(opts, { log, echo = true } = {}) {
  validateRegistry();
  const identity = validateIdentity({
    version: opts.version,
    commit: opts.commit,
    baselineVersion: opts.baselineVersion ?? null,
    channel: opts.channel ?? "stable",
  });
  const repo = resolve(opts.repo ?? mainRepo(dirname(fileURLToPath(import.meta.url))));
  const kitPath = opts.kit ? resolve(opts.kit) : findKit(identity);
  const loadedKit = loadKit(kitPath);
  assertBinds(loadedKit.kit, identity);
  const stateDir = resolve(
    opts.state ?? join(repo, "target", "release-pipeline", `${identity.version}-${identity.commit.slice(0, 12)}`),
  );
  return new Pipeline({ repo, identity, loadedKit, stateDir, echo, ...(log ? { log } : {}) });
}

const LIFECYCLE_COMMANDS = new Set(["classify", "lifecycle", "gate"]);
const USAGE_ERRORS = new Set(["ShipError", "UsageError", "PolicyError", "GitError"]);

export async function main(argv, io = {}) {
  if (LIFECYCLE_COMMANDS.has(argv[0])) {
    const { lifecycleMain } = await import("./lifecycle/cli.mjs");
    return lifecycleMain(argv, io);
  }
  const log = io.log ?? ((line) => process.stdout.write(`${line}\n`));
  const opts = parseArgs(argv);
  if (opts.help) {
    log(
      readFileSync(fileURLToPath(import.meta.url), "utf8")
        .split("\n")
        .slice(1, 18)
        .map((l) => l.replace(/^\/\/ ?/, ""))
        .join("\n"),
    );
    return 0;
  }
  const pipeline = createPipeline(opts, { log, echo: io.echo ?? true });
  switch (opts.command) {
    case "run": {
      const gaps = kitCoverage(pipeline.kit);
      if (gaps.length && !opts.execute)
        log(`note: kit ${pipeline.kit.name} has no steps yet for: ${gaps.join(", ")}\n`);
      if (!opts.execute && opts.json) {
        pipeline.printPlan(opts.phase ?? "all", { json: true });
        return 0;
      }
      const r = await pipeline.run(opts.phase ?? "all", {
        execute: Boolean(opts.execute),
        adopt: Boolean(opts.adopt),
        redo: Boolean(opts.redo),
        evidence: opts.evidence,
      });
      return r.code;
    }
    case "status": {
      const rows = pipeline.describe(opts.phase ?? "all");
      if (opts.json)
        log(
          JSON.stringify(
            rows.map(({ id, status, detail }) => ({ id, status, detail })),
            null,
            2,
          ),
        );
      else for (const r of rows) log(`${r.status.padEnd(17)} ${r.id.padEnd(22)} ${r.detail ?? ""}`);
      return 0;
    }
    case "approve": {
      if (!opts.phase) throw new ShipError("REFUSED: approve needs --phase");
      const a = pipeline.approve(opts.phase, { by: opts.by, confirm: opts.confirm });
      log(`approved ${opts.phase} by ${a.value.by}: ${a.path} (inputs ${a.value.inputsDigest.slice(0, 12)})`);
      return 0;
    }
    case "attest": {
      if (!opts.phase) throw new ShipError("REFUSED: attest needs --phase");
      const a = pipeline.attest(opts.phase, { by: opts.by, evidence: opts.evidence, note: opts.note ?? null });
      log(
        `attested ${opts.phase} by ${a.value.by}: ${a.path} (${Object.keys(a.value.evidence).length} evidence file(s))`,
      );
      return 0;
    }
    case "pins": {
      const r = pipeline.state.receipt("pins");
      if (!r) throw new ShipError("REFUSED: the pins phase has not run yet");
      log(readFileSync(r.value.outputs.pinsJson.path, "utf8"));
      return 0;
    }
    default:
      throw new ShipError(`REFUSED: unknown command ${opts.command}`);
  }
}

const invoked = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      process.stderr.write(`${e instanceof ShipError || USAGE_ERRORS.has(e?.name) ? e.message : e.stack}\n`);
      process.exit(1);
    },
  );
}
