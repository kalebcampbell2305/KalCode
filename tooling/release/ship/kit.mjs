// A release kit is the JSON binding between the canonical phases (phases.mjs) and the proven, reviewed
// scripts that do the work for a release line (signing, certification, staging validators, publish wrappers).
// The orchestrator never re-implements those scripts; it resolves their parameters from the release
// identity and earlier receipts, verifies their bytes against the kit's sha256 pins, runs them and gates on
// their outputs.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

import { identityVars, references, refuse } from "./context.mjs";
import { PHASES, phaseById } from "./phases.mjs";
import { sha256Bytes, sha256File } from "./state.mjs";

export const KIT_SCHEMA = "kalcode-release-kit/v1";
export const OUTPUT_TYPES = Object.freeze(["dir", "file", "json", "match", "receipt", "stdout", "stdoutJson"]);
const STEP_KINDS = Object.freeze(["run", "write", "copy", "check", "operator"]);
const STEP_FIELDS = Object.freeze({
  run: [
    "id",
    "run",
    "cwd",
    "env",
    "envUnset",
    "okExitCodes",
    "uses",
    "outputs",
    "poll",
    "timeoutMinutes",
    "stdoutTo",
    "note",
  ],
  write: ["id", "write", "outputs", "note"],
  copy: ["id", "copy", "outputs", "note"],
  check: ["id", "check", "outputs", "note"],
  operator: ["id", "operator", "outputs", "note"],
});
const OUTPUT_FIELDS = ["key", "type", "path", "dir", "pattern", "expect", "pick", "optional", "note"];
const RESERVED_OUTPUT_FIELDS = new Set(["path", "rel", "sha256", "size"]);
const SHA256 = /^[0-9a-f]{64}$/;

export const KITS_DIR = fileURLToPath(new URL("./kits/", import.meta.url));

export function loadKit(path, phases = PHASES) {
  if (!existsSync(path)) refuse(`kit manifest not found: ${path}`);
  const bytes = readFileSync(path);
  let kit;
  try {
    kit = JSON.parse(bytes.toString("utf8"));
  } catch (e) {
    refuse(`kit manifest ${path} is not JSON: ${e.message}`);
  }
  validateKit(kit, phases);
  return { kit, path, sha256: sha256Bytes(bytes) };
}

// Picks the one kit whose binds match the identity when --kit is not given.
export function findKit(identity, folder = KITS_DIR) {
  const matches = [];
  const names = existsSync(folder) ? readdirSync(folder).filter((f) => f.endsWith(".json")) : [];
  for (const name of names) {
    const file = join(folder, name);
    const { kit } = loadKit(file);
    if (bindsProblems(kit, identity).length === 0) matches.push(file);
  }
  if (matches.length !== 1) {
    refuse(
      `${matches.length === 0 ? "no" : "more than one"} kit in ${folder} binds version ${identity.version} commit ${identity.commit.slice(0, 7)}` +
        ` (${names.join(", ") || "none"}); pass --kit <manifest>. A new release line needs its own kit (docs/RELEASE-PIPELINE.md).`,
    );
  }
  return matches[0];
}

export function bindsProblems(kit, identity) {
  const problems = [];
  for (const [key, want] of Object.entries(kit.binds ?? {})) {
    if (identity[key] !== want)
      problems.push(`${key} is ${JSON.stringify(identity[key])}, kit ${kit.name} is pinned to ${JSON.stringify(want)}`);
  }
  return problems;
}

export function assertBinds(kit, identity) {
  const problems = bindsProblems(kit, identity);
  if (problems.length) refuse(`kit ${kit.name} cannot run this release: ${problems.join("; ")}`);
}

function exactFields(obj, allowed, label) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) refuse(`${label} must be an object`);
  const extra = Object.keys(obj).filter((k) => !allowed.includes(k));
  if (extra.length) refuse(`${label} has unknown field(s) ${extra.join(", ")}`);
}

