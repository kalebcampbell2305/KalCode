// Resumable, append-only release state for ship.mjs. One directory per (version, commit):
//
//   release.json                 the identity, written once; every later invocation must match it
//   receipts/<phase>.json        one create-once PASS/SKIPPED receipt per phase
//   receipts/superseded/         receipts moved aside by --redo (never deleted)
//   approvals/<phase>.json       human approval bound to the phase's inputs digest
//   attestations/<phase>.json    human/operator attestation (evidence hashes) bound to the inputs digest
//   failures/<phase>-<UTC>.json  why a run stopped (never read as evidence)
//   logs/<phase>-<step>-<UTC>.log full command output
//   lock                         exclusive while a run is in progress
import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { canonicalJson, refuse } from "./context.mjs";

export const RECEIPT_SCHEMA = "kalcode-ship-receipt/v1";
export const RELEASE_SCHEMA = "kalcode-ship-release/v1";

export function sha256Bytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function sha256File(path) {
  return sha256Bytes(readFileSync(path));
}

export function utcStamp(date = new Date()) {
  return date
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");
}

// A new, not-yet-existing path "<base>-<UTC>[-n]<ext>" (two events in the same second get -2, -3, ...).
export function freshPath(base, ext, date = new Date()) {
  const stamp = utcStamp(date);
  for (let n = 1; ; n++) {
    const candidate = `${base}-${stamp}${n === 1 ? "" : `-${n}`}${ext}`;
    if (!existsSync(candidate)) return candidate;
  }
}

export function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

// Create-once write. An existing file with identical bytes is accepted (idempotent resume); different bytes refuse.
export function writeCreateOnce(path, text) {
  if (existsSync(path)) {
    if (readFileSync(path, "utf8") === text) return false;
    refuse(`${path} already exists with different content (create-once)`);
  }
  const fd = openSync(path, "wx");
  try {
    writeFileSync(fd, text, "utf8");
  } finally {
    closeSync(fd);
  }
  return true;
}

export class ReleaseState {
  constructor(dir, { now = () => new Date() } = {}) {
    this.dir = dir;
    this.now = now;
  }

  path(...parts) {
    return join(this.dir, ...parts);
  }

  ensure() {
    for (const d of [
      "receipts",
      "receipts/superseded",
      "approvals",
      "approvals/superseded",
      "attestations",
      "attestations/superseded",
      "failures",
      "logs",
    ]) {
      mkdirSync(this.path(d), { recursive: true });
    }
  }

  // Binds the directory to one release identity for its whole life.
  bind(identity) {
    this.ensure();
    const file = this.path("release.json");
    const want = { schema: RELEASE_SCHEMA, ...identity };
    if (existsSync(file)) {
      const have = JSON.parse(readFileSync(file, "utf8"));
      const { createdAt: _c, ...haveIdentity } = have;
      if (canonicalJson(haveIdentity) !== canonicalJson(want)) {
        refuse(
          `state ${this.dir} belongs to ${canonicalJson(haveIdentity)}, not ${canonicalJson(want)}; use a new --state directory`,
        );
      }
      return have;
    }
    const record = { ...want, createdAt: this.now().toISOString() };
    writeCreateOnce(file, stableJson(record));
    return record;
  }

  isBound() {
    return existsSync(this.path("release.json"));
  }

  #read(kind, phase) {
    const file = this.path(kind, `${phase}.json`);
    if (!existsSync(file)) return null;
    const bytes = readFileSync(file);
    return { path: file, sha256: sha256Bytes(bytes), value: JSON.parse(bytes.toString("utf8")) };
  }

  receipt(phase) {
    return this.#read("receipts", phase);
  }

  approval(phase) {
    return this.#read("approvals", phase);
  }

  attestation(phase) {
    return this.#read("attestations", phase);
  }

  writeReceipt(phase, value) {
    if (value?.schema !== RECEIPT_SCHEMA) refuse("receipt schema mismatch");
    const file = this.path("receipts", `${phase}.json`);
    if (existsSync(file))
      refuse(`receipt for ${phase} already exists (receipts are create-once; use --redo to supersede)`);
    writeCreateOnce(file, stableJson(value));
    return this.receipt(phase);
  }

  #supersede(kind, phase) {
    const file = this.path(kind, `${phase}.json`);
    if (!existsSync(file)) return null;
    const to = freshPath(this.path(kind, "superseded", phase), ".json", this.now());
    renameSync(file, to);
    return to;
  }

  supersedeReceipt(phase) {
    return this.#supersede("receipts", phase);
  }

  // Approvals and attestations are replaced (old one kept under superseded/) because a new one is only ever
  // needed when the inputs changed.
  writeApproval(phase, value) {
    this.#supersede("approvals", phase);
    writeCreateOnce(this.path("approvals", `${phase}.json`), stableJson(value));
    return this.approval(phase);
  }

  writeAttestation(phase, value) {
    this.#supersede("attestations", phase);
    writeCreateOnce(this.path("attestations", `${phase}.json`), stableJson(value));
    return this.attestation(phase);
  }

  writeFailure(phase, value) {
    const file = freshPath(this.path("failures", phase), ".json", this.now());
    writeCreateOnce(file, stableJson(value));
    return file;
  }

  logPath(phase, step) {
    return freshPath(this.path("logs", `${phase}-${step}`), ".log", this.now());
  }

  lock(owner) {
    this.ensure();
    const file = this.path("lock");
    let fd;
    try {
      fd = openSync(file, "wx");
    } catch (e) {
      if (e.code === "EEXIST") {
        const held = readFileSync(file, "utf8").trim();
        refuse(
          `another ship.mjs run holds ${file} (${held}); if that process is gone, inspect its log and delete the lock by hand`,
        );
      }
      throw e;
    }
    writeFileSync(fd, `${owner} pid=${process.pid} at=${this.now().toISOString()}\n`);
    closeSync(fd);
    let released = false;
    return () => {
      if (!released && existsSync(file)) unlinkSync(file);
      released = true;
    };
  }
}

export function fileIdentity(path) {
  if (!existsSync(path)) refuse(`missing file ${path}`);
  const st = statSync(path);
  if (!st.isFile()) refuse(`${path} is not a file`);
  return { path, sha256: sha256File(path), size: st.size };
}
