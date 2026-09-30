// The machine-readable Definition of Done (policy.json): path globs -> lanes/targets, lanes -> the ordered
// lifecycle. Pure functions only; git and network access live in the modules that call these.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const POLICY_PATH = join(dirname(fileURLToPath(import.meta.url)), "policy.json");
export const LANE_ORDER = ["desktop", "website", "docs", "internal"];
const RESOLVERS = new Set(["workspace-package", "pnpm-lock"]);

export class PolicyError extends Error {
  constructor(message) {
    super(message);
    this.name = "PolicyError";
  }
}

/** Glob -> anchored RegExp. `**` spans directories (`**\/` may be empty), `*` and `?` stay in one segment. */
export function globToRegExp(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        if (glob[i + 2] === "/") {
          re += "(?:.*/)?";
          i += 2;
        } else {
          re += ".*";
          i += 1;
        }
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else if (c === "{") {
      const end = glob.indexOf("}", i);
      if (end < 0) throw new PolicyError(`unbalanced { in glob ${glob}`);
      re += `(?:${glob
        .slice(i + 1, end)
        .split(",")
        .map((s) => s.replace(/[.+^$()|[\]\\]/g, "\\$&"))
        .join("|")})`;
      i = end;
    } else re += c.replace(/[.+^$()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

const globCache = new Map();
export function matchGlob(glob, path) {
  let re = globCache.get(glob);
  if (!re) {
    re = globToRegExp(glob);
    globCache.set(glob, re);
  }
  return re.test(path);
}

export const matchAny = (globs, path) => globs.some((g) => matchGlob(g, path));

export function validatePolicy(p) {
  const problems = [];
  if (p?.schema !== "kalcode-lifecycle-policy/v1") problems.push("schema must be kalcode-lifecycle-policy/v1");
  const lanes = Object.keys(p?.lanes ?? {});
  if (JSON.stringify([...lanes].sort()) !== JSON.stringify([...LANE_ORDER].sort()))
    problems.push(`lanes must be exactly ${LANE_ORDER.join(", ")}`);
  const targets = p?.targets ?? {};
  for (const [t, v] of Object.entries(targets)) if (!lanes.includes(v.lane)) problems.push(`target ${t}: bad lane`);
  const checkSet = (label, ls, ts) => {
    for (const l of ls ?? []) if (!lanes.includes(l)) problems.push(`${label}: unknown lane ${l}`);
    for (const t of ts ?? []) if (!(t in targets)) problems.push(`${label}: unknown target ${t}`);
    for (const t of ts ?? [])
      if (!(ls ?? []).includes(targets[t]?.lane)) problems.push(`${label}: target ${t} needs its lane`);
  };
  for (const r of p?.rules ?? []) {
    if (!Array.isArray(r.globs) || r.globs.length === 0) problems.push(`rule ${r.id}: globs required`);
    else for (const g of r.globs) globToRegExp(g);
    if (r.resolve) {
      if (!RESOLVERS.has(r.resolve)) problems.push(`rule ${r.id}: unknown resolver ${r.resolve}`);
    } else if (!Array.isArray(r.lanes) || r.lanes.length === 0) problems.push(`rule ${r.id}: lanes required`);
    else checkSet(`rule ${r.id}`, r.lanes, r.targets);
  }
  checkSet("fallback", p?.fallback?.lanes, p?.fallback?.targets);
  if (p?.fallback?.lanes?.includes("internal")) problems.push("fallback must never be internal");
  for (const [imp, v] of Object.entries(p?.importers ?? {})) checkSet(`importer ${imp}`, v.lanes, v.targets);
  const stages = p?.stages ?? [];
  for (const [id, s] of Object.entries(p?.steps ?? {})) {
    if (!stages.includes(s.stage)) problems.push(`step ${id}: unknown stage ${s.stage}`);
    checkSet(`step ${id}`, s.lanes, []);
    for (const t of s.targets ?? []) if (!(t in targets)) problems.push(`step ${id}: unknown target ${t}`);
  }
  for (const g of p?.gates ?? []) {
    if (!/^[a-z0-9-]+$/.test(g.id ?? "")) problems.push(`gate ${g.id}: bad id`);
    if (!Array.isArray(g.run) || g.run.length === 0) problems.push(`gate ${g.id}: run required`);
  }
  if (new Set((p?.gates ?? []).map((g) => g.id)).size !== (p?.gates ?? []).length) problems.push("duplicate gate ids");
  return problems;
}

let loaded = null;
export function loadPolicy(path = POLICY_PATH) {
  if (path === POLICY_PATH && loaded) return loaded;
  const p = JSON.parse(readFileSync(path, "utf8"));
  const problems = validatePolicy(p);
  if (problems.length) throw new PolicyError(`invalid lifecycle policy ${path}:\n  ${problems.join("\n  ")}`);
  if (path === POLICY_PATH) loaded = p;
  return p;
}

export const sortLanes = (lanes) => [...new Set(lanes)].sort((a, b) => LANE_ORDER.indexOf(a) - LANE_ORDER.indexOf(b));
export const sortTargets = (policy, targets) => {
  const order = Object.keys(policy.targets);
  return [...new Set(targets)].sort((a, b) => order.indexOf(a) - order.indexOf(b));
};

/** First matching rule for one path, or null (the caller then applies the fallback). */
export function ruleFor(policy, path) {
  return policy.rules.find((r) => matchAny(r.globs, path)) ?? null;
}

/**
 * The ordered lifecycle for a set of lanes/targets. `paths` (the changed paths) enables path-conditional
 * steps such as D1 migrations. Deterministic: stage order, then lane order, then declaration order.
 */
export function pipelineFor(policy, { lanes, targets = [], paths = [] }) {
  const laneSet = new Set(lanes);
  const targetSet = new Set(targets);
  const steps = [];
  const ids = Object.keys(policy.steps);
  for (const [id, s] of Object.entries(policy.steps)) {
    if (s.lanes && !s.lanes.some((l) => laneSet.has(l))) continue;
    if (s.onlyLanes && [...laneSet].some((l) => !s.onlyLanes.includes(l))) continue;
    if (s.targets && !s.targets.some((t) => targetSet.has(t))) continue;
    if (s.paths && !paths.some((p) => matchAny(s.paths, p))) continue;
    const lane = s.lanes?.[0] ?? (s.targets ? policy.targets[s.targets[0]].lane : null);
    steps.push({ id, stage: s.stage, lane, text: s.text });
  }
  const rank = (s) => [policy.stages.indexOf(s.stage), s.lane ? LANE_ORDER.indexOf(s.lane) + 1 : 0, ids.indexOf(s.id)];
  return steps.sort((a, b) => {
    const [x, y] = [rank(a), rank(b)];
    return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
  });
}