function validateOutputs(outputs, label, keys, { evidence = false } = {}) {
  if (outputs === undefined) return;
  if (!Array.isArray(outputs)) refuse(`${label}.outputs must be an array`);
  for (const [i, o] of outputs.entries()) {
    const l = `${label}.outputs[${i}]`;
    exactFields(o, OUTPUT_FIELDS, l);
    if (typeof o.key !== "string" || !/^[A-Za-z][A-Za-z0-9]*$/.test(o.key))
      refuse(`${l}.key must be camelCase letters/digits`);
    if (keys.has(o.key)) refuse(`${l}.key ${o.key} is used twice in one phase`);
    keys.add(o.key);
    if (!OUTPUT_TYPES.includes(o.type)) refuse(`${l}.type must be one of ${OUTPUT_TYPES.join(", ")}`);
    if (evidence && o.path !== undefined) refuse(`${l}: evidence paths come from the attestation, not the kit`);
    if (!evidence && ["dir", "file", "json"].includes(o.type) && typeof o.path !== "string")
      refuse(`${l} (${o.type}) needs path`);
    if (o.type === "match" && (typeof o.dir !== "string" || typeof o.pattern !== "string"))
      refuse(`${l} (match) needs dir and pattern`);
    if (o.type === "stdout" && typeof o.pattern !== "string") refuse(`${l} (stdout) needs pattern`);
    if (o.pick) {
      exactFields(o.pick, Object.keys(o.pick), `${l}.pick`);
      for (const name of Object.keys(o.pick))
        if (RESERVED_OUTPUT_FIELDS.has(name)) refuse(`${l}.pick.${name} shadows a reserved field`);
    }
    if (o.expect && (typeof o.expect !== "object" || Array.isArray(o.expect))) refuse(`${l}.expect must be an object`);
  }
}

