// `ship.mjs lifecycle status`: for origin/main, which production targets have merged changes that are not in
// production yet. Production is observed only through public, read-only GETs (policy.production).
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { compareStableBuildVersions, releaseNotesRelativePath, validateStableBuildVersion } from "../version.mjs";
import { classifyChanges, workspaceGraph } from "./classify.mjs";
import { sortLanes } from "./policy.mjs";

export const STATUS_SCHEMA = "kalcode-lifecycle-status/v1";
const HEX40 = /^[0-9a-f]{40}$/;
export function compareVersions(a, b) {
  try {
    return compareStableBuildVersions(a, b);
  } catch {
    return null;
  }
}

function isStableBuildVersion(version) {
  try {
    validateStableBuildVersion(version);
    return true;
  } catch {
    return false;
  }
}

async function getJson(fetchImpl, url, timeoutMs) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const bust = `${url.includes("?") ? "&" : "?"}lifecycle=${Date.now()}`;
    const res = await fetchImpl(url + bust, {
      signal: ctl.signal,
      redirect: "follow",
      headers: { accept: "application/json", "user-agent": "kalcode-lifecycle-status" },
    });
    if (!res.ok) return { ok: false, status: res.status, error: `HTTP ${res.status}` };
    const text = await res.text();
    try {
      return { ok: true, status: res.status, json: JSON.parse(text) };
    } catch {
      return { ok: false, status: res.status, error: "response is not JSON" };
    }
  } catch (e) {
    return { ok: false, status: null, error: e?.name === "AbortError" ? `timeout after ${timeoutMs} ms` : e.message };
  } finally {
    clearTimeout(timer);
  }
}

/** Public production observations. Never throws: every failure becomes { ok: false, error }. */
export async function observeProduction(
  policy,
  { fetchImpl = globalThis.fetch, timeoutMs = 8000, now = Date.now } = {},
) {
  const p = policy.production;
  const [stamp, feed, catalog] = await Promise.all([
    getJson(fetchImpl, p.website.stampUrl, timeoutMs),
    getJson(fetchImpl, p.desktop.feedUrl, timeoutMs),
    getJson(fetchImpl, p.desktop.catalogUrl, timeoutMs),
  ]);
  const website = { url: p.website.stampUrl, ok: false, status: stamp.status };
  if (!stamp.ok) website.error = stamp.error;
  else if (!HEX40.test(stamp.json?.commit ?? "")) website.error = "build stamp has no valid commit";
  else
    Object.assign(website, {
      ok: true,
      commit: stamp.json.commit,
      builtAt: stamp.json.builtAt ?? null,
      dirty: stamp.json.dirty === true,
    });
  const desktopFeed = { url: p.desktop.feedUrl, ok: false, status: feed.status };
  if (!feed.ok) desktopFeed.error = feed.error;
  else if (!isStableBuildVersion(feed.json?.version)) desktopFeed.error = "feed has no valid stable build version";
  else
    Object.assign(desktopFeed, {
      ok: true,
      version: feed.json.version,
      commit: HEX40.test(feed.json?.kalcode?.commit ?? "") ? feed.json.kalcode.commit : null,
      channel: feed.json?.kalcode?.channel ?? p.desktop.channel,
    });
  const desktopCatalog = { url: p.desktop.catalogUrl, ok: false, status: catalog.status };
  if (!catalog.ok) desktopCatalog.error = catalog.error;
  else if (catalog.json?.latest === null) Object.assign(desktopCatalog, { ok: true, version: null });
  else if (!isStableBuildVersion(catalog.json?.latest?.version))
    desktopCatalog.error = "catalog has no valid stable build version";
  else
    Object.assign(desktopCatalog, {
      ok: true,
      version: catalog.json.latest.version,
      commit: HEX40.test(catalog.json.latest.commit ?? "") ? catalog.json.latest.commit : null,
      channel: catalog.json.latest.channel ?? null,
    });
  return {
    schema: "kalcode-lifecycle-observations/v1",
    checkedAt: new Date(now()).toISOString(),
    website,
    api: { ok: false, error: policy.production.api.note },
    desktop: { feed: desktopFeed, catalog: desktopCatalog },
  };
}

/** The published desktop release: the Stable feed when it serves one, else the public catalog. */
export function publishedDesktop(obs) {
  const { feed, catalog } = obs.desktop;
  if (feed.ok) return { version: feed.version, commit: feed.commit, channel: feed.channel, source: "stable feed" };
  if (catalog.ok && catalog.version)
    return {
      version: catalog.version,
      commit: catalog.commit,
      channel: catalog.channel,
      source: `catalog (${catalog.channel ?? "unknown"} channel; stable feed: ${feed.error})`,
    };
  if (catalog.ok) return { version: null, commit: null, channel: null, source: "catalog (nothing published)" };
  return null;
}

/**
 * Classifies (from, to]: the range result decides lane state; per-commit results list the commits.
 * `listCommits: false` skips the per-commit pass (the Stop hook only needs the state).
 */
