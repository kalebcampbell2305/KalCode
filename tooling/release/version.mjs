// Stable customer builds keep the owner-declared public version and add an optional numeric
// revision. The revision is bounded by the fourth Windows file-version component.

export const MAX_NATIVE_BUILD_REVISION = 65_535;

const STABLE_BUILD_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\+([1-9]\d*))?$/;

export function validateStableBuildVersion(version) {
  const match = typeof version === "string" ? STABLE_BUILD_VERSION.exec(version) : null;
  if (!match) {
    throw new Error(
      `stable build version must be x.y.z or x.y.z+N with a positive numeric revision no greater than ${MAX_NATIVE_BUILD_REVISION}`,
    );
  }
  const revision = match[4] === undefined ? null : Number(match[4]);
  if (revision !== null && (!Number.isSafeInteger(revision) || revision > MAX_NATIVE_BUILD_REVISION)) {
    throw new Error(
      `stable build version must be x.y.z or x.y.z+N with a positive numeric revision no greater than ${MAX_NATIVE_BUILD_REVISION}`,
    );
  }
  return {
    version,
    publicVersion: `${match[1]}.${match[2]}.${match[3]}`,
    revision,
  };
}

export function publicVersion(version) {
  return validateStableBuildVersion(version).publicVersion;
}

export function buildRevision(version) {
  return validateStableBuildVersion(version).revision;
}

export function windowsNativeFileVersion(version) {
  const identity = validateStableBuildVersion(version);
  return `${identity.publicVersion}.${identity.revision ?? 0}`;
}

export function compareStableBuildVersions(left, right) {
  const a = validateStableBuildVersion(left);
  const b = validateStableBuildVersion(right);
  const aBase = a.publicVersion.split(".").map(BigInt);
  const bBase = b.publicVersion.split(".").map(BigInt);
  for (let index = 0; index < aBase.length; index += 1) {
    if (aBase[index] !== bBase[index]) return aBase[index] < bBase[index] ? -1 : 1;
  }
  const aRevision = a.revision ?? 0;
  const bRevision = b.revision ?? 0;
  return aRevision === bRevision ? 0 : aRevision < bRevision ? -1 : 1;
}

export function releaseNotesRelativePath(version) {
  const identity = validateStableBuildVersion(version);
  return identity.revision === null ? `docs/releases/${version}.md` : `docs/builds/${version}.md`;
}
