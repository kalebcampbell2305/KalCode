// The release state machine behind ship.mjs: evaluates every phase against its receipts, approvals and
// attestations, prints the resolved plan (default), and with --execute runs phases in canonical order until
// the first gate that needs a person. It never decides policy on its own: effects, order and approval
// requirements come from phases.mjs, the work comes from the kit's pinned scripts.
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

import { canonicalJson, identityVars, lookup, refuse, resolveDeep, resolveString, ShipError } from "./context.mjs";
import { verifyScripts } from "./kit.mjs";
import { PHASES, phaseById, selectPhases } from "./phases.mjs";
import {
  fileIdentity,
  freshPath,
  RECEIPT_SCHEMA,
  ReleaseState,
  sha256Bytes,
  sha256File,
  stableJson,
  writeCreateOnce,
} from "./state.mjs";

export const RECEIPT_LINE = "receipt: (?<path>\\S+)\\s+sha256 (?<sha256>[0-9a-f]{64})";
const DONE = new Set(["DONE", "SKIPPED"]);
const MAX_CAPTURE = 64 * 1024 * 1024;

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

export class Pipeline {
  constructor({
    repo,
    identity,
    loadedKit,
    stateDir,
    phases = PHASES,
    echo = false,
    log = (line) => process.stdout.write(`${line}\n`),
    now = () => new Date(),
  }) {
    this.repo = repo;
    this.identity = identity;
    this.kit = loadedKit.kit;
    this.kitSha256 = loadedKit.sha256;
    this.kitPath = loadedKit.path;
    this.phases = phases;
    this.echo = echo;
    this.log = log;
    this.now = now;
    this.state = new ReleaseState(stateDir, { now });
    this.baseVars = { ...identityVars(identity), repo, state: stateDir };
    this.kitVars = {};
    for (const [k, v] of Object.entries(this.kit.vars ?? {})) this.kitVars[k] = resolveString(v, this.baseVars).value;
  }

  // ---------------------------------------------------------------- variables and digests

  vars(extra = {}) {
    const out = {};
    const attest = {};
    for (const p of this.phases) {
      const r = this.state.receipt(p.id);
      if (r) out[p.id] = r.value.outputs ?? {};
      const a = this.state.attestation(p.id);
      if (a) attest[p.id] = { by: a.value.by, at: a.value.at, values: a.value.values ?? {} };
    }
    return { ...this.baseVars, ...this.kitVars, out, attest, ...extra };
  }

