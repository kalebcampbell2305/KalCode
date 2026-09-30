// `ship.mjs classify`: which lanes a change needs and the lifecycle it must finish. Deterministic for a given
// (base, head): the result depends only on git objects and policy.json.

import { touchedPaths } from "./git.mjs";
import { changedImporters, LockfileError } from "./lockfile.mjs";
import { pipelineFor, ruleFor, sortLanes, sortTargets } from "./policy.mjs";

const WORKSPACE_MANIFESTS = ["apps", "packages", "tooling"];

/** Workspace graph at a ref: { importerPath: { name, deps: [workspace package names] } }. */
export function workspaceGraph(git, ref) {
  const graph = {};
  const files = git
    .lsTree(ref, WORKSPACE_MANIFESTS)
    .filter((p) => /^(apps|packages)\/[^/]+\/package\.json$/.test(p) || p === "tooling/package.json");
  for (const file of files) {
    let pkg;
    try {
      pkg = JSON.parse(git.show(ref, file) ?? "null");
    } catch {
      continue;
    }
    if (!pkg?.name) continue;
    const deps = Object.entries({ ...pkg.dependencies, ...pkg.devDependencies, ...pkg.optionalDependencies })
      .filter(([, spec]) => String(spec).startsWith("workspace:"))
      .map(([name]) => name);
    graph[file.slice(0, -"/package.json".length)] = { name: pkg.name, deps };
  }
  return graph;
}

/** Importer paths that (transitively) depend on the workspace package at `pkgPath`, itself excluded. */
export function dependentsOf(graphs, pkgPath) {
  const out = new Set();
  for (const graph of graphs) {
    const start = graph[pkgPath]?.name;
    if (!start) continue;
    const queue = [start];
    const seen = new Set(queue);
    while (queue.length) {
      const name = queue.shift();
      for (const [path, v] of Object.entries(graph))
        if (v.deps.includes(name) && !seen.has(v.name)) {
          seen.add(v.name);
          out.add(path);
          queue.push(v.name);
        }
    }
  }
  return [...out].sort();
}

/**
 * Lanes/targets of importer paths. Known app importers map through policy.importers; a workspace package
 * maps through the apps that depend on it (none -> internal, it ships nowhere); anything else -> fallback.
 */
function importerImpact(policy, graphs, importers) {
  const lanes = [];
  const targets = [];
  const notes = [];
  for (const imp of importers) {
    const known = policy.importers[imp];
    if (known) {
      lanes.push(...known.lanes);
      targets.push(...known.targets);
      notes.push(`${imp}`);
      continue;
    }
    if (/^packages\/[^/]+$/.test(imp) && graphs.some((g) => g[imp])) {
      const deps = dependentsOf(graphs, imp).filter((d) => policy.importers[d]);
      if (deps.length === 0) {
        lanes.push("internal");
        notes.push(`${imp} (no dependents)`);
      } else
        for (const d of deps) {
          lanes.push(...policy.importers[d].lanes);
          targets.push(...policy.importers[d].targets);
          notes.push(`${imp} -> ${d}`);
        }
      continue;
    }
    lanes.push(...policy.fallback.lanes);
    targets.push(...policy.fallback.targets);
    notes.push(`${imp} (unknown importer: conservative)`);
  }
  return { lanes, targets, notes };
}

/**
 * Classifies a list of changes ({status, path, oldPath?}). `refs` = { base, head } supplies file contents
 * for the resolvers; head === null means the working tree (read through git as far as committed state).
 */
