// Release identity, validation and template resolution for the release orchestrator (ship.mjs).
// Pure functions only: no file system, no process, no network.

export class ShipError extends Error {
  constructor(message) {
    super(message);
    this.name = "ShipError";
  }
}

export function refuse(message) {
  throw new ShipError(`REFUSED: ${message}`);
}

export const PLAIN_SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
/** A Stable release version: plain x.y.z, optionally with an internal build number (x.y.z+N). */
export const STABLE_RELEASE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\+([1-9]\d*))?$/;
export const COMMIT40 = /^[0-9a-f]{40}$/;
export const CHANNELS = Object.freeze(["stable"]);

/** Orders x.y.z[+N] versions; a missing build number is build 0. */
export function compareSemver(a, b) {
  const parts = (version) => {
    const [core, build = "0"] = version.split("+");
    return [...core.split(".").map(Number), Number(build)];
  };
  const pa = parts(a);
  const pb = parts(b);
  for (let i = 0; i < 4; i++) {
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  }
  return 0;
}

// The only inputs a release needs from a person. Everything else is derived or read from receipts.
export function validateIdentity({ version, commit, baselineVersion = null, channel = "stable" } = {}) {
  if (typeof version !== "string" || !STABLE_RELEASE_VERSION.test(version)) {
    refuse(
      `--version must be a plain x.y.z version or an x.y.z+N build (Stable refuses prereleases and other build metadata), got ${JSON.stringify(version ?? null)}`,
    );
  }
  if (typeof commit !== "string" || !COMMIT40.test(commit)) {
    refuse(`--commit must be the full 40-hex lowercase commit id, got ${JSON.stringify(commit ?? null)}`);
  }
  if (baselineVersion !== null && baselineVersion !== undefined) {
    if (typeof baselineVersion !== "string" || !STABLE_RELEASE_VERSION.test(baselineVersion)) {
      refuse(
        `--baseline-version must be a plain x.y.z version or an x.y.z+N build, got ${JSON.stringify(baselineVersion)}`,
      );
    }
    if (compareSemver(baselineVersion, version) >= 0) {
      refuse(
        `--baseline-version ${baselineVersion} must be lower than --version ${version} (the updater only moves forward)`,
      );
    }
  }
  if (!CHANNELS.includes(channel)) refuse(`--channel must be one of ${CHANNELS.join(", ")}`);
  return Object.freeze({ version, commit, baselineVersion: baselineVersion ?? null, channel });
}

export function identityVars(identity) {
  return {
    version: identity.version,
    versionDashed: identity.version.replaceAll(".", "-"),
    // Artifact file names cannot contain "+": "0.1.7+779" is named "0.1.7_build779".
    fileVersion: identity.version.replace(/\+(\d+)$/, "_build$1"),
    commit: identity.commit,
    commit7: identity.commit.slice(0, 7),
    commit12: identity.commit.slice(0, 12),
    baselineVersion: identity.baselineVersion ?? undefined,
    channel: identity.channel,
  };
}

const REF = /\{([A-Za-z][A-Za-z0-9_.-]*)\}/g; // a name starts with a letter, so regex quantifiers like {40} stay literal
// "{{" and "}}" are literal braces (e.g. git's rev^{{commit}}).
const OPEN = "\u0000<";
const CLOSE = "\u0000>";
const escapeBraces = (s) => s.replaceAll("{{", OPEN).replaceAll("}}", CLOSE);
const unescapeBraces = (s) => s.replaceAll(OPEN, "{").replaceAll(CLOSE, "}");
const PLACEHOLDER = /PLACEHOLDER/;

export function lookup(vars, name) {
  let cur = vars;
  // Dots separate path segments ("out.build-windows.candidateBuild.sha256"); segment names never contain dots.
  for (const part of name.split(".")) {
    if (cur === null || cur === undefined || typeof cur !== "object" || !Object.hasOwn(cur, part)) return undefined;
    cur = cur[part];
  }
  return cur;
}

// Resolves {name} references. Strict mode refuses an unresolved reference, an object-valued reference and any
// result that still carries a PLACEHOLDER token. Lenient mode (plans) renders missing references as <name>.
export function resolveString(template, vars, { lenient = false } = {}) {
  if (typeof template !== "string") refuse(`template must be a string, got ${typeof template}`);
  const missing = [];
  const value = escapeBraces(template).replace(REF, (_, name) => {
    const v = lookup(vars, name);
    if (v === undefined || v === null || (typeof v === "object" && !Array.isArray(v))) {
      missing.push(name);
      return `<${name}>`;
    }
    if (Array.isArray(v)) {
      missing.push(name);
      return `<${name}>`;
    }
    return String(v);
  });
  const out = unescapeBraces(value);
  if (!lenient) {
    if (missing.length)
      refuse(`unresolved reference(s) ${missing.map((m) => `{${m}}`).join(", ")} in ${JSON.stringify(template)}`);
    if (PLACEHOLDER.test(out)) refuse(`resolved value still carries a PLACEHOLDER token: ${JSON.stringify(out)}`);
  }
  return { value: out, missing };
}

export function resolveDeep(value, vars, options = {}) {
  const missing = [];
  const walk = (v) => {
    if (typeof v === "string") {
      const r = resolveString(v, vars, options);
      missing.push(...r.missing);
      return r.value;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return { value: walk(value), missing: [...new Set(missing)] };
}

export function references(value) {
  const found = new Set();
  const walk = (v) => {
    if (typeof v === "string") for (const m of escapeBraces(v).matchAll(REF)) found.add(m[1]);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk(value);
  return [...found];
}

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
