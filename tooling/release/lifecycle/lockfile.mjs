// pnpm-lock.yaml (lockfileVersion 9) impact analysis without a YAML dependency. The lockfile is a regular,
// indentation-structured file; anything this reader does not understand makes the caller fall back to the
// conservative lanes, so a parse gap can only over-report, never under-report.

export class LockfileError extends Error {
  constructor(message) {
    super(message);
    this.name = "LockfileError";
  }
}

const unquote = (s) =>
  s
    .trim()
    .replace(/^'(.*)'$/, "$1")
    .replace(/^"(.*)"$/, "$1");
const indentOf = (line) => line.length - line.trimStart().length;

/** Splits the lockfile into top-level sections: { name: text }. */
function sections(text) {
  const out = {};
  let name = null;
  let buf = [];
  for (const line of text.replace(/\r\n/g, "\n").split("\n")) {
    if (line && !line.startsWith(" ") && !line.startsWith("#")) {
      if (name) out[name] = buf.join("\n");
      const m = /^([A-Za-z][\w-]*):(.*)$/.exec(line);
      if (!m) throw new LockfileError(`unexpected top-level line: ${line.slice(0, 60)}`);
      name = m[1];
      buf = [m[2].trim()];
    } else buf.push(line);
  }
  if (name) out[name] = buf.join("\n");
  return out;
}

/** Entries of a two-space-indented map section: { key: bodyText }. */
function entries(sectionText) {
  const out = {};
  let key = null;
  let buf = [];
  for (const line of (sectionText ?? "").split("\n").slice(1)) {
    if (!line.trim()) continue;
    const indent = indentOf(line);
    if (indent === 2) {
      if (key !== null) out[key] = buf.join("\n");
      const t = line.trim();
      const colon = t.endsWith(": {}") ? t.length - 4 : t.lastIndexOf(":");
      if (colon <= 0) throw new LockfileError(`unexpected entry line: ${t.slice(0, 60)}`);
      key = unquote(t.slice(0, colon));
      buf = [t.slice(colon)];
    } else if (indent > 2 && key !== null) buf.push(line);
    else throw new LockfileError(`unexpected indentation: ${line.slice(0, 60)}`);
  }
  if (key !== null) out[key] = buf.join("\n");
  return out;
}

/** `name: version` pairs under the dependency groups of a snapshot body. */
function snapshotDeps(body) {
  const deps = [];
  let inGroup = false;
  for (const line of body.split("\n")) {
    if (!line.trim()) continue;
    const indent = indentOf(line);
    if (indent === 4) inGroup = /^(dependencies|optionalDependencies):/.test(line.trim());
    else if (indent === 6 && inGroup) {
      const t = line.trim();
      const colon = t.startsWith("'") ? t.indexOf("':") + 1 : t.indexOf(":");
      deps.push(`${unquote(t.slice(0, colon))}@${unquote(t.slice(colon + 1))}`);
    }
  }
  return deps;
}

/** Importer body -> [{ name, version }] across every dependency group. */
function importerDeps(body) {
  const deps = [];
  let name = null;
  for (const line of body.split("\n")) {
    if (!line.trim()) continue;
    const indent = indentOf(line);
    const t = line.trim();
    if (indent === 6) name = unquote(t.slice(0, t.lastIndexOf(":")));
    else if (indent === 8 && name && t.startsWith("version:")) deps.push({ name, version: unquote(t.slice(8)) });
  }
  return deps;
}

const packageKeyOf = (snapshotKey) => snapshotKey.replace(/\(.*$/, "");

export function parsePnpmLock(text) {
  const s = sections(text);
  if (!/^'?9\./.test(s.lockfileVersion ?? "")) throw new LockfileError("only lockfileVersion 9 is understood");
  if (s.importers === undefined) throw new LockfileError("no importers section");
  const importers = {};
  for (const [path, body] of Object.entries(entries(s.importers))) importers[path] = { body, deps: importerDeps(body) };
  const packages = entries(s.packages);
  const snapshots = {};
  for (const [key, body] of Object.entries(entries(s.snapshots)))
    snapshots[key] = { body, deps: snapshotDeps(body), text: `${body}\n--\n${packages[packageKeyOf(key)] ?? ""}` };
  const other = {};
  for (const [name, body] of Object.entries(s))
    if (!["importers", "packages", "snapshots"].includes(name)) other[name] = body;
  return { importers, snapshots, packages, other };
}

/** Snapshot keys reachable from one importer's direct dependencies (workspace links excluded). */
function reachable(lock, importer) {
  const seen = new Set();
  const stack = lock.importers[importer].deps
    .filter((d) => !d.version.startsWith("link:"))
    .map((d) => `${d.name}@${d.version}`);
  while (stack.length) {
    const key = stack.pop();
    if (seen.has(key)) continue;
    seen.add(key);
    for (const dep of lock.snapshots[key]?.deps ?? []) if (!seen.has(dep)) stack.push(dep);
  }
  return seen;
}

/**
 * Importers (workspace paths such as `apps/website`) whose resolved dependency graph differs between two
 * lockfile texts. Throws LockfileError when the change cannot be attributed (settings, overrides, format).
 */
export function changedImporters(baseText, headText) {
  const base = baseText ? parsePnpmLock(baseText) : null;
  const head = headText ? parsePnpmLock(headText) : null;
  if (!base || !head) throw new LockfileError("lockfile added or deleted");
  for (const name of new Set([...Object.keys(base.other), ...Object.keys(head.other)])) {
    if (name === "patchedDependencies") continue;
    if (base.other[name] !== head.other[name]) throw new LockfileError(`top-level ${name} changed`);
  }
  const changedKeys = new Set();
  for (const key of new Set([...Object.keys(base.snapshots), ...Object.keys(head.snapshots)]))
    if (base.snapshots[key]?.text !== head.snapshots[key]?.text) changedKeys.add(key);
  if (base.other.patchedDependencies !== head.other.patchedDependencies) {
    const patched = `${base.other.patchedDependencies ?? ""}\n${head.other.patchedDependencies ?? ""}`;
    for (const m of patched.matchAll(/^ {2}'?([^'\s][^']*?)'?:\s*$/gm))
      for (const key of Object.keys(head.snapshots)) if (packageKeyOf(key) === m[1]) changedKeys.add(key);
  }
  const affected = new Set();
  for (const imp of new Set([...Object.keys(base.importers), ...Object.keys(head.importers)])) {
    if (base.importers[imp]?.body !== head.importers[imp]?.body) {
      affected.add(imp);
      continue;
    }
    for (const lock of [base, head]) {
      for (const key of reachable(lock, imp))
        if (changedKeys.has(key)) {
          affected.add(imp);
          break;
        }
      if (affected.has(imp)) break;
    }
  }
  // A workspace package's dependency change reaches every importer that links it.
  const links = (lock, imp) =>
    lock.importers[imp]?.deps
      .filter((d) => d.version.startsWith("link:"))
      .map((d) => joinPosix(imp, d.version.slice(5))) ?? [];
  let grew = true;
  while (grew) {
    grew = false;
    for (const lock of [base, head])
      for (const imp of Object.keys(lock.importers))
        if (!affected.has(imp) && links(lock, imp).some((l) => affected.has(l))) {
          affected.add(imp);
          grew = true;
        }
  }
  return [...affected].sort();
}

export function joinPosix(from, rel) {
  const parts = from === "." ? [] : from.split("/");
  for (const seg of rel.split("/")) {
    if (seg === "..") parts.pop();
    else if (seg && seg !== ".") parts.push(seg);
  }
  return parts.join("/") || ".";
}
