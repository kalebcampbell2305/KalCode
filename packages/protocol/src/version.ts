const VERSION_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+((?:0|[1-9]\d*)))?$/;

export const MAX_BUILD_REVISION = 65_535;

export interface KalCodeVersionParts {
  fullVersion: string;
  publicVersion: string;
  prerelease: string | null;
  buildRevision: number | null;
}

/**
 * Parses the exact version identity carried by the app and signed update feed. KalCode reserves
 * SemVer build metadata for one canonical positive numeric build revision so same-milestone builds
 * have one unambiguous cross-platform ordering.
 */
export function parseKalCodeVersion(value: string): KalCodeVersionParts | null {
  const match = VERSION_PATTERN.exec(value);
  if (!match) return null;

  const prerelease = match[4] ?? null;
  if (
    prerelease
      ?.split(".")
      .some((identifier) => /^\d+$/.test(identifier) && identifier.length > 1 && identifier[0] === "0")
  ) {
    return null;
  }

  const rawRevision = match[5];
  const buildRevision = rawRevision === undefined ? null : Number(rawRevision);
  if (
    buildRevision !== null &&
    (!Number.isSafeInteger(buildRevision) || buildRevision < 1 || buildRevision > MAX_BUILD_REVISION)
  ) {
    return null;
  }

  const publicVersion = `${match[1]}.${match[2]}.${match[3]}${prerelease === null ? "" : `-${prerelease}`}`;
  return { fullVersion: value, publicVersion, prerelease, buildRevision };
}

/** Formats build metadata as product language while keeping the public milestone unchanged. */
export function formatKalCodeVersion(value: string): string {
  const parsed = parseKalCodeVersion(value);
  if (!parsed) return value;
  return parsed.buildRevision === null ? parsed.publicVersion : `${parsed.publicVersion} build ${parsed.buildRevision}`;
}