  #def(phase) {
    return this.kit.phases?.[phase.id] ?? {};
  }

  #needsApproval(phase) {
    return Boolean(phase.approval) || phase.effect === "prod-write";
  }

  #needsOperator(phase) {
    const def = this.#def(phase);
    return phase.effect === "human" || (def.steps ?? []).some((s) => s.operator);
  }

  #resolveCommand(step, vars, lenientThis) {
    const r = resolveDeep({ run: step.run, cwd: step.cwd ?? "{repo}", env: step.env ?? {} }, vars, {
      lenient: lenientThis,
    });
    if (lenientThis) {
      const bad = r.missing.filter((m) => !m.startsWith("this."));
      if (bad.length) refuse(`step ${step.id}: unresolved ${bad.map((m) => `{${m}}`).join(", ")}`);
      if (/PLACEHOLDER/.test(JSON.stringify(r.value)))
        refuse(`step ${step.id}: a resolved argument still carries a PLACEHOLDER token`);
    }
    return r.value;
  }

  // What an approval or attestation is bound to: the phase, the release, the kit bytes, the exact receipts of
  // its inputs and every fully resolved command it will run. Any change makes the approval stale.
  inputsDigest(phase) {
    const inputs = Object.fromEntries(phase.needs.map((n) => [n, this.state.receipt(n)?.sha256 ?? null]));
    const vars = this.vars();
    const commands = (this.#def(phase).steps ?? [])
      .filter((s) => s.run)
      .map((s) => ({ id: s.id, ...this.#resolveCommand(s, vars, true) }));
    const body = { phase: phase.id, identity: this.identity, kit: this.kitSha256, inputs, commands };
    return { digest: sha256Bytes(canonicalJson(body)), inputs, commands };
  }

  // ---------------------------------------------------------------- evaluation

  evaluate() {
    const result = new Map();
    for (const p of this.phases) {
      const r = this.state.receipt(p.id);
      const needBad = p.needs.filter((n) => !DONE.has(result.get(n)?.status));
      if (r) {
        const changed = p.needs.filter((n) => r.value.inputs?.[n] !== this.state.receipt(n)?.sha256);
        const why = [...new Set([...changed, ...needBad])];
        if (why.length)
          result.set(p.id, {
            status: "STALE",
            detail: `input(s) changed or not done: ${why.join(", ")}; rerun with --redo --phase ${p.id}`,
            receipt: r,
          });
        else result.set(p.id, { status: r.value.status === "SKIPPED" ? "SKIPPED" : "DONE", receipt: r });
        continue;
      }
      if (needBad.length) {
        result.set(p.id, { status: "BLOCKED", detail: `needs ${needBad.join(", ")}` });
        continue;
      }
      const def = this.#def(p);
      if (!p.builtin && p.effect !== "human" && !def.skip && !(def.steps?.length > 0)) {
        result.set(p.id, { status: "UNDEFINED", detail: `kit ${this.kit.name} defines no steps for this phase` });
        continue;
      }
      if (def.skip) {
        result.set(p.id, { status: "READY", detail: `will be recorded as SKIPPED: ${def.skip}`, skip: true });
        continue;
      }
      let digest;
      try {
        digest = this.inputsDigest(p);
      } catch (e) {
        if (!(e instanceof ShipError)) throw e;
        result.set(p.id, { status: "BLOCKED", detail: e.message.replace(/^REFUSED: /, "") });
        continue;
      }
      if (this.#needsOperator(p)) {
        const a = this.state.attestation(p.id);
        if (!a || a.value.inputsDigest !== digest.digest) {
          result.set(p.id, {
            status: "AWAITING-OPERATOR",
            detail: a
              ? "attestation is stale (inputs or commands changed); attest again"
              : "needs a person; see instructions",
            digest,
          });
          continue;
        }
      }
      if (this.#needsApproval(p)) {
        const a = this.state.approval(p.id);
        if (!a || a.value.inputsDigest !== digest.digest) {
          result.set(p.id, {
            status: "AWAITING-APPROVAL",
            detail: a
              ? "approval is stale (inputs or commands changed); approve again"
              : (p.approvalReason ?? "needs approval"),
            digest,
          });
          continue;
        }
      }
      result.set(p.id, { status: "READY", digest });
    }
    return result;
  }

  // Every artifact recorded by an upstream receipt must still have the recorded bytes.
  verifyUpstreamArtifacts(phase) {
    const seen = new Set();
    const problems = [];
    const visit = (id) => {
      if (seen.has(id)) return;
      seen.add(id);
      const p = phaseById(id, this.phases);
      for (const n of p.needs) visit(n);
      if (id === phase.id) return;
      const r = this.state.receipt(id);
      for (const a of r?.value.artifacts ?? []) {
        if (!existsSync(a.path)) problems.push(`${id}: ${a.path} is gone`);
        else if (sha256File(a.path) !== a.sha256) problems.push(`${id}: ${a.path} changed since its receipt`);
      }
    };
    visit(phase.id);
    if (problems.length) refuse(`artifact drift; redo the owning phase(s) first:\n  ${problems.join("\n  ")}`);
  }

  // ---------------------------------------------------------------- plan / status

  describe(selector = "all") {
    const { phases } = selectPhases(selector, this.phases);
    const evaluation = this.evaluate();
    const vars = this.vars();
    return phases.map((p) => {
      const ev = evaluation.get(p.id);
      const def = this.#def(p);
      const steps = (def.steps ?? []).map((s) => {
        const d = { id: s.id };
        if (s.run) {
          const r = resolveDeep({ run: s.run, cwd: s.cwd ?? "{repo}" }, vars, { lenient: true });
          d.run = r.value.run;
          d.cwd = r.value.cwd;
          if (s.poll) d.poll = s.poll;
          if (s.uses?.length) {
            const problems = verifyScripts(this.kit, this.repo, s.uses);
            d.integrity = problems.length ? problems : "ok";
          }
        }
        if (s.write) d.write = resolveString(s.write.path, vars, { lenient: true }).value;
        if (s.copy) d.copy = s.copy.files.length;
        if (s.check) d.check = s.check;
        if (s.operator) d.operator = s.operator;
        d.outputs = (s.outputs ?? []).map((o) => o.key);
        return d;
      });
      return {
        id: p.id,
        group: p.group,
        effect: p.effect,
        title: p.title,
        status: ev.status,
        detail: ev.detail,
        approval: this.#needsApproval(p) ? (p.approvalReason ?? true) : undefined,
        human: p.effect === "human" || this.#needsOperator(p) ? (def.instructions ?? p.human ?? true) : undefined,
        evidence: p.effect === "human" ? (def.evidence ?? []).map((o) => o.key) : undefined,
        steps,
      };
    });
  }

  printPlan(selector, { json = false } = {}) {
    const rows = this.describe(selector);
    if (json) {
      this.log(
        JSON.stringify(
          {
            identity: this.identity,
            kit: { name: this.kit.name, sha256: this.kitSha256 },
            state: this.state.dir,
            phases: rows,
          },
          null,
          2,
        ),
      );
      return rows;
    }
    const b = this.identity;
    this.log(
      `KalCode release ${b.version} @ ${b.commit.slice(0, 12)}${b.baselineVersion ? ` (baseline ${b.baselineVersion})` : ""} on ${b.channel}`,
    );
    this.log(`kit ${this.kit.name} ${this.kitSha256.slice(0, 12)}  state ${this.state.dir}`);
    this.log("Dry run: nothing is executed without --execute.\n");
    for (const r of rows) {
      this.log(`[${r.status.padEnd(17)}] ${r.id.padEnd(22)} ${r.effect.padEnd(10)} ${r.title}`);
      if (r.detail) this.log(`      ${r.detail}`);
      if (r.status === "AWAITING-APPROVAL") {
        this.log(
          `      a person approves: node tooling/release/ship.mjs approve ${this.#idArgs()} --phase ${r.id} --by "<name>" --confirm ${r.id}:${b.version}:${b.commit.slice(0, 7)}`,
        );
      }
      if (r.status === "AWAITING-OPERATOR") {
        if (typeof r.human === "string") this.log(`      person: ${r.human}`);
        const keys = r.evidence ?? r.steps.filter((s) => s.operator).flatMap((s) => s.outputs);
        this.log(
          `      then:   node tooling/release/ship.mjs attest ${this.#idArgs()} --phase ${r.id} --by "<name>"${keys.map((k) => ` --evidence ${k}=<path>`).join("")}`,
        );
      }
      if (["DONE", "SKIPPED"].includes(r.status)) continue;
      for (const s of r.steps) {
        if (s.run)
          this.log(
            `      $ ${s.run.map(quote).join(" ")}${s.cwd && s.cwd !== this.repo ? `   (cwd ${s.cwd})` : ""}${s.poll ? `   (poll until /${s.poll.doneWhen}/)` : ""}`,
          );
        if (s.integrity && s.integrity !== "ok") this.log(`        integrity: ${s.integrity.join("; ")}`);
        if (s.write) this.log(`      write ${s.write}`);
        if (s.copy) this.log(`      copy ${s.copy} file(s) with hash checks`);
        if (s.check) this.log(`      check: ${s.check}`);
        if (s.operator) this.log(`      operator: ${s.operator}`);
        if (s.outputs.length) this.log(`        -> ${s.outputs.map((k) => `out.${r.id}.${k}`).join(", ")}`);
      }
    }
    return rows;
  }

  #idArgs() {
    const b = this.identity;
    return `--version ${b.version} --commit ${b.commit}${b.baselineVersion ? ` --baseline-version ${b.baselineVersion}` : ""}`;
  }

  // ---------------------------------------------------------------- human gates

  approve(phaseId, { by, confirm }) {
    const p = phaseById(phaseId, this.phases);
    if (!p) refuse(`unknown phase ${phaseId}`);
    if (!this.#needsApproval(p)) refuse(`phase ${phaseId} does not take an approval`);
    if (typeof by !== "string" || !by.trim()) refuse("--by <name of the approving person> is required");
    const want = `${p.id}:${this.identity.version}:${this.identity.commit.slice(0, 7)}`;
    if (confirm !== want) refuse(`--confirm must be exactly ${want}`);
    const ev = this.evaluate().get(p.id);
    if (!["AWAITING-APPROVAL", "READY"].includes(ev.status))
      refuse(`phase ${p.id} is ${ev.status}${ev.detail ? ` (${ev.detail})` : ""}; nothing to approve`);
    this.state.bind(this.identity);
    const { digest, inputs, commands } = this.inputsDigest(p);
    return this.state.writeApproval(p.id, {
      schema: "kalcode-ship-approval/v1",
      phase: p.id,
      effect: p.effect,
      reason: p.approvalReason ?? null,
      by: by.trim(),
      at: this.now().toISOString(),
      inputsDigest: digest,
      inputs,
      commands,
    });
  }

  #evidenceSpecs(p) {
    const def = this.#def(p);
    if (p.effect === "human") return def.evidence ?? [];
    return (def.steps ?? []).filter((s) => s.operator).flatMap((s) => s.outputs ?? []);
  }

  attest(phaseId, { by, evidence = {}, note = null }) {
    const p = phaseById(phaseId, this.phases);
    if (!p) refuse(`unknown phase ${phaseId}`);
    if (!this.#needsOperator(p)) refuse(`phase ${phaseId} has no human or operator part`);
    if (typeof by !== "string" || !by.trim()) refuse("--by <name of the person> is required");
    const ev = this.evaluate().get(p.id);
    if (!["AWAITING-OPERATOR", "AWAITING-APPROVAL", "READY"].includes(ev.status))
      refuse(`phase ${p.id} is ${ev.status}${ev.detail ? ` (${ev.detail})` : ""}; nothing to attest`);
    const specs = this.#evidenceSpecs(p);
    const known = new Set(specs.map((s) => s.key));
    for (const k of Object.keys(evidence))
      if (!known.has(k)) refuse(`unknown evidence key ${k} (expected: ${[...known].join(", ") || "none"})`);
    const vars = this.vars();
    const records = {};
    const values = {};
    for (const spec of specs) {
      const path = evidence[spec.key];
      if (!path) {
        if (spec.optional) continue;
        refuse(`--evidence ${spec.key}=<path> is required`);
      }
      const abs = resolve(this.repo, path);
      values[spec.key] = this.evaluateOutput(spec, { evidencePath: abs, stdout: null }, vars);
      records[spec.key] = fileIdentity(abs);
    }
    this.state.bind(this.identity);
    const { digest } = this.inputsDigest(p);
    return this.state.writeAttestation(p.id, {
      schema: "kalcode-ship-attestation/v1",
      phase: p.id,
      by: by.trim(),
      at: this.now().toISOString(),
      note,
      inputsDigest: digest,
      evidence: records,
      values,
    });
  }

  // ---------------------------------------------------------------- execution

  async run(selector = "all", { execute = false, adopt = false, redo = false, evidence = {} } = {}) {
    if (!execute) {
      this.printPlan(selector);
      return { code: 0 };
    }
    const { phases, explicit } = selectPhases(selector, this.phases);
    if (adopt && phases.length !== 1)
      refuse("--adopt records existing evidence for exactly one explicitly named phase");
    if (redo && phases.some((p) => !explicit.has(p.id))) refuse("--redo applies only to phases named explicitly by id");
    const release = this.state.lock(`ship.mjs ${this.identity.version}`);
    try {
      this.state.bind(this.identity);
      for (const p of phases) {
        let ev = this.evaluate().get(p.id);
        if (redo && this.state.receipt(p.id)) {
          if (p.effect === "prod-write")
            refuse(`phase ${p.id} wrote to production; its tool's own resume path applies, not --redo`);
          const moved = this.state.supersedeReceipt(p.id);
          this.log(`superseded ${p.id} receipt -> ${moved}`);
          ev = this.evaluate().get(p.id);
        }
        if (DONE.has(ev.status)) {
          this.log(`[${ev.status}] ${p.id}`);
          continue;
        }
        if (p.effect === "prod-write" && !explicit.has(p.id)) {
          this.log(`[STOP] ${p.id} writes to production and runs only when named explicitly (--phase ${p.id})`);
          return { code: 2, stoppedAt: p.id };
        }
        if (ev.status !== "READY") {
          this.log(`[${ev.status}] ${p.id}: ${ev.detail ?? ""}`);
          if (ev.status === "AWAITING-APPROVAL" || ev.status === "AWAITING-OPERATOR") this.printPlan(p.id);
          return {
            code: ["AWAITING-APPROVAL", "AWAITING-OPERATOR"].includes(ev.status) ? 2 : 1,
            stoppedAt: p.id,
            status: ev.status,
          };
        }
        if (adopt && p.effect === "human") refuse("human phases are recorded with attest, not --adopt");
        await this.executePhase(p, ev, { adopt, evidence });
      }
      return { code: 0 };
    } finally {
      release();
    }
  }

  async executePhase(p, ev, { adopt = false, evidence = {} } = {}) {
    const def = this.#def(p);
    const startedAt = this.now().toISOString();
    this.log(`[RUN] ${p.id} (${p.effect}) ${p.title}`);
    this.verifyUpstreamArtifacts(p);
    const inputs = Object.fromEntries(p.needs.map((n) => [n, this.state.receipt(n).sha256]));
    const approval = this.state.approval(p.id);
    const attestation = this.state.attestation(p.id);
    const ctx = {
      phase: p,
      this: {},
      outputs: {},
      artifacts: [],
      steps: [],
      adopt,
      evidence,
      approval: approval?.value,
      attestation: attestation?.value,
    };
    const base = {
      schema: RECEIPT_SCHEMA,
      phase: p.id,
      group: p.group,
      effect: p.effect,
      identity: this.identity,
      kit: { name: this.kit.name, sha256: this.kitSha256 },
      inputs,
      startedAt,
    };
    try {
      if (ev.skip) {
        const receipt = { ...base, status: "SKIPPED", reason: def.skip, finishedAt: this.now().toISOString() };
        this.state.writeReceipt(p.id, receipt);
        this.log(`[SKIPPED] ${p.id}: ${def.skip}`);
        return receipt;
      }
      if (p.effect === "human") this.#collectAttested(ctx, def.evidence ?? []);
      if (p.builtin) await BUILTINS[p.builtin](this, ctx);
      for (const step of def.steps ?? []) await this.executeStep(step, ctx);
      const receipt = {
        ...base,
        status: "PASS",
        adopted: adopt || undefined,
        approval: approval
          ? {
              path: approval.path,
              sha256: approval.sha256,
              by: approval.value.by,
              at: approval.value.at,
              inputsDigest: approval.value.inputsDigest,
            }
          : undefined,
        attestation: attestation
          ? { path: attestation.path, sha256: attestation.sha256, by: attestation.value.by, at: attestation.value.at }
          : undefined,
        steps: ctx.steps,
        outputs: ctx.outputs,
        artifacts: ctx.artifacts,
        finishedAt: this.now().toISOString(),
      };
      this.state.writeReceipt(p.id, JSON.parse(JSON.stringify(receipt)));
      this.log(`[DONE] ${p.id}`);
      return receipt;
    } catch (e) {
      const file = this.state.writeFailure(p.id, {
        phase: p.id,
        at: this.now().toISOString(),
        error: e.message,
        steps: ctx.steps,
      });
      this.log(`[FAILED] ${p.id}: ${e.message}\n  failure record: ${file}`);
      throw e;
    }
  }

  #record(ctx, key, value) {
    ctx.outputs[key] = value;
    ctx.this[key] = value;
    if (value && typeof value === "object" && typeof value.path === "string" && typeof value.sha256 === "string") {
      ctx.artifacts.push({ key, path: value.path, sha256: value.sha256, size: value.size });
    }
  }

  #collectAttested(ctx, specs) {
    const a = ctx.attestation;
    if (!a) refuse(`phase ${ctx.phase.id} has no attestation`);
    for (const spec of specs) {
      const rec = a.evidence?.[spec.key];
      if (!rec) {
        if (spec.optional) continue;
        refuse(`attestation lacks evidence ${spec.key}`);
      }
      if (!existsSync(rec.path) || sha256File(rec.path) !== rec.sha256)
        refuse(`attested evidence ${spec.key} (${rec.path}) changed since it was attested`);
      this.#record(ctx, spec.key, a.values[spec.key]);
    }
  }

  async executeStep(step, ctx) {
    const vars = () =>
      this.vars({ this: ctx.this, approval: ctx.approval ? { by: ctx.approval.by, at: ctx.approval.at } : undefined });
    const stepRecord = { id: step.id };
    ctx.steps.push(stepRecord);
    if (step.operator) {
      stepRecord.kind = "operator";
      this.#collectAttested(ctx, step.outputs ?? []);
      return;
    }
    if (step.run) {
      const problems = verifyScripts(this.kit, this.repo, step.uses ?? []);
      if (problems.length) refuse(`step ${step.id}: kit script integrity: ${problems.join("; ")}`);
      const cmd = this.#resolveCommand(step, vars(), false);
      stepRecord.argv = cmd.run;
      stepRecord.cwd = cmd.cwd;
      if (ctx.adopt) {
        stepRecord.kind = "adopted";
        for (const spec of step.outputs ?? []) {
          const given = ctx.evidence[spec.key];
          const value = this.evaluateOutput(
            spec,
            { evidencePath: given ? resolve(this.repo, given) : null, stdout: null },
            vars(),
          );
          if (value !== undefined) this.#record(ctx, spec.key, value);
        }
        return;
      }
      const { stdout, exitCode, logPath } = await this.#runCommand(step, cmd, ctx.phase.id);
      Object.assign(stepRecord, { kind: "run", exitCode, log: { path: logPath, sha256: sha256File(logPath) } });
      if (step.stdoutTo) {
        const to = resolveString(step.stdoutTo, vars()).value;
        mkdirSync(dirname(to), { recursive: true });
        writeCreateOnce(to, stdout);
        this.#record(ctx, `${camel(step.id)}Stdout`, fileIdentityRel(to, this.repo));
      }
      for (const spec of step.outputs ?? []) {
        const value = this.evaluateOutput(spec, { evidencePath: null, stdout }, vars());
        if (value !== undefined) this.#record(ctx, spec.key, value);
      }
      return;
    }
    if (step.write) {
      stepRecord.kind = "write";
      const v = vars();
      const path = resolveString(step.write.path, v).value;
      const json = resolveDeep(step.write.json, v).value;
      mkdirSync(dirname(path), { recursive: true });
      writeCreateOnce(path, stableJson(json));
      this.#record(ctx, camel(step.id), fileIdentityRel(path, this.repo));
      for (const spec of step.outputs ?? []) {
        const value = this.evaluateOutput(spec, { evidencePath: null, stdout: null }, vars());
        if (value !== undefined) this.#record(ctx, spec.key, value);
      }
      return;
    }
    if (step.copy) {
      stepRecord.kind = "copy";
      const v = vars();
      const to = resolveString(step.copy.to, v).value;
      mkdirSync(to, { recursive: true });
      const copied = [];
      for (const f of step.copy.files) {
        const from = resolveString(f.from, v).value;
        const want = resolveString(f.sha256, v).value;
        const name = f.as ? resolveString(f.as, v).value : from.split(/[\\/]/).at(-1);
        if (sha256File(from) !== want) refuse(`copy source ${from} does not have the recorded sha256 ${want}`);
        const dest = join(to, name);
        if (existsSync(dest)) {
          if (sha256File(dest) !== want) refuse(`copy destination ${dest} exists with different bytes`);
        } else {
          copyFileSync(from, dest);
          if (sha256File(dest) !== want) refuse(`copy to ${dest} did not reproduce the source bytes`);
        }
        copied.push(fileIdentityRel(dest, this.repo));
      }
      stepRecord.files = copied;
      for (const c of copied) ctx.artifacts.push({ key: step.id, path: c.path, sha256: c.sha256, size: c.size });
      for (const spec of step.outputs ?? []) {
        const value = this.evaluateOutput(spec, { evidencePath: null, stdout: null }, vars());
        if (value !== undefined) this.#record(ctx, spec.key, value);
      }
      return;
    }
    if (step.check) {
      stepRecord.kind = "check";
      for (const spec of step.outputs) {
        const given = ctx.adopt ? ctx.evidence[spec.key] : null;
        const value = this.evaluateOutput(
          spec,
          { evidencePath: given ? resolve(this.repo, given) : null, stdout: null },
          vars(),
        );
        if (value !== undefined) this.#record(ctx, spec.key, value);
      }
      return;
    }
    refuse(`step ${step.id} has no kind`);
  }

  async #runCommand(step, cmd, phaseId) {
    const logPath = this.state.logPath(phaseId, step.id);
    const env = { ...process.env, ...cmd.env };
    for (const k of step.envUnset ?? []) delete env[k];
    const ok = step.okExitCodes ?? [0];
    const poll = step.poll;
    const deadline = poll ? Date.now() + (poll.timeoutMinutes ?? 60) * 60_000 : 0;
    for (let attempt = 1; ; attempt++) {
      const r = await spawnLogged(cmd.run, {
        cwd: cmd.cwd,
        env,
        logPath,
        echo: this.echo,
        timeoutMs: (step.timeoutMinutes ?? 0) * 60_000,
        header: `# ${this.now().toISOString()} attempt ${attempt}`,
      });
      if (!poll) {
        if (!ok.includes(r.exitCode))
          refuse(`step ${step.id} exited ${r.exitCode} (allowed ${ok.join(",")}); log ${logPath}`);
        return { ...r, logPath };
      }
      if (ok.includes(r.exitCode) && new RegExp(poll.doneWhen, "m").test(r.stdout)) return { ...r, logPath };
      if (Date.now() >= deadline)
        refuse(`step ${step.id}: /${poll.doneWhen}/ not reached before the poll deadline; log ${logPath}`);
      sleep((poll.everySeconds ?? 60) * 1000);
    }
  }

  // Turns one output spec into a recorded value and enforces its expectations. evidencePath (adopt/attest)
  // replaces the spec's own location or stdout.
  evaluateOutput(spec, { evidencePath, stdout }, vars) {
    const at = (p) => (isAbsolute(p) ? p : resolve(this.repo, p));
    const text = () => {
      if (evidencePath) return readFileSync(evidencePath, "utf8");
      if (stdout === null || stdout === undefined)
        refuse(`output ${spec.key}: pass --evidence ${spec.key}=<file> (no command output to read)`);
      return stdout;
    };
    const jsonChecks = (value, doc) => {
      for (const [field, wantRaw] of Object.entries(spec.expect ?? {})) {
        const got = lookup(doc, field);
        const want = typeof wantRaw === "string" ? resolveString(wantRaw, vars).value : wantRaw;
        const okv = Array.isArray(want) ? want.includes(got) : got === want;
        if (!okv) refuse(`output ${spec.key}: ${field} is ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`);
      }
      for (const [name, field] of Object.entries(spec.pick ?? {})) {
        const got = lookup(doc, field);
        if (got === undefined) refuse(`output ${spec.key}: field ${field} is missing`);
        value[name] = got;
      }
      return value;
    };
    const fromFile = (path) => {
      if (!existsSync(path)) {
        if (spec.optional) return undefined;
        refuse(`output ${spec.key}: ${path} does not exist`);
      }
      const value = fileIdentityRel(path, this.repo);
      if (spec.type === "file" && !spec.expect && !spec.pick) return value;
      let doc;
      try {
        doc = JSON.parse(readFileSync(path, "utf8").replace(/^﻿/, ""));
      } catch (e) {
        if (spec.type === "file") return value;
        refuse(`output ${spec.key}: ${path} is not JSON (${e.message})`);
      }
      return jsonChecks(value, doc);
    };
    switch (spec.type) {
      case "dir": {
        const p = at(resolveString(spec.path, vars).value);
        if (!existsSync(p) || !statSync(p).isDirectory()) refuse(`output ${spec.key}: directory ${p} does not exist`);
        return { dir: p, rel: relIn(p, this.repo) };
      }
      case "file":
      case "json":
        return fromFile(evidencePath ?? at(resolveString(spec.path, vars).value));
      case "match": {
        if (evidencePath) return fromFile(evidencePath);
        const dir = at(resolveString(spec.dir, vars).value);
        const re = new RegExp(resolveString(spec.pattern, vars).value);
        const hits = existsSync(dir) ? readdirSync(dir).filter((f) => re.test(f)) : [];
        if (hits.length !== 1)
          refuse(
            `output ${spec.key}: expected exactly one file matching /${re.source}/ in ${dir}, found ${hits.length}`,
          );
        return fromFile(join(dir, hits[0]));
      }
      case "receipt": {
        let path = evidencePath;
        let claimed = null;
        if (!path) {
          const m = new RegExp(spec.pattern ?? RECEIPT_LINE, "m").exec(text());
          if (!m) refuse(`output ${spec.key}: no receipt line in the command output`);
          path = at(m.groups?.path ?? m[1]);
          claimed = m.groups?.sha256 ?? null;
        }
        const value = fromFile(path);
        if (claimed && value && value.sha256 !== claimed)
          refuse(`output ${spec.key}: ${path} is not the receipt the tool reported (${claimed})`);
        return value;
      }
      case "stdout": {
        const m = new RegExp(resolveString(spec.pattern, vars).value, "m").exec(text());
        if (!m) {
          if (spec.optional) return undefined;
          refuse(`output ${spec.key}: /${spec.pattern}/ not found in the command output`);
        }
        const groups = m.groups ? { ...m.groups } : null;
        const value = groups ?? m[1] ?? m[0];
        if (spec.expect && groups) jsonChecks(groups, groups);
        return value;
      }
      case "stdoutJson": {
        const raw = text().trim();
        let doc;
        try {
          doc = JSON.parse(raw);
        } catch {
          const last = raw
            .split(/\r?\n/)
            .filter((l) => l.trim().startsWith("{"))
            .at(-1);
          try {
            doc = JSON.parse(last ?? "");
          } catch {
            refuse(`output ${spec.key}: command output is not JSON`);
          }
        }
        const value = evidencePath ? fileIdentityRel(evidencePath, this.repo) : {};
        return jsonChecks(value, doc);
      }
      default:
        refuse(`output ${spec.key}: unknown type ${spec.type}`);
    }
  }
}