export function validateKit(kit, phases = PHASES) {
  exactFields(
    kit,
    ["schema", "name", "description", "binds", "vars", "scripts", "identity", "pins", "phases", "notes"],
    "kit",
  );
  if (kit.schema !== KIT_SCHEMA) refuse(`kit schema must be ${KIT_SCHEMA}`);
  if (typeof kit.name !== "string" || !/^[a-z0-9][a-z0-9.-]*$/.test(kit.name))
    refuse("kit.name must be a lowercase slug");
  if (kit.binds) exactFields(kit.binds, ["version", "commit", "baselineVersion"], "kit.binds");
  const reservedVars = new Set([
    ...Object.keys(identityVars({ version: "0.0.0", commit: "0".repeat(40), channel: "stable" })),
    "baselineVersion",
    "repo",
    "state",
    "out",
    "attest",
    "approval",
    "this",
  ]);
  for (const [k, v] of Object.entries(kit.vars ?? {})) {
    if (reservedVars.has(k)) refuse(`kit.vars.${k} would shadow a built-in variable`);
    if (typeof v !== "string") refuse(`kit.vars.${k} must be a string`);
  }
  for (const [rel, sha] of Object.entries(kit.scripts ?? {})) {
    if (!SHA256.test(sha)) refuse(`kit.scripts["${rel}"] must be a sha256`);
  }
  for (const [name, tpl] of Object.entries(kit.pins ?? {})) {
    if (!/^[A-Z0-9_]+$/.test(name)) refuse(`kit.pins name ${name} must be UPPER_SNAKE`);
    if (typeof tpl !== "string") refuse(`kit.pins.${name} must be a template string`);
  }
  for (const [id, def] of Object.entries(kit.phases ?? {})) {
    const p = phaseById(id, phases);
    if (!p) refuse(`kit.phases.${id} is not a canonical phase`);
    exactFields(def, ["skip", "steps", "instructions", "evidence"], `kit.phases.${id}`);
    if (def.skip !== undefined) {
      if (!p.skippable) refuse(`phase ${id} may not be skipped`);
      if (typeof def.skip !== "string" || !def.skip.trim()) refuse(`kit.phases.${id}.skip must state the reason`);
      if (def.steps) refuse(`kit.phases.${id} cannot both skip and define steps`);
    }
    const keys = new Set();
    if (p.effect === "human") {
      if (def.steps) refuse(`human phase ${id} has no steps; describe it with instructions/evidence`);
      validateOutputs(def.evidence, `kit.phases.${id}.evidence`, keys, { evidence: true });
      for (const o of def.evidence ?? [])
        if (o.type === "match" || o.type === "dir") refuse(`kit.phases.${id}.evidence ${o.key}: evidence is a file`);
      continue;
    }
    if (def.evidence) refuse(`kit.phases.${id}.evidence: only human phases take phase evidence; use an operator step`);
    if (def.steps === undefined) continue;
    if (!Array.isArray(def.steps)) refuse(`kit.phases.${id}.steps must be an array`);
    const ids = new Set();
    for (const [i, step] of def.steps.entries()) {
      const l = `kit.phases.${id}.steps[${i}]`;
      const kinds = STEP_KINDS.filter((k) => step && Object.hasOwn(step, k));
      if (kinds.length !== 1) refuse(`${l} must have exactly one of ${STEP_KINDS.join(", ")}`);
      const kind = kinds[0];
      exactFields(step, STEP_FIELDS[kind], l);
      if (typeof step.id !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(step.id) || ids.has(step.id))
        refuse(`${l}.id must be a unique lowercase slug`);
      ids.add(step.id);
      if (kind === "run") {
        if (!Array.isArray(step.run) || step.run.length === 0 || step.run.some((a) => typeof a !== "string"))
          refuse(`${l}.run must be a non-empty argv array of strings`);
        for (const u of step.uses ?? [])
          if (!Object.hasOwn(kit.scripts ?? {}, u)) refuse(`${l}.uses ${u} has no sha256 pin in kit.scripts`);
        if (
          step.okExitCodes &&
          (!Array.isArray(step.okExitCodes) || step.okExitCodes.some((c) => !Number.isInteger(c)))
        )
          refuse(`${l}.okExitCodes must be integers`);
        if (step.poll) exactFields(step.poll, ["everySeconds", "timeoutMinutes", "doneWhen"], `${l}.poll`);
        if (step.poll && typeof step.poll.doneWhen !== "string") refuse(`${l}.poll.doneWhen must be a regex string`);
        const refs = references([step.run, step.cwd, step.env]);
        if (refs.some((r) => r.startsWith("approval.")))
          refuse(`${l} may not reference the approval (only write steps may)`);
        if (refs.some((r) => r === `attest.${id}` || r.startsWith(`attest.${id}.`)))
          refuse(`${l} may not reference its own phase's attestation`);
        if (p.effect === "prod-write" && !(step.uses?.length > 0))
          refuse(`${l}: a production-write step must pin the script it runs (uses)`);
      }
      if (kind === "write") {
        exactFields(step.write, ["path", "json"], `${l}.write`);
        if (typeof step.write.path !== "string" || !step.write.json || typeof step.write.json !== "object")
          refuse(`${l}.write needs path and json`);
      }
      if (kind === "copy") {
        exactFields(step.copy, ["files", "to"], `${l}.copy`);
        if (!Array.isArray(step.copy.files) || typeof step.copy.to !== "string")
          refuse(`${l}.copy needs files[] and to`);
        for (const f of step.copy.files) exactFields(f, ["from", "sha256", "as"], `${l}.copy.files[]`);
      }
      if (kind === "check") {
        if (typeof step.check !== "string" || !(step.outputs?.length > 0))
          refuse(`${l}.check must describe what is checked and name outputs`);
        if (step.outputs.some((o) => ["receipt", "stdout", "stdoutJson"].includes(o.type)))
          refuse(`${l}: a check step reads files, not command output`);
      }
      if (kind === "operator") {
        if (typeof step.operator !== "string" || !step.operator.trim())
          refuse(`${l}.operator must be the instructions for the person`);
        if (p.effect === "prod-write") refuse(`${l}: a production write cannot be an operator step; script it`);
        for (const o of step.outputs ?? [])
          if (o.type === "match" || o.type === "dir") refuse(`${l} ${o.key}: operator evidence is a file`);
      }
      validateOutputs(step.outputs, l, keys, { evidence: kind === "operator" });
    }
  }
  return true;
}

export function kitCoverage(kit, phases = PHASES) {
  return phases
    .filter((p) => !p.builtin && p.effect !== "human")
    .filter((p) => {
      const def = kit.phases?.[p.id];
      return !def || (!def.skip && !(def.steps?.length > 0));
    })
    .map((p) => p.id);
}

export function verifyScripts(kit, repo, rels) {
  const problems = [];
  for (const rel of rels) {
    const want = kit.scripts?.[rel];
    const abs = join(repo, rel);
    if (!want) problems.push(`${rel}: not pinned`);
    else if (!existsSync(abs)) problems.push(`${rel}: missing`);
    else {
      const got = sha256File(abs);
      if (got !== want) problems.push(`${rel}: sha256 ${got.slice(0, 12)}… != pinned ${want.slice(0, 12)}…`);
    }
  }
  return problems;
}

export function kitLabel(loaded) {
  return `${loaded.kit.name} (${basename(loaded.path)} ${loaded.sha256.slice(0, 12)})`;
}