function rangeImpact(policy, git, from, to, { listCommits = true, maxCommits = 400 } = {}) {
  const range = classifyChanges(policy, git, git.diff(from, to), { base: from, head: to });
  if (!listCommits) return { range, commits: [], total: null };
  const graphs = [workspaceGraph(git, to)];
  const commits = git.commits(from, to, { max: maxCommits }).map((c) => {
    const r = classifyChanges(policy, git, c.changes, { base: `${c.sha}^`, head: c.sha, graphs });
    const notes = r.files.filter((x) => x.rule === "release-notes").map((x) => x.path);
    return { sha: c.sha, subject: c.subject, targets: r.targets, lanes: r.lanes, notes };
  });
  return { range, commits, total: git.count(from, to) };
}

// Milestone notes and per-build evidence at or below the published build are already in production.
const RELEASE_NOTE = /^docs\/(?:releases|builds)\/(.+)\.md$/;
export function unpublishedNote(path, publishedVersion) {
  const m = RELEASE_NOTE.exec(path);
  if (!m || !publishedVersion) return true;
  const cmp = compareVersions(m[1], publishedVersion);
  return cmp === null || cmp > 0;
}

const pick = (impact, target) => ({
  commits: impact.commits.filter((c) => c.targets.includes(target)).map(({ sha, subject }) => ({ sha, subject })),
});

/**
 * Lifecycle status of `mainRef` against production observations. Pure apart from local git reads.
 * Target states: shipped | unshipped | unknown.
 */
export function computeStatus(policy, git, obs, { mainRef = "origin/main", listCommits = true } = {}) {
  const main = git.rev(mainRef);
  if (!main) throw new Error(`unknown ref ${mainRef} (run git fetch)`);
  const targets = {};
  const cache = new Map();
  const impactFrom = (from) => {
    if (!cache.has(from)) cache.set(from, rangeImpact(policy, git, from, main, { listCommits }));
    return cache.get(from);
  };
  const baselineOf = (commit) => {
    if (!commit || !git.rev(commit)) return { baseline: null };
    if (git.isAncestor(commit, main)) return { baseline: commit, onMain: true };
    return { baseline: git.mergeBase(commit, main), onMain: false };
  };

  // Website (kalcode-website): the deployed build stamp names its commit.
  const w = obs.website;
  if (!w.ok)
    targets.website = {
      lane: "website",
      state: "unknown",
      reason: `unknown deployed commit: ${w.url} ${w.error}. The build stamp ships with the next website deploy.`,
    };
  else {
    const { baseline, onMain } = baselineOf(w.commit);
    if (!baseline)
      targets.website = {
        lane: "website",
        state: "unknown",
        deployed: w,
        reason: `deployed commit ${w.commit.slice(0, 12)} is not in local history (git fetch)`,
      };
    else {
      const impact = impactFrom(baseline);
      const changed = impact.range.targets.includes("website");
      targets.website = {
        lane: "website",
        state: changed ? "unshipped" : "shipped",
        deployed: { commit: w.commit, builtAt: w.builtAt, dirty: w.dirty, onMain },
        reason: changed
          ? `main has website changes since the deployed build ${w.commit.slice(0, 12)}${onMain ? "" : " (deployed from a non-main commit)"}`
          : `deployed build ${w.commit.slice(0, 12)} includes every website change on main`,
        ...pick(impact, "website"),
      };
    }
  }

  // API (kalcode-api): no build stamp yet.
  targets.api = { lane: "website", state: "unknown", reason: `unknown deployed commit: ${obs.api.error}` };

  // Desktop: main's declared version against the public Stable feed / catalog.
  let mainVersion = null;
  try {
    mainVersion = JSON.parse(git.show(main, policy.production.desktop.versionFile) ?? "null")?.version ?? null;
  } catch {
    mainVersion = null;
  }
  const pub = publishedDesktop(obs);
  if (!pub || !mainVersion)
    targets.desktop = {
      lane: "desktop",
      state: "unknown",
      mainVersion,
      reason: !mainVersion
        ? `no version in ${policy.production.desktop.versionFile} on main`
        : `production feed unreachable: ${obs.desktop.feed.error}; catalog: ${obs.desktop.catalog.error}`,
    };
  else {
    const cmp = pub.version ? compareVersions(mainVersion, pub.version) : 1;
    const { baseline } = baselineOf(pub.commit);
    const impact = baseline ? impactFrom(baseline) : null;
    const base = { lane: "desktop", mainVersion, published: pub };
    if (cmp === null) targets.desktop = { ...base, state: "unknown", reason: "unparseable version" };
    else if (cmp > 0)
      targets.desktop = {
        ...base,
        state: "unshipped",
        reason: `main declares ${mainVersion}; production has ${pub.version ?? "nothing"} (${pub.source})`,
        ...(impact ? pick(impact, "desktop") : { commits: [] }),
      };
    else if (cmp < 0)
      targets.desktop = {
        ...base,
        state: "shipped",
        reason: `production ${pub.version} is ahead of main ${mainVersion}`,
      };
    else if (impact?.range.targets.includes("desktop"))
      targets.desktop = {
        ...base,
        state: "unshipped",
        reason: `desktop changes merged after published build ${pub.version} need the next internal revision and release`,
        ...pick(impact, "desktop"),
      };
    else
      targets.desktop = {
        ...base,
        state: "shipped",
        reason: impact
          ? `published ${pub.version} includes every desktop change on main`
          : `main and production both declare ${pub.version} (published commit unknown locally)`,
      };
    // Release notes publish with the desktop release.
    const notesChanged =
      impact?.range.files.some((x) => x.rule === "release-notes" && unpublishedNote(x.path, pub.version)) ?? false;
    const noteCommits = () => ({
      commits: impact.commits
        .filter((c) => c.notes.some((p) => unpublishedNote(p, pub.version)))
        .map(({ sha, subject }) => ({ sha, subject })),
    });
    const notesPath = releaseNotesRelativePath(mainVersion);
    targets["release-notes"] = {
      lane: "docs",
      state: cmp > 0 ? "unshipped" : notesChanged ? "unshipped" : "shipped",
      reason:
        cmp > 0
          ? git.show(main, notesPath) !== null
            ? `${notesPath} publishes with desktop ${mainVersion}`
            : `${notesPath} is not on main yet; it must exist before desktop ${mainVersion} publishes`
          : notesChanged
            ? "release/build notes changed after the published build; they ship with the next desktop build"
            : "no unpublished release/build-notes changes",
      ...(impact && cmp > 0 ? pick(impact, "release-notes") : impact && notesChanged ? noteCommits() : {}),
    };
  }
  if (!targets["release-notes"])
    targets["release-notes"] = { lane: "docs", state: "unknown", reason: "follows the desktop release" };

  const unshipped = Object.entries(targets).filter(([, t]) => t.state === "unshipped");
  const totalFrom = [...cache.values()].map((i) => i.total).filter((n) => n !== null);
  return {
    schema: STATUS_SCHEMA,
    checkedAt: obs.checkedAt,
    main: { ref: mainRef, commit: main },
    targets,
    unshippedTargets: unshipped.map(([k]) => k),
    unshippedLanes: sortLanes(unshipped.map(([, t]) => t.lane)),
    unknownTargets: Object.entries(targets)
      .filter(([, t]) => t.state === "unknown")
      .map(([k]) => k),
    commitsScanned: totalFrom.length ? Math.max(...totalFrom) : null,
  };
}