// ---------------------------------------------------------------- builtins

function git(repo, args) {
  const r = spawnSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.status !== 0) refuse(`git ${args.join(" ")} failed: ${(r.stderr || r.stdout).trim()}`);
  return r.stdout;
}

export const VERSION_AUTHORITIES = Object.freeze({
  "apps/desktop/src-tauri/tauri.conf.json": (text) => JSON.parse(text).version,
  "apps/desktop/package.json": (text) => JSON.parse(text).version,
  "Cargo.toml": (text) => /\[workspace\.package\][^[]*?^version\s*=\s*"([^"]+)"/m.exec(text)?.[1],
});

export const BUILTINS = {
  // Reads the exact commit (never the working tree) and proves every version authority declares --version.
  async identity(pipeline, ctx) {
    const { repo, identity } = pipeline;
    const c = identity.commit;
    if (git(repo, ["cat-file", "-t", c]).trim() !== "commit") refuse(`${c} is not a commit in ${repo}`);
    const authorities = {};
    for (const [file, read] of Object.entries(VERSION_AUTHORITIES)) {
      const v = read(git(repo, ["show", `${c}:${file}`]));
      authorities[file] = v ?? null;
      if (v !== identity.version)
        refuse(`${file} at ${c.slice(0, 7)} declares ${JSON.stringify(v ?? null)}, not ${identity.version}`);
    }
    const endpoint = pipeline.kit.identity?.movingEndpoint;
    if (endpoint) {
      const text = git(repo, ["show", `${c}:${endpoint.file}`]);
      if (!text.includes(endpoint.contains))
        refuse(
          `${endpoint.file} at ${c.slice(0, 7)} does not compile the moving ${identity.channel} endpoint (a derived baseline cannot be the candidate)`,
        );
    }
    const out = {
      commit: c,
      tree: git(repo, ["rev-parse", `${c}^{tree}`]).trim(),
      version: identity.version,
      tags: git(repo, ["tag", "--points-at", c]).split(/\r?\n/).filter(Boolean).join(","),
    };
    for (const [k, v] of Object.entries(out)) ctx.outputs[k] = v;
    ctx.steps.push({ id: "identity", kind: "builtin", authorities });
  },

  // Every pin is derived from receipts. pins.json holds the identity plus every upstream output; pins.env
  // holds the kit's NAME=value mapping for token-based kits. Both are new files per run (create-once).
  async pins(pipeline, ctx) {
    const vars = pipeline.vars({ this: ctx.this });
    const pins = {};
    for (const [name, tpl] of Object.entries(pipeline.kit.pins ?? {})) {
      const v = resolveString(tpl, vars).value;
      if (/[\r\n]/.test(v)) refuse(`pin ${name} resolves to a multi-line value`);
      pins[name] = v;
    }
    const dir = freshPath(pipeline.state.path("pins", "pins"), "", pipeline.now());
    mkdirSync(dir, { recursive: true });
    const jsonPath = join(dir, "pins.json");
    const envPath = join(dir, "pins.env");
    writeCreateOnce(
      jsonPath,
      stableJson({ schema: "kalcode-ship-pins/v1", identity: pipeline.identity, pins, outputs: vars.out }),
    );
    writeCreateOnce(
      envPath,
      Object.keys(pins)
        .sort()
        .map((k) => `${k}=${pins[k]}\n`)
        .join(""),
    );
    const jsonId = fileIdentityRel(jsonPath, pipeline.repo);
    const envId = fileIdentityRel(envPath, pipeline.repo);
    ctx.outputs.pinsJson = jsonId;
    ctx.outputs.pinsEnv = envId;
    ctx.this.pinsJson = jsonId;
    ctx.this.pinsEnv = envId;
    ctx.artifacts.push({ key: "pinsJson", ...jsonId }, { key: "pinsEnv", ...envId });
    ctx.steps.push({ id: "pins", kind: "builtin", count: Object.keys(pins).length });
  },
};