export function classifyChanges(policy, git, changes, refs) {
  const lanes = [];
  const targets = [];
  const files = [];
  let graphs = null;
  const lazyGraphs = () => {
    graphs ??=
      refs.graphs ??
      [refs.headIsWorktree ? "HEAD" : refs.head, refs.base].filter(Boolean).map((r) => workspaceGraph(git, r));
    return graphs;
  };
  const add = (path, entry) => {
    lanes.push(...entry.lanes);
    targets.push(...(entry.targets ?? []));
    files.push({ path, lanes: sortLanes(entry.lanes), rule: entry.rule, why: entry.why });
  };
  for (const path of touchedPaths(changes)) {
    const rule = ruleFor(policy, path);
    if (!rule) {
      add(path, { ...policy.fallback, rule: "fallback" });
      continue;
    }
    if (!rule.resolve) {
      add(path, { lanes: rule.lanes, targets: rule.targets, rule: rule.id, why: rule.why });
      continue;
    }
    if (rule.resolve === "workspace-package") {
      const imp = path.split("/").slice(0, 2).join("/");
      const r = importerImpact(policy, lazyGraphs(), [imp]);
      add(path, { lanes: r.lanes, targets: r.targets, rule: rule.id, why: `${rule.why}: ${r.notes.join(", ")}` });
      continue;
    }
    // pnpm-lock
    try {
      const baseText = refs.base ? git.show(refs.base, path) : null;
      const headText = refs.headIsWorktree ? refs.readWorktree(path) : git.show(refs.head, path);
      const importers = changedImporters(baseText, headText);
      const r = importerImpact(policy, lazyGraphs(), importers);
      const lockLanes = r.lanes.length ? r.lanes : ["internal"];
      add(path, {
        lanes: lockLanes,
        targets: r.targets,
        rule: rule.id,
        why: importers.length ? `${rule.why}: ${r.notes.join(", ")}` : "lockfile change resolves no dependency",
      });
    } catch (e) {
      if (!(e instanceof LockfileError)) throw e;
      add(path, { ...policy.fallback, rule: rule.id, why: `${e.message}: conservative` });
    }
  }
  const finalLanes = sortLanes(lanes);
  const finalTargets = sortTargets(policy, targets);
  const paths = files.map((f) => f.path);
  return {
    lanes: finalLanes,
    targets: finalTargets,
    production: finalLanes.some((l) => policy.lanes[l].production),
    files,
    pipeline: finalLanes.length ? pipelineFor(policy, { lanes: finalLanes, targets: finalTargets, paths }) : [],
  };
}

/** Classifies base...head: the changes head introduces since it forked from base (merge-base semantics). */
export function classifyRange(policy, git, { base, head }) {
  const headSha = git.rev(head);
  const baseSha = git.rev(base);
  if (!headSha) throw new Error(`unknown --head ref ${head}`);
  if (!baseSha) throw new Error(`unknown --base ref ${base}`);
  const mb = git.mergeBase(baseSha, headSha) ?? baseSha;
  const changes = git.diff(mb, headSha);
  return {
    schema: "kalcode-lifecycle-classify/v1",
    base: { ref: base, commit: baseSha },
    head: { ref: head, commit: headSha },
    mergeBase: mb,
    ...classifyChanges(policy, git, changes, { base: mb, head: headSha }),
  };
}

export function renderClassify(r, { markdown = false } = {}) {
  const lines = [];
  const lanes = r.lanes.length ? r.lanes.join(", ") : "none (no changes)";
  if (markdown) {
    lines.push("## KalCode lifecycle for this change", "");
    lines.push(`**Lanes:** ${lanes}${r.targets.length ? ` (targets: ${r.targets.join(", ")})` : ""}`, "");
    lines.push(
      r.production
        ? "This change reaches production. Merging is not the end: the lifecycle below must finish, per AGENTS.md."
        : "Internal only: no customer release.",
      "",
    );
    if (r.pipeline.length) {
      lines.push("| # | Stage | Lane | Step |", "|---|---|---|---|");
      r.pipeline.forEach((s, i) => {
        lines.push(`| ${i + 1} | ${s.stage} | ${s.lane ?? "all"} | ${s.text.replaceAll("|", "\\|")} |`);
      });
      lines.push("");
    }
    lines.push("<details><summary>Files</summary>", "", "| File | Lanes | Rule |", "|---|---|---|");
    for (const f of r.files) lines.push(`| \`${f.path}\` | ${f.lanes.join(", ")} | ${f.rule} |`);
    lines.push("", "</details>");
    return lines.join("\n");
  }
  lines.push(`lanes: ${lanes}${r.targets.length ? `  (targets: ${r.targets.join(", ")})` : ""}`);
  lines.push(`base ${r.base.commit.slice(0, 12)} (${r.base.ref})  head ${r.head.commit.slice(0, 12)} (${r.head.ref})`);
  if (r.pipeline.length) {
    lines.push("", "required lifecycle:");
    r.pipeline.forEach((s, i) => {
      lines.push(`  ${String(i + 1).padStart(2)}. [${s.stage}${s.lane ? `/${s.lane}` : ""}] ${s.text}`);
    });
  }
  if (r.files.length) {
    lines.push("", "files:");
    for (const f of r.files) lines.push(`  ${f.lanes.join("+").padEnd(16)} ${f.path}  (${f.rule})`);
  }
  return lines.join("\n");
}