const MAX_LISTED = 25;
export function renderStatus(s, { markdown = false } = {}) {
  const out = [];
  if (markdown) {
    out.push("<!-- kalcode-lifecycle-status -->");
    out.push(
      `Lifecycle status of \`${s.main.ref}\` at \`${s.main.commit.slice(0, 12)}\`, checked ${s.checkedAt} by \`node tooling/release/ship.mjs lifecycle status\`.`,
      "",
    );
    out.push(
      s.unshippedLanes.length
        ? `**Unshipped production lanes: ${s.unshippedLanes.join(", ")}.** Per AGENTS.md these changes are merged but not done until they are deployed/published and verified in production.`
        : "Every observable production lane is up to date with main.",
      "",
    );
    out.push("| Target | Lane | State | Detail |", "|---|---|---|---|");
    for (const [k, t] of Object.entries(s.targets))
      out.push(`| ${k} | ${t.lane} | ${t.state} | ${t.reason.replaceAll("|", "\\|")} |`);
    for (const [k, t] of Object.entries(s.targets)) {
      if (t.state !== "unshipped" || !t.commits?.length) continue;
      out.push("", `### ${k}: ${t.commits.length} unshipped commit(s)`, "");
      for (const c of t.commits.slice(-MAX_LISTED).reverse())
        out.push(`- \`${c.sha.slice(0, 12)}\` ${c.subject.replaceAll("<", "&lt;")}`);
      if (t.commits.length > MAX_LISTED) out.push(`- ... and ${t.commits.length - MAX_LISTED} older`);
    }
    return out.join("\n");
  }
  out.push(`${s.main.ref} ${s.main.commit.slice(0, 12)}  (production checked ${s.checkedAt})`);
  for (const [k, t] of Object.entries(s.targets)) {
    out.push(`  ${t.state.padEnd(9)} ${k.padEnd(14)} ${t.reason}`);
    if (t.state === "unshipped" && t.commits?.length) {
      for (const c of t.commits.slice(-10).reverse()) out.push(`              ${c.sha.slice(0, 12)} ${c.subject}`);
      if (t.commits.length > 10) out.push(`              ... ${t.commits.length - 10} more`);
    }
  }
  out.push(
    s.unshippedLanes.length
      ? `unshipped production lanes: ${s.unshippedLanes.join(", ")}`
      : "no unshipped production lanes observed",
  );
  return out.join("\n");
}

// ------------------------------------------------------------------ local cache (<git common dir>/kalcode-lifecycle)

export const stateDir = (commonDir) => join(commonDir, "kalcode-lifecycle");

export function readJsonFile(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

export function writeJsonAtomic(path, value) {
  mkdirSync(join(path, ".."), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(tmp, path);
}