// ---------------------------------------------------------------- helpers

function camel(id) {
  return id.replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase());
}

function relIn(path, repo) {
  const rel = relative(repo, path);
  return rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel : null;
}

function fileIdentityRel(path, repo) {
  const id = fileIdentity(path);
  const rel = relIn(path, repo);
  return rel ? { ...id, rel } : id;
}

function quote(a) {
  return /^[A-Za-z0-9_./:=@\\-]+$/.test(a) ? a : JSON.stringify(a);
}

function killTree(child) {
  if (process.platform === "win32")
    spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
  else child.kill("SIGKILL");
}

export function spawnLogged(argv, { cwd, env, logPath, echo = false, timeoutMs = 0, header = "" }) {
  return new Promise((resolvePromise, reject) => {
    mkdirSync(dirname(logPath), { recursive: true });
    const log = createWriteStream(logPath, { flags: "a" });
    log.write(`${header}\n$ ${argv.map(quote).join(" ")}\n(cwd ${cwd})\n`);
    const exe = argv[0] === "node" ? process.execPath : argv[0];
    let child;
    try {
      child = spawn(exe, argv.slice(1), { cwd, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      log.end(() => reject(new ShipError(`REFUSED: cannot start ${argv[0]}: ${e.message}`)));
      return;
    }
    let stdout = "";
    let timer = null;
    let timedOut = false;
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        killTree(child);
      }, timeoutMs);
    }
    child.stdout.on("data", (d) => {
      log.write(d);
      if (stdout.length < MAX_CAPTURE) stdout += d.toString("utf8");
      if (echo) process.stdout.write(d);
    });
    child.stderr.on("data", (d) => {
      log.write(d);
      if (echo) process.stderr.write(d);
    });
    child.on("error", (e) => {
      if (timer) clearTimeout(timer);
      log.end(() => reject(new ShipError(`REFUSED: cannot start ${argv[0]}: ${e.message}`)));
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      log.write(`\n# exit ${code}${timedOut ? " (timed out)" : ""}\n`);
      log.end(() => {
        if (timedOut) reject(new ShipError(`REFUSED: ${argv[0]} timed out; log ${logPath}`));
        else resolvePromise({ exitCode: code, stdout });
      });
    });
  });
}
